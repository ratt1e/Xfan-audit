"""audit.py / relationship_stars.py / config.json 的测试（虚构数据，不联网）。

运行：python3 -m unittest discover -s tests
"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import audit  # noqa: E402
import relationship_stars as rs  # noqa: E402


class TestConfig(unittest.TestCase):
    def test_defaults_match_spec(self):
        conf, cfg = rs.load_config()
        self.assertEqual((cfg["W_P"], cfg["W_B"], cfg["W_R"]), (0.40, 0.35, 0.25))
        self.assertEqual((cfg["GREET_DAY"], cfg["GREET_SHARE_CAP"], cfg["GREET_MAX_SCORE"]), (0.2, 0.8, 39.9))
        self.assertEqual((cfg["LIKE_PTS"], cfg["LIKE_CAP"]), (0.5, 5.0))
        self.assertEqual(cfg["STARS"], {5: 80, 4: 60, 3: 40, 2: 20})
        self.assertEqual((cfg["MIN_RAW"], cfg["MIN_DAYS"]), (3, 2))
        self.assertEqual(rs.CFG["W_P"], cfg["W_P"])

    def test_star_edge(self):
        self.assertEqual(rs.stars_of(79.95), 4)
        self.assertEqual(rs.stars_of(80), 5)
        self.assertEqual(rs.stars_of(19.9), 1)


class TestSpecExample(unittest.TestCase):
    """SPEC 14.1 期望值（示例数据 examples/relationship/interactions.csv）。"""
    def test_expected_scores(self):
        out = os.path.join(tempfile.mkdtemp(), "r.csv")
        rs.main(["--interactions", os.path.join(ROOT, "examples/relationship/interactions.csv"),
                 "--end", "2026-10-19", "--days", "30", "--tz", "UTC", "--out", out])
        with open(out, encoding="utf-8") as f:
            got = {r["account"]: r for r in csv.DictReader(f)}
        for acc, sc, st in [("user_101", "4.4", "1"), ("user_102", "4.4", "1"), ("user_103", "97.8", "5"),
                            ("user_104", "38.5", "2"), ("user_107", "42.4", "3"), ("user_108", "18.7", "1")]:
            self.assertEqual((got[acc]["score"], got[acc]["stars"]), (sc, st), acc)
        self.assertEqual(got["user_105"]["status"], "样本不足")
        self.assertEqual(got["user_106"]["status"], "样本不足")


class TestAuditSample(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        audit.main(["--data", os.path.join(ROOT, "sample_data"), "--out", self.out])
        with open(os.path.join(self.out, "accounts.csv"), encoding="utf-8-sig") as f:
            self.rows = {r["account"]: r for r in csv.DictReader(f)}

    def test_all_tiers_covered(self):
        tiers = {r["tier"] for r in self.rows.values()}
        for t in ("金牌", "银牌", "单向·他常来我少回", "单向·我常去他没回", "沉睡互关", "样本不足"):
            self.assertIn(t, tiers)
        stars = {r["stars"] for r in self.rows.values() if r["status"] == "ok"}
        self.assertEqual(stars, {"1", "2", "3", "4", "5"})

    def test_expected_tiers(self):
        self.assertEqual(self.rows["user_01"]["tier"], "金牌")
        self.assertEqual(self.rows["user_07"]["greet_cap"], "True")       # 问候为主 → 问候上限
        self.assertEqual(self.rows["user_10"]["tier"], "沉睡互关")
        self.assertEqual(self.rows["user_14"]["status"], "样本不足")       # 只有点赞

    def test_public_dashboard_masked(self):
        with open(os.path.join(self.out, "dashboard_public.html"), encoding="utf-8") as f:
            pub = f.read()
        with open(os.path.join(self.out, "dashboard.html"), encoding="utf-8") as f:
            full = f.read()
        self.assertIn("@user_01", full)
        self.assertNotIn("user_", pub)
        self.assertIn("账号#01", pub)

    def test_cli_one_liner(self):
        out = tempfile.mkdtemp()
        p = subprocess.run([sys.executable, os.path.join(ROOT, "audit.py"), "--data", os.path.join(ROOT, "sample_data"),
                            "--out", out], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(os.path.exists(os.path.join(out, "dashboard.html")))

    def test_missing_data_dir_message(self):
        p = subprocess.run([sys.executable, os.path.join(ROOT, "audit.py"), "--data", tempfile.mkdtemp()],
                           capture_output=True, text=True, cwd=tempfile.mkdtemp())
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("sample_data", p.stderr)

    def test_config_changes_score(self):
        with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
            conf = json.load(f)
        conf["stars"]["5"] = 101
        path = os.path.join(tempfile.mkdtemp(), "c.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(conf, f)
        out = tempfile.mkdtemp()
        audit.main(["--data", os.path.join(ROOT, "sample_data"), "--out", out, "--config", path])
        with open(os.path.join(out, "accounts.csv"), encoding="utf-8-sig") as f:
            rows = {r["account"]: r for r in csv.DictReader(f)}
        self.assertEqual(rows["user_01"]["stars"], "4")


if __name__ == "__main__":
    unittest.main()
