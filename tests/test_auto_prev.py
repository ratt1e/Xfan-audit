"""关注变化自动对比。账号都是 user_01 这种虚构名。"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import follow_diff  # noqa: E402

SAMPLE = ROOT / "sample_data"


def run_audit(*args):
    return subprocess.run([sys.executable, str(ROOT / "audit.py"), *map(str, args)],
                          capture_output=True, text=True)


def write_people(path, people):
    path.write_text(json.dumps([{"screen_name": handle, "id_str": uid} for handle, uid in people]),
                    encoding="utf-8")


def write_csv(path, handles):
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["handle", "name"])
        for handle in handles:
            writer.writerow([handle, handle])


def write_replies(path):
    path.write_text(
        "tweet_id,created_at,direction,account,text\n"
        "t1,2026-10-01T12:00:00Z,out,user_01,hi\n",
        encoding="utf-8")


class TestAutoPrev(unittest.TestCase):
    def test_two_json_generations_use_latest_only(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        data = Path(folder.name, "lists")
        out = Path(folder.name, "out")
        data.mkdir()
        write_replies(data / "replies.csv")
        write_people(data / "following_1690000000000.json", [("user_01", "11"), ("user_02", "12")])
        write_people(data / "following_1700000000000.json", [("user_01", "11"), ("user_03", "13")])
        write_people(data / "followers_1690000000000.json", [("user_01", "11")])
        write_people(data / "followers_1700000000000.json", [("user_01", "11"), ("user_04", "14")])
        result = run_audit("--data", data, "--auto-prev", "--tz", "UTC", "--out", out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("对比的是", result.stdout)
        self.assertIn("关注变化：取关我的 0，新粉丝 1，我取关的 1，我新关注的 1", result.stdout)
        self.assertNotIn("user_", result.stdout)
        self.assertNotIn("user_", result.stderr)
        summary = json.loads((out / "follow_summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["unfollowed_me"], 0)
        self.assertEqual(summary["new_followers"], 1)
        self.assertEqual(summary["i_unfollowed"], 1)
        self.assertEqual(summary["i_followed"], 1)
        self.assertFalse(summary["waiting"])
        self.assertFalse(summary["kept"])
        self.assertNotIn("user_", json.dumps(summary))
        snap = json.loads((out / "lists_snapshot.json").read_text(encoding="utf-8"))
        self.assertIn("user_01", json.dumps(snap["latest"]))
        self.assertNotIn("name", json.dumps(snap["latest"]["following"][0]))
        public = (out / "dashboard_public.html").read_text(encoding="utf-8")
        self.assertNotIn("user_", public)
        self.assertNotIn(json.dumps(snap["latest"]), public)
        missed = (out / "没回关.md").read_text(encoding="utf-8")
        self.assertIn("user_03", missed)
        self.assertNotIn("user_02", missed)
        self.assertNotIn("user_04", missed)
        self.assertIn("user_02", (out / "dashboard.html").read_text(encoding="utf-8"))

    def test_one_generation_waits_for_the_next_export(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        out = Path(folder.name, "out")
        result = run_audit("--data", SAMPLE, "--auto-prev", "--tz", "America/Los_Angeles", "--out", out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("金牌 3", result.stdout)
        self.assertIn(follow_diff.WAITING_NOTE, result.stdout)
        self.assertNotIn("对比的是", result.stdout)
        page = (out / "dashboard.html").read_text(encoding="utf-8")
        self.assertIn(follow_diff.WAITING_NOTE, page)
        self.assertNotIn("没有变化", page)
        public = (out / "dashboard_public.html").read_text(encoding="utf-8")
        self.assertIn(follow_diff.WAITING_NOTE, public)
        self.assertNotIn("user_", public)
        snap = json.loads((out / "lists_snapshot.json").read_text(encoding="utf-8"))
        self.assertIsNone(snap["baseline"])
        self.assertIn("user_01", json.dumps(snap["latest"]))
        summary = json.loads((out / "follow_summary.json").read_text(encoding="utf-8"))
        self.assertTrue(summary["waiting"])
        self.assertIsNone(summary["i_followed"])
        self.assertNotIn("user_", json.dumps(summary))

    def test_unchanged_files_keep_the_previous_comparison(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        data = Path(folder.name, "lists")
        out = Path(folder.name, "out")
        data.mkdir()
        write_replies(data / "replies.csv")
        write_csv(data / "following.csv", ["user_01"])
        write_csv(data / "followers.csv", ["user_01"])
        now = time.time()
        os.utime(data / "following.csv", (now, now))
        os.utime(data / "followers.csv", (now, now))
        first = run_audit("--data", data, "--auto-prev", "--tz", "UTC", "--out", out)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn(follow_diff.WAITING_NOTE, first.stdout)
        snap = json.loads((out / "lists_snapshot.json").read_text(encoding="utf-8"))
        self.assertIsNone(snap["baseline"])
        write_csv(data / "following.csv", ["user_01", "user_02"])
        later = now + 86400
        os.utime(data / "following.csv", (later, later))
        second = run_audit("--data", data, "--auto-prev", "--tz", "UTC", "--out", out)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("对比的是", second.stdout)
        summary = json.loads((out / "follow_summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["i_followed"], 1)
        self.assertFalse(summary["kept"])
        third = run_audit("--data", data, "--auto-prev", "--tz", "UTC", "--out", out)
        self.assertEqual(third.returncode, 0, third.stderr)
        again = json.loads((out / "follow_summary.json").read_text(encoding="utf-8"))
        self.assertEqual(again["from"], summary["from"])
        self.assertEqual(again["to"], summary["to"])
        self.assertEqual(again["i_followed"], 1)
        self.assertTrue(again["kept"])
        page = (out / "dashboard.html").read_text(encoding="utf-8")
        self.assertIn("沿用", page)
        self.assertIn("没有新的导出", page)
        self.assertNotIn("没有变化", page)
        public = (out / "dashboard_public.html").read_text(encoding="utf-8")
        self.assertNotIn("user_", public)

    def test_auto_prev_rejects_manual_prev_and_missing_lists(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        both = run_audit("--data", SAMPLE, "--auto-prev", "--prev-lists", SAMPLE / "prev", "--out", folder.name)
        self.assertNotEqual(both.returncode, 0)
        self.assertIn("--auto-prev 不与 --prev-lists 同用", both.stderr)
        self.assertNotIn("user_", both.stderr)
        missing = run_audit("--data-root", folder.name, "--auto-prev", "--out", folder.name)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("自动对比需要名单目录：每日模式用 --lists，单目录模式用 --data", missing.stderr)


if __name__ == "__main__":
    unittest.main()
