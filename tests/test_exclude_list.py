"""本地排除名单。只用虚构账号，不连接 X。"""
import csv
import os
import shutil
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
import sys
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import audit  # noqa: E402
from daily_root import apply_exclude, find_exclude, parse_exclude_text  # noqa: E402


SAMPLE = os.path.join(ROOT, "sample_data")


def accounts_of(path):
    with open(path, encoding="utf-8-sig") as handle:
        return {row["account"]: row for row in csv.DictReader(handle)}


class TestExcludeParse(unittest.TestCase):
    def test_case_at_comma_and_comment(self):
        ids, handles = parse_exclude_text("# 注释\n\n@USER_01, user_01\nUser_09\n42\n")
        self.assertEqual(ids, {"42"})
        self.assertEqual(handles, {"user_01", "user_09"})

    def test_id_removes_matching_handle(self):
        data = {
            "rows": [{"account": "user_01", "type": "reply"}, {"account": "user_02", "type": "reply"}],
            "following": {"user_01": {"handle": "user_01", "user_id": "42"}, "user_02": {"handle": "user_02"}},
            "followers": {"user_01": {"handle": "user_01", "user_id": "42"}},
            "profiles": {"user_01": {"handle": "user_01"}},
        }
        apply_exclude(data, {"42"}, set())
        self.assertEqual([row["account"] for row in data["rows"]], ["user_01", "user_02"])
        self.assertEqual(list(data["following"]), ["user_02"])
        self.assertNotIn("user_01", data["profiles"])


class TestExcludeAudit(unittest.TestCase):
    def test_missing_file_matches_current(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        audit.main(["--data", SAMPLE, "--tz", "America/Los_Angeles", "--out", out])
        rows = accounts_of(os.path.join(out, "accounts.csv"))
        self.assertEqual(len(rows), 20)
        self.assertIn("user_01", rows)
        captured = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, captured, True)
        import subprocess
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "audit.py"), "--data", SAMPLE, "--tz", "America/Los_Angeles", "--out", captured],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("已排除", proc.stdout)
        self.assertIn("20 个账号", proc.stdout)

    def test_file_and_flag_drop_person_everywhere(self):
        base = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, base, True)
        audit.main(["--data", SAMPLE, "--tz", "America/Los_Angeles", "--out", base])
        before = accounts_of(os.path.join(base, "accounts.csv"))
        text = "# 只在本地\n\n@USER_01\nuser_01\n@User_09\n"
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, True)
        path = os.path.join(folder, "排除名单.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        import subprocess
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "audit.py"), "--data", SAMPLE, "--exclude", path,
             "--tz", "America/Los_Angeles", "--out", out],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("已排除 2 人", proc.stdout)
        self.assertNotIn("user_01", proc.stdout)
        self.assertNotIn("user_09", proc.stdout)
        rows = accounts_of(os.path.join(out, "accounts.csv"))
        self.assertNotIn("user_01", rows)
        self.assertNotIn("user_09", rows)
        self.assertEqual(len(rows), len(before) - 2)
        self.assertEqual(rows["user_07"]["score"], before["user_07"]["score"])
        self.assertEqual(rows["user_07"]["stars"], before["user_07"]["stars"])
        self.assertEqual(rows["user_07"]["tier"], before["user_07"]["tier"])
        for name in ("dashboard.html", "dashboard_public.html", "没回关.md"):
            with open(os.path.join(out, name), encoding="utf-8") as handle:
                body = handle.read()
            self.assertNotIn("user_01", body, name)
            self.assertNotIn("user_09", body, name)
        with open(os.path.join(out, "dashboard.html"), encoding="utf-8") as handle:
            page = handle.read()
        self.assertIn("分层人数", page)
        copied = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, copied, True)
        shutil.copytree(SAMPLE, os.path.join(copied, "data"))
        data_dir = os.path.join(copied, "data")
        with open(os.path.join(data_dir, "排除名单.txt"), "w", encoding="utf-8") as handle:
            handle.write("@User_01\n")
        out2 = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out2, True)
        audit.main(["--data", data_dir, "--tz", "America/Los_Angeles", "--out", out2])
        again = accounts_of(os.path.join(out2, "accounts.csv"))
        self.assertNotIn("user_01", again)
        self.assertIn("user_09", again)

    def test_missing_explicit_file_errors(self):
        import subprocess
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "audit.py"), "--data", SAMPLE, "--exclude", os.path.join(tempfile.mkdtemp(), "nope.txt")],
            capture_output=True, text=True,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("排除名单文件不存在", proc.stderr)
        self.assertNotIn("user_", proc.stderr)

    def test_daily_root_file(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        day = os.path.join(root, "2026-10-01", "private")
        os.makedirs(day)
        with open(os.path.join(day, "interactions.csv"), "w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["id", "tweet_id", "ts", "account", "direction", "type", "text"])
            writer.writeheader()
            writer.writerow(dict(id="tw:1", tweet_id="1", ts="2026-10-01T12:00:00Z", account="user_201", direction="in", type="reply", text="你好"))
            writer.writerow(dict(id="tw:2", tweet_id="2", ts="2026-10-01T13:00:00Z", account="user_202", direction="out", type="reply", text="你好呀"))
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        audit.main(["--data-root", root, "--tz", "UTC", "--out", out, "--overwrite"])
        self.assertIn("user_201", accounts_of(os.path.join(out, "accounts.csv")))
        with open(os.path.join(root, "排除名单.txt"), "w", encoding="utf-8") as handle:
            handle.write("@USER_201\n")
        out2 = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out2, True)
        import subprocess
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "audit.py"), "--data-root", root, "--tz", "UTC", "--out", out2, "--overwrite"],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("已排除 1 人", proc.stdout)
        self.assertNotIn("user_201", proc.stdout)
        rows = accounts_of(os.path.join(out2, "accounts.csv"))
        self.assertNotIn("user_201", rows)
        self.assertIn("user_202", rows)
        with open(os.path.join(out2, "名单.md"), encoding="utf-8") as handle:
            roster = handle.read()
        self.assertNotIn("user_201", roster)
        ids, handles, count, used = find_exclude(None, root)
        self.assertTrue(used)
        self.assertEqual(handles, {"user_201"})
        self.assertEqual(count, 1)
        self.assertEqual(find_exclude(None, tempfile.mkdtemp())[3], False)
