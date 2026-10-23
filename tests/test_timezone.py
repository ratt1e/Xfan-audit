"""时区：同一批跨日互动在上海和洛杉矶归到不同的本地日期，网页和 Python 逐项一致。"""
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import audit  # noqa: E402
import daily_collect  # noqa: E402
import relationship_stars as rs  # noqa: E402

SAMPLE = ROOT / "sample_data"
ABSENCE = {"沉睡互关", "零互动", "单向·他常来我少回", "单向·我常去他没回"}


def expected_tier(tier, meta):
    # 这份夹具只有「我发出的回复」。网页在缺一边时不把没采到的日子标成零互动或单向。
    if meta.get("interactionReady") is False and tier in ABSENCE:
        return ""
    return tier
TZ_ERROR = "时区无效，请用 IANA 名称，例如 Asia/Shanghai"


def find_node():
    found = shutil.which("node")
    if found:
        return found
    bundled = Path("/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node")
    if bundled.is_file():
        return str(bundled)
    return ""


def talk(account, tid, ts):
    return {
        "id": "tw:" + tid,
        "tweet_id": tid,
        "ts": ts,
        "account": account,
        "direction": "out",
        "type": "reply",
        "text": "具体聊聊这个话题的细节吧",
        "in_reply_to_status_id": "",
        "conversation_id": "",
        "parent_kind": "",
        "is_greeting": "false",
    }


def cross_data():
    return {
        "rows": [
            talk("early_acct", "1", "2026-10-18T06:30:00Z"),
            talk("late_acct", "2", "2026-10-18T16:30:00Z"),
            talk("span_acct", "3", "2026-10-17T16:30:00Z"),
            talk("span_acct", "4", "2026-10-18T06:30:00Z"),
            talk("span_acct", "5", "2026-10-18T16:30:00Z"),
        ],
        "following": {},
        "followers": {},
        "profiles": {},
        "warnings": [],
    }


def python_view(tz_name, end, days):
    conf, cfg = rs.load_config(str(ROOT / "config.json"))
    conf.setdefault("window", {})["timezone"] = tz_name
    res, meta = audit.analyze(cross_data(), conf, cfg, end, days, False)
    rows = {row["account"]: row for row in res}
    return rows, meta


def web_view(tz_name, end, days):
    node = find_node()
    if not node:
        raise AssertionError("找不到 node，无法核对网页时区")
    folder = tempfile.TemporaryDirectory()
    try:
        spec = Path(folder.name) / "spec.json"
        spec.write_text(json.dumps({
            "data": cross_data(),
            "options": {"tz": tz_name, "end": end, "days": days, "gapsAreEmpty": True},
        }, ensure_ascii=False), encoding="utf-8")
        out = subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "score", str(spec)],
            cwd=str(ROOT))
    finally:
        folder.cleanup()
    payload = json.loads(out)
    if not payload.get("ok"):
        raise AssertionError(payload.get("error"))
    rows = {row["account"]: row for row in payload["rows"]}
    return rows, payload["meta"]


class TestTimezone(unittest.TestCase):
    def test_priority_and_local_name(self):
        self.assertEqual(rs.resolve_timezone_name("Asia/Shanghai", "America/Los_Angeles"), "Asia/Shanghai")
        self.assertEqual(rs.resolve_timezone_name("", "America/Los_Angeles"), "America/Los_Angeles")
        self.assertEqual(rs.resolve_timezone_name(None, "  "), rs.local_timezone_name())
        name = rs.local_timezone_name()
        self.assertTrue(name)
        self.assertNotIn("zoneinfo", name)
        self.assertNotIn("/", name) if name == "UTC" else self.assertIn("/", name)
        rs.zone(name)
        self.assertEqual((ROOT / "config.json").read_text(encoding="utf-8").count('"timezone": ""'), 1)
        self.assertNotIn("America/Los_Angeles", (ROOT / "config.json").read_text(encoding="utf-8"))

    def test_invalid_name_has_no_path(self):
        with self.assertRaises(ValueError) as caught:
            rs.zone("Not/AZone")
        self.assertEqual(str(caught.exception), TZ_ERROR)
        out = tempfile.mkdtemp()
        result = subprocess.run(
            [sys.executable, str(ROOT / "audit.py"), "--data", str(SAMPLE), "--tz", "Not/AZone", "--out", out],
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(TZ_ERROR, result.stderr)
        for banned in ("/workspace", "/home", "/Users", "zoneinfo"):
            self.assertNotIn(banned, result.stderr)
        self.assertFalse(os.path.exists(os.path.join(out, "dashboard.html")))

    def test_cross_midnight_matches_web_in_both_zones(self):
        # 06:30Z 在洛杉矶是前一天 23:30，在上海是当天 14:30。
        # 16:30Z 在洛杉矶是当天 09:30，在上海是下一天 00:30。
        expected = {
            "America/Los_Angeles": {
                "day": {"early_acct": 0, "late_acct": 1},
                "span": {"raw": 3, "status": "ok"},
            },
            "Asia/Shanghai": {
                "day": {"early_acct": 1, "late_acct": 0},
                "span": {"raw": 2, "status": "样本不足"},
            },
        }
        for tz_name, want in expected.items():
            py_rows, py_meta = python_view(tz_name, "2026-10-18", 1)
            web_rows, web_meta = web_view(tz_name, "2026-10-18", 1)
            self.assertEqual(py_meta["tz"], tz_name)
            self.assertEqual(web_meta["tz"], tz_name)
            self.assertEqual(web_meta["start"], py_meta["start"])
            self.assertEqual(web_meta["end"], py_meta["end"])
            for account, raw in want["day"].items():
                self.assertEqual(py_rows[account]["raw"], raw, tz_name)
                self.assertEqual(web_rows[account]["raw"], py_rows[account]["raw"])
                self.assertEqual(web_rows[account]["status"], py_rows[account]["status"])
                self.assertEqual(web_rows[account]["tier"], expected_tier(py_rows[account]["tier"], web_meta))
            span_rows, span_meta = python_view(tz_name, "2026-10-18", 2)
            span_web, span_web_meta = web_view(tz_name, "2026-10-18", 2)
            self.assertEqual(span_rows["span_acct"]["raw"], want["span"]["raw"], tz_name)
            self.assertEqual(span_rows["span_acct"]["status"], want["span"]["status"], tz_name)
            self.assertEqual(span_web["span_acct"]["raw"], span_rows["span_acct"]["raw"])
            self.assertEqual(span_web["span_acct"]["status"], span_rows["span_acct"]["status"])
            self.assertEqual(span_web["span_acct"]["tier"], expected_tier(span_rows["span_acct"]["tier"], span_web_meta))
            self.assertEqual(span_web["span_acct"]["score"], span_rows["span_acct"].get("score"))
            self.assertEqual(span_web_meta["tz"], span_meta["tz"])
        self.assertNotEqual(
            python_view("America/Los_Angeles", "2026-10-18", 1)[0]["early_acct"]["raw"],
            python_view("Asia/Shanghai", "2026-10-18", 1)[0]["early_acct"]["raw"],
        )

    def test_los_angeles_sample_matches_published_numbers(self):
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        code = audit.main(["--data", str(SAMPLE), "--tz", "America/Los_Angeles", "--out", out.name])
        self.assertEqual(code, 0)
        with open(os.path.join(out.name, "accounts.csv"), encoding="utf-8-sig", newline="") as fh:
            rows = {row["account"]: row for row in csv.DictReader(fh)}
        self.assertEqual(rows["user_01"]["tier"], "金牌")
        page = Path(out.name, "dashboard.html").read_text(encoding="utf-8")
        public = Path(out.name, "dashboard_public.html").read_text(encoding="utf-8")
        self.assertIn("当前时区：America/Los_Angeles", page)
        self.assertIn("当前时区：America/Los_Angeles", public)
        self.assertIn('id="tz"', page)
        for banned in ("user_", "https", "x.com", 'target="_blank"'):
            self.assertNotIn(banned, public)
        node = find_node()
        viewed = json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "dashboard", str(Path(out.name, "dashboard.html"))],
            cwd=str(ROOT)))
        self.assertEqual(viewed["meta"]["tz"], "America/Los_Angeles")
        self.assertEqual(viewed["meta"]["covered"], 28)
        self.assertEqual(viewed["meta"]["uncovered"], 2)
        self.assertIn("金牌（3）", viewed["html"])

    def test_open_encodes_spaces_and_chinese(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        out = Path(folder.name) / "看板 目录"
        with mock.patch("webbrowser.open", return_value=True) as opened:
            code = audit.main([
                "--data", str(SAMPLE), "--tz", "America/Los_Angeles", "--out", str(out), "--open",
            ])
        self.assertEqual(code, 0)
        self.assertTrue((out / "dashboard.html").is_file())
        uri = opened.call_args[0][0]
        self.assertTrue(uri.startswith("file:"))
        self.assertNotIn(" ", uri)
        self.assertIn("%20", uri)
        self.assertNotIn("看板", uri)
        with mock.patch("webbrowser.open", side_effect=OSError("no display")):
            self.assertEqual(audit.open_dashboard(str(out / "dashboard.html")), 0)

    def test_daily_collect_records_timezone_without_renaming_the_folder(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        raw = Path(folder.name) / "2026-10-19"
        snap = Path(folder.name) / "snap"
        raw.mkdir()
        (raw / "posts_p1.json").write_text(json.dumps({
            "data": [{
                "id": "1000", "author_id": "100", "created_at": "2026-10-18T10:00:00Z",
                "conversation_id": "1000", "text": "今天的帖子",
            }],
            "includes": {"users": [{"id": "100", "username": "me_demo", "name": "Me"}]},
            "meta": {"result_count": 1},
        }), encoding="utf-8")
        code = daily_collect.main([
            "--raw-dir", str(raw), "--me-id", "100", "--me", "me_demo",
            "--snapshot-dir", str(snap), "--observed-at", "2026-10-19T14:00:00Z",
            "--greetings", str(ROOT / "config.json"), "--tz", "Asia/Shanghai",
        ])
        self.assertEqual(code, 0)
        saved = json.loads((snap / "snapshot.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["date"], "2026-10-19")
        self.assertEqual(saved["timezone"], "Asia/Shanghai")
        self.assertNotIn("me_demo", json.dumps(saved))


if __name__ == "__main__":
    unittest.main()
