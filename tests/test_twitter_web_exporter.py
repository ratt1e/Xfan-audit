"""导出适配器回归测试：夹具全部手写，未从真实文件裁剪或替换。"""
import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


class TestTwitterWebExporter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def convert(self, command, inputs, extra=()):
        output = Path(self.temp.name) / "converted.csv"
        result = subprocess.run(
            [sys.executable, str(ROOT / "adapters" / "twitter_web_exporter.py"),
             command, *map(str, inputs), *extra, "-o", str(output)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        with output.open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream)
            rows = list(reader)
            columns = reader.fieldnames
        return rows, columns, result.stderr

    def test_following_fields_and_nulls(self):
        rows, columns, _ = self.convert("users", [FIXTURES / "twe_following.json"])
        self.assertEqual(rows, [
            {"handle": "user_201", "name": "示例用户甲", "bio": "测试简介 第一行 第二行",
             "followed_by": "True", "following": "True", "is_blue_verified": "True",
             "verified_type": "", "followers_count": "120", "friends_count": "45"},
            {"handle": "user_202", "name": "示例用户乙", "bio": "",
             "followed_by": "False", "following": "True", "is_blue_verified": "False",
             "verified_type": "", "followers_count": "0", "friends_count": "8"},
        ])
        self.assertNotIn("profile_image_url", columns)

    def test_followers_fields(self):
        rows, _, _ = self.convert("users", [FIXTURES / "twe_followers.json"])
        self.assertEqual([row["handle"] for row in rows], ["user_201", "user_203"])
        self.assertEqual([row["followed_by"] for row in rows], ["True", "True"])
        self.assertEqual([row["following"] for row in rows], ["True", "False"])
        self.assertEqual(rows[1]["followers_count"], "36")

    def test_blue_filter_and_duplicate_users(self):
        rows, _, message = self.convert(
            "users", [FIXTURES / "twe_following.json", FIXTURES / "twe_followers.json"],
            ["--only-blue-verified"],
        )
        self.assertEqual([row["handle"] for row in rows], ["user_201", "user_203"])
        self.assertIn("重复 1", message)

    def test_replies_use_parent_author_and_preserve_ids(self):
        rows, columns, message = self.convert(
            "replies", [FIXTURES / "twe_tweets.json"], ["--owner", "demo_owner"],
        )
        self.assertEqual(rows, [
            {"tweet_id": "9100002", "created_at": "2026-10-18T10:01:00Z",
             "direction": "in", "account": "user_201", "text": "测试回复一",
             "in_reply_to_status_id": "9100001", "conversation_id": "", "parent_kind": ""},
            {"tweet_id": "9100003", "created_at": "2026-10-18T10:02:00Z",
             "direction": "out", "account": "user_201", "text": "测试回复二",
             "in_reply_to_status_id": "9100002", "conversation_id": "", "parent_kind": ""},
        ])
        self.assertIn("父推文作者未知", message)
        self.assertIn("自己串推或别人之间的楼中楼", message)
        self.assertIn("不是回复", message)
        self.assertNotIn("quoted_status", columns)

    def test_missing_parent_does_not_invent_direction(self):
        records = json.loads((FIXTURES / "twe_tweets.json").read_text(encoding="utf-8"))
        # 只从手写假夹具取出回复，模拟用户推文导出缺少父帖。
        missing = Path(self.temp.name) / "missing_parent.json"
        missing.write_text(json.dumps([records[1]], ensure_ascii=False), encoding="utf-8")
        rows, columns, message = self.convert("replies", [missing], ["--owner", "demo_owner"])
        self.assertEqual(rows, [])
        self.assertIn("direction", columns)
        self.assertIn("父推文作者未知", message)

    def test_duplicate_tweets_across_inputs(self):
        fixture = FIXTURES / "twe_tweets.json"
        rows, _, _ = self.convert("replies", [fixture, fixture], ["--owner", "demo_owner"])
        self.assertEqual([row["tweet_id"] for row in rows], ["9100002", "9100003"])


if __name__ == "__main__":
    unittest.main()
