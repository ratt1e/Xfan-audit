"""命令行看板里的日期筛选：默认区间和 Python 一致，打码版不带可识别身份。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import audit  # noqa: E402
import not_followed_back as nfb  # noqa: E402

SAMPLE = ROOT / "sample_data"
KEYS = ["account", "tier", "status", "score", "stars", "O", "I", "O_raw", "I_raw", "rounds",
        "sub_days", "P", "B", "R", "action", "priority", "mutual", "verified", "raw", "L_in", "L_out"]


def find_node():
    found = shutil.which("node")
    if found:
        return found
    bundled = Path("/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node")
    if bundled.is_file():
        return str(bundled)
    return ""


def same(got, exp):
    if isinstance(exp, float) or isinstance(got, float):
        if got is None or exp is None:
            return got is exp
        return abs(float(got) - float(exp)) < 1e-9
    return got == exp


def run_view(page, extra=None):
    node = find_node()
    if not node:
        raise AssertionError("找不到 node，无法核对看板里的脚本")
    cmd = [node, str(ROOT / "tests/web_score_runner.mjs"), "dashboard", str(page)]
    if extra is not None:
        cmd.append(json.dumps(extra))
    out = subprocess.check_output(cmd, cwd=str(ROOT))
    return json.loads(out)


class TestDashboardRange(unittest.TestCase):
    def assert_rows(self, got_rows, expected, accounts=True):
        self.assertEqual(len(got_rows), len(expected))
        for got, exp in zip(got_rows, expected):
            for key in KEYS:
                if not accounts and key == "account":
                    continue
                self.assertTrue(
                    same(got[key], exp.get(key)),
                    "%s %s: 看板 %r，Python %r" % (exp.get("account"), key, got[key], exp.get(key)),
                )

    def test_default_view_matches_python_and_public_is_masked(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        audit.main(["--data", str(SAMPLE), "--prev-lists", str(SAMPLE / "prev"), "--out", out.name])
        conf, cfg = audit.rs.load_config()
        data = audit.load_inputs(str(SAMPLE))
        expected, meta = audit.analyze(data, conf, cfg, None, None, False)
        private = Path(out.name, "dashboard.html")
        public = Path(out.name, "dashboard_public.html")
        page = private.read_text(encoding="utf-8")
        masked = public.read_text(encoding="utf-8")
        self.assertIn('value="%s"' % meta["start"], page)
        self.assertIn('value="%s"' % meta["end"], page)
        self.assertIn("最近 7 天", page)
        self.assertIn("全部", page)
        self.assertNotIn("https://", Path(ROOT, "web/index.html").read_text(encoding="utf-8"))
        for banned in ("user_", "https", "x.com", 'target="_blank"'):
            self.assertNotIn(banned, masked)
        view = run_view(private)
        self.assertEqual(view["meta"]["start"], meta["start"])
        self.assertEqual(view["meta"]["end"], meta["end"])
        self.assertEqual(view["meta"]["days"], meta["days"])
        self.assertEqual(view["meta"]["covered"], len(meta["covered_days"]))
        self.assertEqual(view["meta"]["uncovered"], len(meta["uncovered_days"]))
        self.assert_rows(view["rows"], expected)
        self.assertIn("金牌（3）", view["html"])
        self.assertIn('href="https://x.com/user_01"', view["html"])
        self.assertEqual(view["back"]["ready"], True)
        info = nfb.build(str(SAMPLE), expected, None)
        self.assertEqual(
            [(item["handle"], item["interactions"], item["score"], item["tier"]) for item in view["back"]["items"]],
            [(item["handle"], item["interactions"], item["score"], item["tier"]) for item in info["items"]],
        )
        self.assertEqual(view["diff"]["unfollowed_me"], 2)
        self.assertEqual(view["diff"]["new_followers"], 1)
        self.assertEqual(view["diff"]["i_unfollowed"], 2)
        self.assertEqual(view["diff"]["i_followed"], 1)
        hidden = run_view(public)
        self.assert_rows(hidden["rows"], expected, accounts=False)
        self.assertNotIn("user_", hidden["html"])
        self.assertNotIn("https", hidden["html"])
        self.assertNotIn("x.com", hidden["html"])
        self.assertIn("账号#01", hidden["html"])
        self.assertEqual(hidden["back"]["ready"], True)
        self.assertEqual(len(hidden["back"]["items"]), 4)
        self.assertEqual([item["tier"] for item in hidden["back"]["items"]],
                         [item["tier"] for item in view["back"]["items"]])
        self.assertEqual(hidden["diff"], view["diff"])
        week = run_view(private, {"latest": True, "days": 7})
        self.assertEqual(week["meta"]["days"], 7)
        self.assertNotEqual(week["meta"]["start"], meta["start"])
        self.assertNotEqual(
            [(row["tier"], row["score"]) for row in week["rows"]],
            [(row["tier"], row["score"]) for row in view["rows"]],
        )

    def test_keep_list_and_collected_days_follow_the_script(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        keep = Path(out.name, "keep.txt")
        keep.write_text("@user_17\n# comment\n", encoding="utf-8")
        audit.main(["--data", str(SAMPLE), "--keep-list", str(keep), "--out", out.name])
        view = run_view(Path(out.name, "dashboard.html"))
        conf, cfg = audit.rs.load_config()
        expected, _meta = audit.analyze(audit.load_inputs(str(SAMPLE)), conf, cfg, None, None, False)
        info = nfb.build(str(SAMPLE), expected, str(keep))
        self.assertEqual(
            [item["handle"] for item in view["back"]["items"]],
            [item["handle"] for item in info["items"]],
        )
        masked = Path(out.name, "dashboard_public.html").read_text(encoding="utf-8")
        self.assertNotIn("user_", masked)

        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        day = base / "daily"
        columns = ["id", "tweet_id", "ts", "account", "direction", "type", "text"]

        def write_day(name, rows):
            path = day / name / "private"
            path.mkdir(parents=True)
            import csv
            with (path / "interactions.csv").open("w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=columns)
                writer.writeheader()
                writer.writerows(rows)

        write_day("2026-10-18", [dict(id="tw:9100001", tweet_id="9100001", ts="2026-09-01T12:00:00Z",
                                       account="user_201", direction="in", type="reply", text="较早的实质回复")])
        write_day("2026-10-19", [dict(id="tw:9100002", tweet_id="9100002", ts="2026-10-19T12:00:00Z",
                                       account="user_202", direction="in", type="reply", text="窗口内的实质回复")])
        target = base / "out"
        audit.main(["--data-root", str(day), "--end", "2026-10-19", "--days", "3", "--out", str(target)])
        conf, cfg = audit.rs.load_config()
        loaded = audit.load_daily_root(day)
        expected, meta = audit.analyze(loaded, conf, cfg, "2026-10-19", 3, False)
        self.assertIn("2026-10-18", meta["covered_days"])
        self.assertEqual(len(meta["covered_days"]), 2)
        viewed = run_view(target / "dashboard.html")
        self.assertEqual(viewed["meta"]["covered"], 2)
        self.assertEqual(viewed["meta"]["uncovered"], 1)
        self.assert_rows(viewed["rows"], expected)
        public = (target / "dashboard_public.html").read_text(encoding="utf-8")
        self.assertNotIn("user_", public)
        self.assertNotIn("9100001", public)
        self.assertNotIn("较早的实质回复", public)


if __name__ == "__main__":
    unittest.main()
