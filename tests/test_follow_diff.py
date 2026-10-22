"""关注变化：虚构账号，只读对比，终端不打印用户名。"""
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import follow_diff  # noqa: E402
from daily_root import OUTPUT_NAMES  # noqa: E402

SAMPLE = ROOT / "sample_data"
PREV = SAMPLE / "prev"
SHIFT_OLD = SAMPLE / "id_shift" / "old"
SHIFT_NEW = SAMPLE / "id_shift" / "new"


def pairs(items):
    if items is None:
        return None
    return [[item["id"], item["handle"]] for item in items]


def handles(items):
    return [item["handle"] for item in items or []]


class TestFollowDiff(unittest.TestCase):
    def test_sample_snapshot_groups(self):
        diff = follow_diff.compare_dirs(PREV, SAMPLE)
        self.assertEqual(handles(diff["unfollowed_me"]), ["user_13", "user_90"])
        self.assertEqual(handles(diff["new_followers"]), ["user_03"])
        self.assertEqual(handles(diff["i_unfollowed"]), ["user_15", "user_92"])
        self.assertEqual(handles(diff["i_followed"]), ["user_19"])
        self.assertEqual(diff["notes"], [])
        self.assertTrue(diff["ready"])
        self.assertEqual(
            follow_diff.summary_line(diff),
            "关注变化：取关我的 2，新粉丝 1，我取关的 2，我新关注的 1",
        )

    def test_same_lists_have_no_changes(self):
        diff = follow_diff.compare_dirs(SAMPLE, SAMPLE)
        for key, _label in follow_diff.GROUP_ORDER:
            self.assertEqual(diff[key], [])

    def test_missing_side_is_not_an_empty_list(self):
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        diff = follow_diff.compare_dirs(empty.name, SAMPLE)
        self.assertIsNone(diff["unfollowed_me"])
        self.assertIsNone(diff["i_unfollowed"])
        self.assertFalse(diff["ready"])
        self.assertIn("关注者", diff["notes"][0])

    def test_id_matches_rename_and_rejects_reused_handle(self):
        diff = follow_diff.compare_dirs(SHIFT_OLD, SHIFT_NEW)
        self.assertEqual(pairs(diff["unfollowed_me"]), [["8800102", "user_42"]])
        self.assertEqual(pairs(diff["new_followers"]), [["8800109", "user_42"]])
        self.assertEqual(pairs(diff["i_unfollowed"]), [["8800201", "user_51"]])
        self.assertEqual(pairs(diff["i_followed"]), [["", "user_53"]])
        flat = json.dumps(pairs(diff["unfollowed_me"]) + pairs(diff["new_followers"])
                          + pairs(diff["i_unfollowed"]) + pairs(diff["i_followed"]), ensure_ascii=False)
        self.assertNotIn("user_41", flat)
        self.assertNotIn("user_43", flat)
        self.assertNotIn("user_52", flat)
        self.assertNotIn("user_54", flat)
        self.assertIn("user_42", follow_diff.collisions_of(
            (diff["unfollowed_me"], diff["new_followers"], diff["i_unfollowed"], diff["i_followed"])))

    def test_csv_user_id_and_handle_fallback(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        old = base / "old.csv"
        new = base / "new.csv"
        old.write_text("handle,user_id\nuser_61,8800301\nuser_62,8800302\nuser_64,\n", encoding="utf-8")
        new.write_text("username,id_str\nuser_61b,8800301\nuser_63,8800303\nUser_64,8800304\n", encoding="utf-8")
        diff = follow_diff.compare_sources(old_followers=old, new_followers=new,
                                            old_following=old, new_following=new)
        self.assertEqual(pairs(diff["unfollowed_me"]), [["8800302", "user_62"]])
        self.assertEqual(pairs(diff["new_followers"]), [["8800303", "user_63"]])
        self.assertNotIn("user_61", handles(diff["unfollowed_me"]) + handles(diff["new_followers"]))
        self.assertNotIn("user_64", handles(diff["unfollowed_me"]) + handles(diff["new_followers"]))

    def test_id_column_priority_and_username(self):
        indexed = follow_diff.index_accounts([
            {"user_id": "8800401", "id": "999", "screen_name": "@User_61"},
            {"username": "User_62", "rest_id": "8800402"},
        ])
        self.assertEqual(indexed["items"][0]["id"], "8800401")
        self.assertEqual(indexed["items"][0]["handle"], "user_61")
        self.assertEqual(indexed["by_id"]["8800402"]["handle"], "user_62")

    def test_plugin_json_names_merge_and_csv_wins(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        old, new = base / "old", base / "new"
        old.mkdir()
        new.mkdir()
        (old / "twitter-正在关注-100000.json").write_text(
            json.dumps([{"id": "8800501", "screen_name": "user_83"}]), encoding="utf-8")
        (old / "twitter-正在关注-200000.json").write_text(
            json.dumps([{"id": "8800502", "screen_name": "user_84"}]), encoding="utf-8")
        (new / "twitter-Following-100000.json").write_text(
            json.dumps([{"id": "8800501", "screen_name": "user_83"}]), encoding="utf-8")
        merged = follow_diff.compare_dirs(old, new)
        self.assertEqual(handles(merged["i_unfollowed"]), ["user_84"])
        (old / "following.csv").write_text("handle,name,bio\nuser_81,甲,x\n", encoding="utf-8")
        (new / "following.csv").write_text("handle,name,bio\nuser_81,甲,x\n", encoding="utf-8")
        preferred = follow_diff.compare_dirs(old, new)
        self.assertEqual(preferred["i_unfollowed"], [])
        self.assertNotIn("user_84", handles(preferred["i_unfollowed"]) + handles(preferred["i_followed"]))

    def test_script_writes_names_only_in_out_dir(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        target = Path(out.name)
        (target / "keep.txt").write_text("keep", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/follow_diff.py"),
             "--old", str(PREV), "--new", str(SAMPLE), "--out", out.name],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("取关我的 2", result.stdout)
        self.assertNotIn("user_", result.stdout)
        self.assertNotIn("user_", result.stderr)
        text = (target / "关注变化.md").read_text(encoding="utf-8")
        self.assertIn("user_90", text)
        self.assertIn("user_03", text)
        self.assertIn("取关我的（2）", text)
        self.assertEqual((target / "keep.txt").read_text(encoding="utf-8"), "keep")
        names = sorted(path.name for path in target.iterdir())
        self.assertEqual(names, ["keep.txt", "关注变化.md"])

    def test_script_refuses_symlink_and_missing_dir(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        secret = base / "secret.md"
        secret.write_text("keep", encoding="utf-8")
        out = base / "out"
        out.mkdir()
        (out / "关注变化.md").symlink_to(secret)
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/follow_diff.py"),
             "--old", str(SHIFT_OLD), "--new", str(SHIFT_NEW), "--out", str(out)],
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((out / "关注变化.md").is_symlink())
        self.assertEqual(secret.read_text(encoding="utf-8"), "keep")
        self.assertNotIn("user_", result.stdout + result.stderr)
        missing = subprocess.run(
            [sys.executable, str(ROOT / "scripts/follow_diff.py"),
             "--old", str(base / "missing"), "--new", str(SAMPLE), "--out", str(base / "elsewhere")],
            capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("旧名单目录不存在", missing.stderr)
        self.assertFalse((base / "elsewhere").exists())

    def test_script_id_collision_mentions_id_only_in_file(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/follow_diff.py"),
             "--old", str(SHIFT_OLD), "--new", str(SHIFT_NEW), "--out", out.name],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("8800", result.stdout)
        self.assertNotIn("user_", result.stdout)
        text = (Path(out.name) / "关注变化.md").read_text(encoding="utf-8")
        self.assertIn("user_42（id 8800102）", text)
        self.assertIn("user_42（id 8800109）", text)
        self.assertNotIn("user_41", text)


class TestAuditPrevLists(unittest.TestCase):
    def run_audit(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "audit.py"), *map(str, args)],
                              capture_output=True, text=True)

    def test_flag_adds_section_and_masks_public_dashboard(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        plain = tempfile.TemporaryDirectory()
        self.addCleanup(plain.cleanup)
        before = self.run_audit("--data", SAMPLE, "--out", plain.name)
        self.assertEqual(before.returncode, 0, before.stderr)
        result = self.run_audit("--data", SAMPLE, "--prev-lists", PREV, "--out", out.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("关注变化：取关我的 2，新粉丝 1，我取关的 2，我新关注的 1", result.stdout)
        self.assertNotIn("user_", result.stdout)
        self.assertNotIn("user_", result.stderr)
        self.assertEqual(sorted(os.listdir(out.name)), sorted(name for name in OUTPUT_NAMES if name != "名单.md"))
        self.assertEqual(Path(plain.name, "accounts.csv").read_bytes(), Path(out.name, "accounts.csv").read_bytes())
        private = Path(out.name, "dashboard.html").read_text(encoding="utf-8")
        public = Path(out.name, "dashboard_public.html").read_text(encoding="utf-8")
        self.assertNotIn("关注变化", Path(plain.name, "dashboard.html").read_text(encoding="utf-8"))
        section = private.split('id="follow-diff"', 1)[1]
        self.assertIn("@user_90", section)
        self.assertIn("@user_03", section)
        self.assertIn("取关我的（2）", section)
        self.assertNotIn("user_", public)
        public_section = public.split('id="follow-diff"', 1)[1]
        self.assertIn("关注变化", public_section)
        self.assertIn("取关我的", public_section)
        self.assertNotIn("user_", public_section)
        mark = "@"
        priv_names = re.findall(r"<tr><td>(?:<a [^>]*>)?(" + mark + r"user_\d+)", private)
        pub_names = re.findall(r"<tr><td>(账号#\d+)</td>", public)
        mapping = dict(zip(priv_names, pub_names))
        self.assertIn(mapping[mark + "user_03"], public_section)

    def test_missing_prev_dir_stops_without_names(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        missing = Path(out.name) / "no-such-lists"
        result = self.run_audit("--data", SAMPLE, "--prev-lists", missing, "--out", out.name)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("上一份关系表目录不存在", result.stderr)
        self.assertNotIn("user_", result.stderr)
        self.assertFalse((Path(out.name) / "dashboard.html").exists())

    def test_daily_overwrite_still_only_own_files(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name)
        day = base / "daily" / "2026-10-01" / "private"
        day.mkdir(parents=True)
        with (day / "interactions.csv").open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=["id", "tweet_id", "ts", "account", "direction", "type", "text"])
            writer.writeheader()
            writer.writerow(dict(id="tw:9100001", tweet_id="9100001", ts="2026-10-01T12:00:00Z",
                                 account="user_201", direction="in", type="reply", text="测试实质回复"))
        out = base / "out"
        out.mkdir()
        for name in OUTPUT_NAMES:
            (out / name).write_text("old-result", encoding="utf-8")
        result = self.run_audit("--data-root", base / "daily", "--lists", SAMPLE, "--prev-lists", PREV,
                                "--out", out, "--overwrite")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in out.iterdir()), sorted(OUTPUT_NAMES))
        private = (out / "dashboard.html").read_text(encoding="utf-8")
        public = (out / "dashboard_public.html").read_text(encoding="utf-8")
        self.assertIn("关注变化", private)
        self.assertIn("@user_90", private)
        self.assertNotIn("old-result", private)
        self.assertNotIn("old-result", (out / "没回关.md").read_text(encoding="utf-8"))
        self.assertNotIn("user_", public)
        self.assertNotIn("https", public)
        self.assertNotIn("x.com", public)
        self.assertIn("账号#", public.split('id="follow-diff"', 1)[1])
        self.assertNotIn("user_90", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
