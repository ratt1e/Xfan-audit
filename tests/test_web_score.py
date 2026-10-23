"""网页打分和 Python 用同一套无数据日规则，sample_data 必须逐项相同。"""
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

import audit
import follow_diff

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


def python_rows(end, days, all_days, tz="America/Los_Angeles"):
    conf, cfg = audit.rs.load_config(str(ROOT / "config.json"))
    conf.setdefault("window", {})["timezone"] = tz
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


def node_rows(end, days, all_days, tz="America/Los_Angeles"):
    node = find_node()
    if not node:
        raise AssertionError("找不到 node，无法核对网页打分")
    env = dict(os.environ)
    out = subprocess.check_output(
        [node, str(ROOT / "tests/web_score_runner.mjs"), end, str(days), "1" if all_days else "0", tz],
        cwd=str(ROOT), env=env)
    return json.loads(out)


def same(got, exp):
    if isinstance(exp, float) or isinstance(got, float):
        return abs(float(got) - float(exp)) < 1e-9
    return got == exp


class TestWebScore(unittest.TestCase):
    def match(self, end, days, all_days, tz="America/Los_Angeles"):
        web = node_rows(end, days, all_days, tz)
        conf = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        for key in ("weights", "persistence", "greeting_cap", "likes", "insufficient", "stars", "tiers", "exclude_accounts"):
            self.assertEqual(web["config"][key], conf[key])
        self.assertEqual(web["config"]["greetings"]["words"], conf["greetings"]["words"])
        self.assertEqual(web["config"]["window"]["timezone"], conf["window"]["timezone"])
        self.assertEqual(web["meta"]["tz"], tz)
        expected, meta = python_rows(end, days, all_days, tz)
        self.assertEqual(meta["tz"], tz)
        self.assertEqual(web["meta"]["start"], meta["start"])
        self.assertEqual(web["meta"]["end"], meta["end"])
        self.assertEqual(web["meta"]["covered"], len(meta["covered_days"]))
        self.assertEqual(web["meta"]["uncovered"], len(meta.get("uncovered_days") or []))
        self.assertTrue(web["meta"]["interactionReady"])
        self.assertGreaterEqual(web["meta"]["inboundDays"], 1)
        self.assertGreaterEqual(web["meta"]["outboundDays"], 1)
        self.assertGreaterEqual(web["meta"]["talkDays"], 2)
        self.assertEqual(len(web["rows"]), len(expected))
        for got, exp in zip(web["rows"], expected):
            for key in KEYS:
                self.assertTrue(same(got[key], exp[key]), "%s %s: 网页 %r，Python %r" % (exp["account"], key, got[key], exp[key]))

    def test_sample_30_days_matches_python(self):
        self.match("2026-10-19", 30, False)

    def test_sample_all_days_matches_python(self):
        self.match("2026-10-19", 30, True)

    def test_lists_only_does_not_invent_absence_tiers(self):
        node = find_node()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        spec = Path(folder.name) / "lists.json"
        spec.write_text(json.dumps({
            "data": {
                "rows": [],
                "following": {"user_01": {"handle": "user_01"}, "user_02": {"handle": "user_02"}},
                "followers": {"user_01": {"handle": "user_01"}},
                "profiles": {}
            },
            "options": {"me": "demo_owner", "end": "2026-10-19", "days": 30, "gapsAreEmpty": True, "tz": "America/Los_Angeles"}
        }), encoding="utf-8")
        web = json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "score", str(spec)], cwd=str(ROOT)))
        self.assertTrue(web["ok"])
        self.assertFalse(web["meta"]["interactionReady"])
        self.assertEqual(web["meta"]["inboundDays"], 0)
        self.assertEqual(web["meta"]["outboundDays"], 0)
        self.assertEqual(web["meta"]["talkDays"], 0)
        self.assertIn("互动数据还不够", web["meta"]["interactionNote"])
        tiers = {row["account"]: row["tier"] for row in web["rows"]}
        self.assertEqual(tiers["user_01"], "")
        self.assertTrue(web["rows"][0]["mutual"] or any(row["account"] == "user_01" and row["mutual"] for row in web["rows"]))
        for row in web["rows"]:
            self.assertNotIn(row["tier"], ("沉睡互关", "零互动", "单向·他常来我少回", "单向·我常去他没回"))
        board = self.board(web["rows"], {"interactionReady": False, "interactionNote": web["meta"]["interactionNote"], "extras": [{"id": "not-followed-back", "count": "1", "label": "没回关"}]})
        html = board["html"]
        self.assertIn("互动数据还不够", html)
        self.assertIn(">互关<", html)
        self.assertIn("没回关", html)
        self.assertNotIn('data-jump="沉睡互关"', html)
        self.assertNotIn("不急着取关", html)
        self.assertNotIn("tier-零互动", html)
        self.assertNotIn("tier-cards", html)

    def test_pages_workflow_is_manual_only(self):
        text = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch", text)
        self.assertNotIn("push:", text)
        self.assertIn("path: web", text)

    def test_page_stays_on_this_computer(self):
        html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertIn("数据只在你的浏览器里处理，不会上传", html)
        self.assertIn("打码模式", html)
        self.assertIn('id="tz"', html)
        self.assertIn("当前时区：", html)
        self.assertIn("defaultTimeZone", html)
        self.assertIn('type="file" multiple', html)
        self.assertIn("<select data-idx=", html)
        self.assertIn("请选择", html)
        self.assertIn('id="top"', html)
        self.assertIn("scrollIntoView", html)
        self.assertIn("smooth", html)
        self.assertIn("flash", html)
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

    def kinds(self, jobs):
        node = find_node()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        plan = Path(folder.name) / "plan.json"
        plan.write_text(json.dumps(jobs), encoding="utf-8")
        return json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "kinds", str(plan)], cwd=str(ROOT)))

    def test_plugin_export_names_and_content_fallback(self):
        tweets = str(ROOT / "tests/fixtures/twe_tweets.json")
        following = str(ROOT / "tests/fixtures/twe_following.json")
        followers = str(ROOT / "tests/fixtures/twe_followers.json")
        got = self.kinds([
            {"name": "twitter-用户推文-1792582217575.json", "file": tweets},
            {"name": "twitter-UserTweets-1792582217575.json", "file": tweets},
            {"name": "twitter-tweets-1792582217575.json", "file": tweets},
            {"name": "twitter-正在关注-1792582202463.json", "file": following},
            {"name": "twitter-Following-1792582202463.json", "file": following},
            {"name": "twitter-关注者-1792582196xxx.json", "file": followers},
            {"name": "twitter-Followers-1792582196123.json", "file": followers},
            {"name": "weekly.json", "file": tweets},
            {"name": "people.json", "file": following},
            {"name": "twitter-正在关注-1792582202463.json", "file": tweets},
        ])
        self.assertEqual(got["kinds"], [
            "tweets", "tweets", "tweets", "following", "following", "followers", "followers",
            "tweets", "ask-users", "following",
        ])
        self.assertEqual(got["needsChoice"], ["people.json"])

    def test_same_type_exports_are_merged_once(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        tweets = json.loads((ROOT / "tests/fixtures/twe_tweets.json").read_text(encoding="utf-8"))
        extra = dict(tweets[1])
        extra["id"] = "9100088"
        second_tweets = Path(folder.name) / "more-tweets.json"
        second_tweets.write_text(json.dumps(tweets + [extra]), encoding="utf-8")
        people = json.loads((ROOT / "tests/fixtures/twe_following.json").read_text(encoding="utf-8"))
        newbie = dict(people[-1])
        newbie["screen_name"] = "user_299"
        newbie["id"] = "9200099"
        second_following = Path(folder.name) / "more-following.json"
        second_following.write_text(json.dumps(people + [newbie]), encoding="utf-8")
        one = self.kinds([
            {"name": "twitter-用户推文-1792582217575.json", "file": str(ROOT / "tests/fixtures/twe_tweets.json"), "owner": "demo_owner"},
            {"name": "twitter-正在关注-1792582202463.json", "file": str(ROOT / "tests/fixtures/twe_following.json")},
        ])
        got = self.kinds([
            {"name": "twitter-用户推文-1792582217575.json", "file": str(ROOT / "tests/fixtures/twe_tweets.json"), "owner": "demo_owner"},
            {"name": "twitter-用户推文-1793000000000.json", "file": str(second_tweets), "owner": "demo_owner"},
            {"name": "twitter-正在关注-1792582202463.json", "file": str(ROOT / "tests/fixtures/twe_following.json")},
            {"name": "twitter-正在关注-1793000000000.json", "file": str(second_following)},
        ])
        self.assertEqual(got["tweetIds"], sorted(set(one["tweetIds"] + ["9100088"])))
        self.assertLess(len(got["tweetIds"]), len(one["tweetIds"]) * 2)
        self.assertEqual(got["following"], sorted(set(one["following"] + ["user_299"])))
        self.assertEqual(len(got["following"]), len(one["following"]) + 1)

    def board(self, rows, options):
        node = find_node()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        plan = Path(folder.name) / "board.json"
        plan.write_text(json.dumps({"rows": rows, "options": options}), encoding="utf-8")
        return json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "board", str(plan)], cwd=str(ROOT)))

    def test_tier_cards_jump_to_every_list(self):
        tiers = ["金牌", "银牌", "单向·他常来我少回", "单向·我常去他没回", "沉睡互关", "样本不足", "其他有分", "零互动"]
        rows = []
        for i in range(25):
            rows.append({"account": "acct_%02d" % i, "tier": "零互动", "status": "零互动",
                         "score": None, "action": "先看看", "mutual": False})
        rows.append({"account": "acct_gold", "tier": "金牌", "status": "ok", "score": 90, "stars": 5,
                     "action": "重点维护", "mutual": True})
        got = self.board(rows, {})
        html = got["html"]
        cards = html.split('class="grid stat-cards"')[0]
        self.assertEqual(re.findall(r'data-jump="([^"]+)"', cards), tiers)
        stat = html.split('class="grid stat-cards"')[1].split("</div></div>")[0]
        self.assertIn("互关", stat)
        self.assertIn("统计", stat)
        self.assertNotIn("data-jump", stat)
        self.assertIn('class="card tier-card empty" data-jump="银牌" data-count="0"', html)
        self.assertIn(">金牌（1）<", html)
        self.assertIn(">零互动（25）<", html)
        self.assertEqual(html.count("回到顶部"), 8)
        self.assertEqual(html.count("这一层暂时没有人"), 6)
        quiet = html.split('id="tier-零互动"')[1].split("<section")[0]
        self.assertIn('data-shown="20"', quiet)
        self.assertIn("展开全部", quiet)
        self.assertEqual(quiet.count("<tr>"), 21)
        self.assertIn("建议动作", quiet)
        bars = html.split("<h2>分层人数</h2>")[1].split("</div></div>")[0]
        self.assertEqual(re.findall(r'data-jump="([^"]+)"', bars), tiers)
        opened = self.board(rows, {"open": {"零互动": True}})["html"]
        full = opened.split('id="tier-零互动"')[1].split("<section")[0]
        self.assertNotIn("展开全部", full)
        self.assertEqual(full.count("<tr>"), 26)
        masked = self.board(rows, {"masked": True})["html"]
        self.assertNotIn("acct_", masked)
        self.assertIn("账号#01", masked.split('id="tier-零互动"')[1])
        self.assertIn("账号#26", masked.split('id="tier-金牌"')[1])
        self.assertEqual(got["empty"]["message"], "这一层暂时没有人")
        self.assertEqual(got["some"]["message"], "")
        self.assertTrue(got["empty"]["scroll"])

    def web_diff(self, parts, rows=None):
        node = find_node()
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        plan = Path(folder.name) / "diff.json"
        plan.write_text(json.dumps({"parts": parts, "rows": rows or []}, ensure_ascii=False), encoding="utf-8")
        return json.loads(subprocess.check_output(
            [node, str(ROOT / "tests/web_score_runner.mjs"), "diff", str(plan)], cwd=str(ROOT)))

    def test_follow_diff_matches_python_and_masks(self):
        page = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.assertIn('["prev-followers", "旧·关注者"]', page)
        self.assertIn('["prev-following", "旧·正在关注"]', page)
        self.assertIn("followDiffHtml(diff, {masked: state.masked", page)
        sample = self.web_diff([
            {"name": "followers.csv", "file": "sample_data/followers.csv", "kind": "followers"},
            {"name": "following.csv", "file": "sample_data/following.csv", "kind": "following"},
            {"name": "followers.csv", "file": "sample_data/prev/followers.csv", "kind": "prev-followers"},
            {"name": "following.csv", "file": "sample_data/prev/following.csv", "kind": "prev-following"},
        ], rows=[{"account": "user_03"}])
        py = follow_diff.compare_dirs(ROOT / "sample_data/prev", ROOT / "sample_data")
        for key, _label in follow_diff.GROUP_ORDER:
            web_pairs = [[item["id"], item["handle"]] for item in sample["diff"][key]]
            py_pairs = [[item["id"], item["handle"]] for item in py[key]]
            self.assertEqual(web_pairs, py_pairs)
        self.assertNotIn("user_90", sample["followers"])
        self.assertIn("user_03", sample["followers"])
        self.assertIn("账号#01", sample["masked"].split("新粉丝", 1)[1])
        self.assertNotIn("user_", sample["masked"])
        self.assertIn("@user_90", sample["open"])
        shifted = self.web_diff([
            {"name": "旧关注者.json", "file": "sample_data/id_shift/old/followers.json"},
            {"name": "关注者.json", "file": "sample_data/id_shift/new/followers.json"},
            {"name": "旧正在关注.json", "file": "sample_data/id_shift/old/following.json"},
            {"name": "正在关注.json", "file": "sample_data/id_shift/new/following.json"},
        ])
        py_shift = follow_diff.compare_dirs(ROOT / "sample_data/id_shift/old", ROOT / "sample_data/id_shift/new")
        for key, _label in follow_diff.GROUP_ORDER:
            web_pairs = [[item["id"], item["handle"]] for item in shifted["diff"][key]]
            py_pairs = [[item["id"], item["handle"]] for item in py_shift[key]]
            self.assertEqual(web_pairs, py_pairs, key)
        self.assertEqual(shifted["kinds"], ["prev-followers", "followers", "prev-following", "following"])
        self.assertNotIn("user_", shifted["masked"])
        self.assertNotIn("8800", shifted["masked"])
        self.assertIn("账号#01", shifted["masked"])
        left = shifted["masked"].split("取关我的（1）", 1)[1].split("新粉丝", 1)[0]
        right = shifted["masked"].split("新粉丝（1）", 1)[1].split("我取关的", 1)[0]
        self.assertNotEqual(re.search(r"账号#\d+", left).group(0), re.search(r"账号#\d+", right).group(0))
        self.assertIn("user_42（id 8800102）", shifted["open"])
        self.assertIn("user_42（id 8800109）", shifted["open"])
        self.assertNotIn("user_41", shifted["open"])
        chosen = self.web_diff([
            {"name": "people.json", "file": "tests/fixtures/twe_following.json", "kind": "prev-following"},
            {"name": "people.json", "file": "tests/fixtures/twe_following.json", "kind": "following"},
        ])
        self.assertEqual(chosen["kinds"], ["ask-users", "ask-users"])
        self.assertEqual(chosen["diff"]["i_unfollowed"], [])
        self.assertEqual(chosen["diff"]["i_followed"], [])
        self.assertNotIn("user_201", chosen["masked"])
