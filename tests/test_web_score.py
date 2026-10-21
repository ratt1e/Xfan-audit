"""网页打分和 Python 用同一套无数据日规则，sample_data 必须逐项相同。"""
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

import audit

ROOT = Path(__file__).resolve().parents[1]
KEYS = ["account", "tier", "status", "score", "stars", "O", "I", "O_raw", "I_raw", "rounds",
        "sub_days", "P", "B", "R", "action", "priority", "mutual", "verified"]


def find_node():
    found = shutil.which("node")
    if found:
        return found
    bundled = Path("/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node")
    if bundled.is_file():
        return str(bundled)
    return ""


def python_rows(end, days, all_days):
    conf, cfg = audit.rs.load_config(str(ROOT / "config.json"))
    data = audit.load_inputs(str(ROOT / "sample_data"))
    res, meta = audit.analyze(data, conf, cfg, end, days, all_days)
    rows = []
    for item in res:
        row = {}
        for key in KEYS:
            value = item.get(key)
            if isinstance(value, date):
                value = value.isoformat()
            row[key] = value
        rows.append(row)
    return rows, meta


def node_rows(end, days, all_days):
    node = find_node()
    if not node:
        raise AssertionError("找不到 node，无法核对网页打分")
    env = dict(os.environ)
    out = subprocess.check_output(
        [node, str(ROOT / "tests/web_score_runner.mjs"), end, str(days), "1" if all_days else "0"],
        cwd=str(ROOT), env=env)
    return json.loads(out)


def same(got, exp):
    if isinstance(exp, float) or isinstance(got, float):
        return abs(float(got) - float(exp)) < 1e-9
    return got == exp


class TestWebScore(unittest.TestCase):
    def match(self, end, days, all_days):
        web = node_rows(end, days, all_days)
        conf = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        for key in ("weights", "persistence", "greeting_cap", "likes", "insufficient", "stars", "tiers", "exclude_accounts"):
            self.assertEqual(web["config"][key], conf[key])
        self.assertEqual(web["config"]["greetings"]["words"], conf["greetings"]["words"])
        self.assertEqual(web["config"]["window"]["timezone"], conf["window"]["timezone"])
        expected, meta = python_rows(end, days, all_days)
        self.assertEqual(web["meta"]["start"], meta["start"])
        self.assertEqual(web["meta"]["end"], meta["end"])
        self.assertEqual(web["meta"]["covered"], len(meta["covered_days"]))
        self.assertEqual(web["meta"]["uncovered"], len(meta.get("uncovered_days") or []))
        self.assertEqual(len(web["rows"]), len(expected))
        for got, exp in zip(web["rows"], expected):
            for key in KEYS:
                self.assertTrue(same(got[key], exp[key]), "%s %s: 网页 %r，Python %r" % (exp["account"], key, got[key], exp[key]))

    def test_sample_30_days_matches_python(self):
        self.match("2026-10-19", 30, False)

    def test_sample_all_days_matches_python(self):
        self.match("2026-10-19", 30, True)

    def test_pages_workflow_is_manual_only(self):
        text = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch", text)
        self.assertNotIn("push:", text)
        self.assertIn("path: web", text)

    def test_page_stays_on_this_computer(self):
        html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertIn("数据只在你的浏览器里处理，不会上传", html)
        self.assertIn("打码模式", html)
        self.assertNotIn("https://", html)
        self.assertNotIn("fetch(", html)
        self.assertNotIn("script src", html.lower())

    def test_tweet_json_matches_adapter(self):
        node = find_node()
        web = json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "tweets", "demo_owner"], cwd=str(ROOT)))
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        out = Path(folder.name) / "replies.csv"
        result = subprocess.run(
            [sys.executable, str(ROOT / "adapters/twitter_web_exporter.py"), "replies",
             str(ROOT / "tests/fixtures/twe_tweets.json"), "--owner", "demo_owner", "-o", str(out)],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with out.open(encoding="utf-8", newline="") as fh:
            py = list(csv.DictReader(fh))
        fields = ["tweet_id", "created_at", "direction", "account", "in_reply_to_status_id", "conversation_id", "parent_kind"]
        self.assertEqual([{k: row[k] for k in fields} for row in web], [{k: row[k] for k in fields} for row in py])
        owner = json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "owner"], cwd=str(ROOT)))
        self.assertEqual(owner["owner"], "")
