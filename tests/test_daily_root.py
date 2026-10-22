"""每日目录测试：只使用手写数据和现有 SPEC 假数据。"""
import csv
import os
from datetime import date, timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import audit
from daily_root import OUTPUT_NAMES


class TestDailyRoot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.daily = self.base / "daily"
        self.daily.mkdir()

    def row(self, **changes):
        row = dict(id="tw:9100001", tweet_id="9100001", ts="2026-10-01T12:00:00Z",
                   account="user_201", direction="in", type="reply", text="测试实质回复",
                   in_reply_to_status_id="", conversation_id="", parent_kind="")
        row.update(changes)
        return row

    def write(self, path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        columns = list(dict.fromkeys(k for row in rows for k in row))
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)

    def day(self, day, rows, private=True):
        path = self.daily / day
        if private:
            path /= "private"
        self.write(path / "interactions.csv", rows)

    def cli(self, *args, ok=True, env=None):
        environment = dict(os.environ)
        environment.pop("FAN_AUDIT_DATA_ROOT", None)
        environment.update(env or {})
        result = subprocess.run([sys.executable, str(ROOT / "audit.py"), *map(str, args)],
                                cwd=str(ROOT), env=environment, capture_output=True, text=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_latest_day_and_fallback_keys(self):
        old = [self.row(), self.row(id="", tweet_id="9100002"),
               self.row(id="", tweet_id="", type="like", post_id="9100009", ts="")]
        new = [dict(r, text="较新版本", conversation_id="9100000") for r in old]
        self.day("2026-10-01", old)
        self.day("2026-10-03", new)
        data = audit.load_daily_root(self.daily)
        self.assertEqual(len(data["rows"]), 3)
        self.assertTrue(all(r["text"] == "较新版本" for r in data["rows"]))
        self.assertTrue(all(r["id"] for r in data["rows"]))
        self.assertEqual(data["coverage"]["before"], 6)
        self.assertEqual(data["coverage"]["after"], 3)

    def test_ignore_non_dates_and_fallback_without_private(self):
        self.day("2026-10-01", [self.row()], private=False)
        for day in ("notes", "bad-name", "_分析结果", "2026-02-30", "2026-1-1"):
            path = self.daily / day / "private"
            path.mkdir(parents=True)
            (path / "interactions.csv").write_text("invalid", encoding="utf-8")
        # 有 private/ 时不擅自读取日期根目录的回退文件。
        self.day("2026-10-02", [self.row(tweet_id="9100008")], private=False)
        (self.daily / "2026-10-02" / "private").mkdir()
        data = audit.load_daily_root(self.daily)
        self.assertEqual(len(data["rows"]), 1)
        self.assertEqual(data["coverage"]["read_days"], ["2026-10-01"])

    def test_same_as_single_file(self):
        subprocess.run([sys.executable, str(ROOT / "tests/make_fake_daily_root.py"),
                        "--src", str(ROOT / "examples/relationship/interactions.csv"),
                        "--out", str(self.daily)], check=True, capture_output=True)
        single, merged = self.base / "single", self.base / "merged"
        self.cli("--data", ROOT / "examples/relationship", "--out", single)
        self.cli("--data-root", self.daily, "--out", merged)
        self.assertEqual((single / "accounts.csv").read_bytes(), (merged / "accounts.csv").read_bytes())
        with (merged / "accounts.csv").open(encoding="utf-8-sig") as f:
            rows = {r["account"]: r for r in csv.DictReader(f)}
        self.assertEqual(rows["user_103"]["score"], "97.8")
        self.assertEqual(rows["user_107"]["score"], "42.4")

    def test_window_all_days_missing_days_and_private_list(self):
        self.day("2026-09-01", [self.row(ts="2026-09-01T12:00:00Z")])
        self.day("2026-10-03", [self.row(id="tw:9100002", tweet_id="9100002",
                                      ts="2026-10-03T12:00:00Z")])
        recent = self.cli("--data-root", self.daily, "--days", "30", "--out", self.base / "recent")
        full = self.cli("--data-root", self.daily, "--all-days", "--out", self.base / "full")
        self.assertIn("2026-09-04 ~ 2026-10-03", recent.stdout)
        self.assertIn("2026-09-01 ~ 2026-10-03", full.stdout)
        self.assertIn("2026-10-02", full.stdout)
        self.assertNotIn("user_201", full.stdout + full.stderr)
        report = (self.base / "full/名单.md").read_text()
        self.assertIn("需要 following.csv 和 followers.csv，暂时算不出来", report)
        self.assertIn("待核实", report)

    def test_lists_are_only_following_and_followers(self):
        self.day("2026-10-01", [self.row()])
        lists = self.base / "lists"
        for name in ("following.csv", "followers.csv"):
            self.write(lists / name, [dict(handle="user_202")])
        for name in ("replies.csv", "interactions.csv", "profiles.csv", "likes.csv"):
            (lists / name).write_text("不可读取的无效数据", encoding="utf-8")
        out = self.base / "out"
        result = self.cli("--data-root", self.daily, "--lists", lists, "--out", out)
        with (out / "accounts.csv").open(encoding="utf-8-sig") as f:
            rows = {r["account"]: r for r in csv.DictReader(f)}
        self.assertEqual(rows["user_202"]["tier"], "沉睡互关")
        self.assertIn("关系表导出日期与每日数据日期是否一致：待核实", result.stdout)
        self.assertIn("user_202", (out / "名单.md").read_text())
        self.assertNotIn("user_202", result.stdout)

    def test_default_output_and_environment(self):
        self.day("2026-10-01", [self.row()])
        self.cli(env={"FAN_AUDIT_DATA_ROOT": str(self.daily)})
        self.assertTrue((self.daily / "_分析结果/2026-10-01/名单.md").is_file())
        # 显式 --data 仍保持旧用法，不受环境变量干扰。
        out = self.base / "legacy"
        result = self.cli("--data", ROOT / "sample_data", "--out", out,
                          env={"FAN_AUDIT_DATA_ROOT": str(self.daily)})
        self.assertIn("20 个账号", result.stdout)

    def test_reject_repo_paths_and_symlinks_before_reading(self):
        for target in (ROOT, ROOT / "output_t02_forbidden"):
            result = self.cli("--data-root", self.daily, "--out", target, ok=False)
            self.assertIn("输出不能在仓库内", result.stderr)
        self.assertFalse((ROOT / "output_t02_forbidden").exists())
        link = self.base / "link"
        link.symlink_to(ROOT, target_is_directory=True)
        result = self.cli("--data-root", self.daily, "--out", link / "output_t02_forbidden", ok=False)
        self.assertIn("输出不能在仓库内", result.stderr)

    def test_reject_private_symlink_and_existing_output_symlink(self):
        actual = self.base / "original_private"
        self.write(actual / "interactions.csv", [self.row()])
        day = self.daily / "2026-10-01"
        day.mkdir()
        (day / "private").symlink_to(actual, target_is_directory=True)
        result = self.cli("--data-root", self.daily, "--out", actual / "analysis", ok=False)
        self.assertIn("输出不能写入日期输入目录", result.stderr)
        self.assertFalse((actual / "analysis").exists())
        out = self.base / "out"
        out.mkdir()
        (out / "accounts.csv").symlink_to(actual / "interactions.csv")
        result = self.cli("--data-root", self.daily, "--out", out, ok=False)
        self.assertIn("目标输出文件已存在", result.stderr)

    def test_refuse_overwrite_and_input_directory(self):
        self.day("2026-10-01", [self.row()])
        output = self.base / "output"
        output.mkdir()
        original = b"keep existing file"
        (output / "accounts.csv").write_bytes(original)
        self.cli("--data-root", self.daily, "--out", output, ok=False)
        self.assertEqual((output / "accounts.csv").read_bytes(), original)
        self.cli("--data-root", self.daily, "--out", self.daily / "2026-10-01/private", ok=False)
        self.assertFalse((self.daily / "2026-10-01/private/accounts.csv").exists())

    def test_overwrite_replaces_only_own_files(self):
        self.day("2026-10-01", [self.row()])
        output = self.base / "output"
        output.mkdir()
        for name in OUTPUT_NAMES:
            (output / name).write_text("old-result", encoding="utf-8")
        self.cli("--data-root", self.daily, "--out", output, "--overwrite")
        names = sorted(path.name for path in output.iterdir())
        self.assertEqual(names, sorted(OUTPUT_NAMES))
        dashboard = (output / "dashboard.html").read_text(encoding="utf-8")
        self.assertIn("粉丝体检", dashboard)
        self.assertNotIn("old-result", dashboard)
        self.assertIn("user_201", (output / "accounts.csv").read_text(encoding="utf-8-sig"))
        missing_lists = (output / "没回关.md").read_text(encoding="utf-8")
        self.assertIn("先不算", missing_lists)
        self.assertNotIn("user_201", missing_lists)
        self.assertNotIn("old-result", missing_lists)

    def test_overwrite_stops_when_directory_has_other_files(self):
        self.day("2026-10-01", [self.row()])
        output = self.base / "output"
        output.mkdir()
        (output / "accounts.csv").write_text("old-result", encoding="utf-8")
        (output / "notes.txt").write_text("keep-me", encoding="utf-8")
        (output / "extra").mkdir()
        result = self.cli("--data-root", self.daily, "--out", output, "--overwrite", ok=False)
        self.assertIn("不是本工具生成的文件", result.stderr)
        self.assertEqual((output / "accounts.csv").read_text(encoding="utf-8"), "old-result")
        self.assertEqual((output / "notes.txt").read_text(encoding="utf-8"), "keep-me")
        self.assertTrue((output / "extra").is_dir())
        self.assertFalse((output / "dashboard.html").exists())

    def test_overwrite_does_not_remove_symlink_or_write_into_inputs(self):
        self.day("2026-10-01", [self.row()])
        secret = self.base / "secret.csv"
        secret.write_bytes(b"do-not-delete")
        output = self.base / "output"
        output.mkdir()
        (output / "accounts.csv").symlink_to(secret)
        result = self.cli("--data-root", self.daily, "--out", output, "--overwrite", ok=False)
        self.assertIn("不是本工具生成的文件", result.stderr)
        self.assertTrue((output / "accounts.csv").is_symlink())
        self.assertEqual(secret.read_bytes(), b"do-not-delete")
        private = self.daily / "2026-10-01" / "private"
        original = (private / "interactions.csv").read_bytes()
        blocked = self.cli("--data-root", self.daily, "--out", private, "--overwrite", ok=False)
        self.assertIn("输出不能写入日期输入目录", blocked.stderr)
        self.assertEqual((private / "interactions.csv").read_bytes(), original)
        self.assertFalse((private / "dashboard.html").exists())
        inside = self.cli("--data-root", self.daily, "--out", ROOT, "--overwrite", ok=False)
        self.assertIn("输出不能在仓库内", inside.stderr)

    def test_unknown_conversation_does_not_create_reply_links(self):
        rows = [self.row(conversation_id="待核实"),
                self.row(id="tw:9100002", tweet_id="9100002", direction="out",
                         ts="2026-10-02T12:00:00Z", in_reply_to_status_id="9100001"),
                self.row(id="tw:9100003", tweet_id="9100003",
                         ts="2026-10-03T12:00:00Z", in_reply_to_status_id="9100099")]
        self.day("2026-10-03", rows)
        data = audit.load_daily_root(self.daily)
        self.assertTrue(all(not r["conversation_id"] for r in data["rows"]))
        conf, cfg = audit.rs.load_config()
        result, _ = audit.analyze(data, conf, cfg)
        self.assertEqual(result[0]["rounds"], 1)
        self.assertEqual(result[0]["T"], 3)

    def test_all_days_uses_local_dates_and_like_times(self):
        self.day("2026-10-03", [self.row(ts="2026-10-01T01:00:00Z"),
                               self.row(id="like:1", tweet_id="", type="like", ts="", post_id="9100005",
                                        post_created_at="2026-10-02T12:00:00Z",
                                        first_observed_at="2026-10-03T12:00:00Z")])
        result = self.cli("--data-root", self.daily, "--all-days", "--out", self.base / "out")
        self.assertIn("2026-09-30 ~ 2026-10-03", result.stdout)

    def test_uncovered_days_do_not_count_as_inactivity(self):
        rows = []
        for day, n in (("2026-10-18", "1"), ("2026-10-19", "2")):
            rows.append(self.row(id="tw:91000%s1" % n, tweet_id="91000%s1" % n, ts=day + "T20:00:00Z",
                                 direction="out", text="这个口径和上次不一样"))
            rows.append(self.row(id="tw:91000%s2" % n, tweet_id="91000%s2" % n, ts=day + "T21:00:00Z",
                                 direction="in", in_reply_to_status_id="91000%s1" % n,
                                 text="我按公开回复重新对过"))
        self.day("2026-10-19", rows)
        recent = self.cli("--data-root", self.daily, "--days", "30", "--end", "2026-10-19",
                          "--out", self.base / "recent")
        full = self.cli("--data-root", self.daily, "--all-days", "--out", self.base / "full")
        self.assertIn("有数据的日期（覆盖 2 天）：2026-10-18、2026-10-19", recent.stdout)
        self.assertIn("无数据不是零互动，不进入持续性分母", recent.stdout)
        self.assertIn("2026-10-17", recent.stdout)
        self.assertNotIn("user_201", recent.stdout + recent.stderr)
        self.assertIn("无数据不是零互动", (self.base / "recent/名单.md").read_text())
        with (self.base / "recent/accounts.csv").open(encoding="utf-8-sig") as f:
            month = {r["account"]: r for r in csv.DictReader(f)}
        with (self.base / "full/accounts.csv").open(encoding="utf-8-sig") as f:
            entire = {r["account"]: r for r in csv.DictReader(f)}
        self.assertEqual(month["user_201"]["score"], entire["user_201"]["score"])
        self.assertEqual(month["user_201"]["tier"], entire["user_201"]["tier"])
        self.assertGreater(float(month["user_201"]["P"]), 0.9)

    def test_collected_day_without_this_person_still_counts(self):
        for offset, day in enumerate(("2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
                                      "2026-10-16", "2026-10-17")):
            self.day(day, [self.row(id="tw:920000%s" % offset, tweet_id="920000%s" % offset,
                                   ts=day + "T20:00:00Z", account="user_202", text="今天换了个统计口径")])
        own = []
        for day, n in (("2026-10-18", "8"), ("2026-10-19", "9")):
            own.append(self.row(id="tw:91000%s1" % n, tweet_id="91000%s1" % n, ts=day + "T20:00:00Z",
                                direction="out", text="这个口径和上次不一样"))
            own.append(self.row(id="tw:91000%s2" % n, tweet_id="91000%s2" % n, ts=day + "T21:00:00Z",
                                direction="in", in_reply_to_status_id="91000%s1" % n,
                                text="我按公开回复重新对过"))
        self.day("2026-10-19", own)
        result = self.cli("--data-root", self.daily, "--days", "30", "--end", "2026-10-19",
                          "--out", self.base / "out")
        self.assertIn("覆盖 8 天", result.stdout)
        self.assertNotIn("user_201", result.stdout + result.stderr)
        with (self.base / "out/accounts.csv").open(encoding="utf-8-sig") as f:
            rows = {r["account"]: r for r in csv.DictReader(f)}
        self.assertGreater(float(rows["user_201"]["P"]), 0.5)
        self.assertLess(float(rows["user_201"]["P"]), 1.0)

    def test_full_coverage_uses_the_same_denominator(self):
        start, end = date(2026, 9, 20), date(2026, 10, 19)
        every = {start + timedelta(days=i) for i in range((end - start).days + 1)}
        self.assertEqual(audit.rs.window_scale(start, end, None)[0], 30)
        self.assertEqual(audit.rs.window_scale(start, end, every)[:1], (30,))
        partial = {date(2026, 10, 18), date(2026, 10, 19)}
        length, week_of, weeks = audit.rs.window_scale(start, end, partial)
        self.assertEqual((length, weeks), (2, 1))
        self.assertEqual(week_of(date(2026, 10, 18)), week_of(date(2026, 10, 19)))

    def test_empty_root_bad_timestamp_and_conflicting_flags(self):
        self.cli("--data-root", self.daily, "--out", self.base / "empty", ok=False)
        self.day("2026-10-01", [self.row(ts="user_201")])
        bad = self.cli("--data-root", self.daily, "--out", self.base / "bad", ok=False)
        self.assertNotIn("user_201", bad.stdout + bad.stderr)
        self.assertFalse((self.base / "bad").exists())
        self.cli("--data-root", self.daily, "--all-days", "--days", "30", ok=False)
        self.cli("--data-root", self.daily, "--days", "0", ok=False)


if __name__ == "__main__":
    unittest.main()
