"""daily_collect.py 的测试。全部是虚构数据（me_demo / user_001 …），不联网。

运行：python3 -m unittest discover -s tests
"""
import csv
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import daily_collect as dc  # noqa: E402

ME = "100"
USERS = [{"id": "100", "username": "me_demo", "name": "Me"},
         {"id": "201", "username": "user_001", "name": "U1"},
         {"id": "202", "username": "user_002", "name": "U2"},
         {"id": "299", "username": "grok", "name": "Grok"}]


def tw(tid, author, ts, text, irt_user=None, parent=None, conv=None, quoted=None):
    t = {"id": tid, "author_id": author, "created_at": ts, "text": text}
    refs = []
    if parent:
        refs.append({"type": "replied_to", "id": parent})
    if quoted:
        refs.append({"type": "quoted", "id": quoted})
    if refs:
        t["referenced_tweets"] = refs
    if irt_user:
        t["in_reply_to_user_id"] = irt_user
    if conv:
        t["conversation_id"] = conv
    return t


def page(data, next_token=None, inc_tweets=None):
    meta = {"result_count": len(data)}
    if next_token:
        meta["next_token"] = next_token
    d = {"data": data, "includes": {"users": USERS}, "meta": meta}
    if inc_tweets:
        d["includes"]["tweets"] = inc_tweets
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.raw = os.path.join(self.root, "private", "daily", "2026-10-19")
        self.snap = os.path.join(self.root, "daily", "2026-10-19")
        os.makedirs(self.raw)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, obj, prefix=""):
        with open(os.path.join(self.raw, name), "w", encoding="utf-8") as f:
            f.write(prefix + json.dumps(obj, ensure_ascii=False))

    def run_dc(self, observed="2026-10-19T14:00:00Z", raw=None, extra=()):
        dc.main(["--raw-dir", raw or self.raw, "--me-id", ME, "--me", "me_demo",
                 "--snapshot-dir", self.snap, "--observed-at", observed, *extra])
        with open(os.path.join(raw or self.raw, "interactions.csv"), encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        with open(os.path.join(self.snap, "snapshot.json"), encoding="utf-8") as f:
            snap = json.load(f)
        return {r["id"]: r for r in rows}, snap


class TestConvert(Base):
    def setUp(self):
        super().setUp()
        # 我的原创帖 1000；user_001 回我（2001）；我接他（1001，posts 缺 conversation_id）；他再接我（2002）
        posts = [
            tw("1000", ME, "2026-10-18T10:00:00Z", "今天的帖子", conv="1000"),
            tw("1001", ME, "2026-10-18T11:00:00Z", "@user_001 对，我也这么觉得，回头试试", irt_user="201", parent="2001"),
            tw("1002", ME, "2026-10-18T12:00:00Z", "@user_002 早安", irt_user="202", parent="3000"),   # 父帖没采到 → unknown, conv 待核实
            tw("1003", ME, "2026-10-18T12:30:00Z", "补充一下", irt_user=ME, parent="1000"),             # 自己串推 → 丢弃
            tw("1004", ME, "2026-10-18T13:00:00Z", "这个说得好", quoted="4000"),                        # 引用别人
        ]
        mentions = [
            tw("2001", "201", "2026-10-18T10:30:00Z", "@me_demo 这个方法我用过，效果不错", irt_user=ME, parent="1000", conv="1000"),
            tw("2002", "201", "2026-10-18T11:30:00Z", "@me_demo 那你试完告诉我结果", irt_user=ME, parent="1001", conv="1000"),
            tw("2003", "299", "2026-10-18T11:40:00Z", "@me_demo 自动回复", irt_user=ME, parent="1000", conv="1000"),  # grok → 排除
            tw("2004", "202", "2026-10-18T12:40:00Z", "@me_demo @user_001 你们聊", irt_user="201", parent="2001", conv="1000"),  # 他人楼中楼
        ]
        inc = [tw("4000", "202", "2026-10-17T09:00:00Z", "原帖")]
        self.write("posts_p1.json", page(posts[:3], next_token="abc", inc_tweets=inc))
        self.write("posts_p2.json", page(posts[2:], inc_tweets=inc))   # 1002 重复出现
        self.write("mentions_p1.json", page(mentions), prefix="工具附加文字\n")
        self.write("mentions_since.json", {"meta": {"result_count": 0}})

    def test_rows(self):
        rows, snap = self.run_dc()
        self.assertEqual(set(rows), {"tw:1001", "tw:1002", "tw:1004", "tw:2001", "tw:2002"})
        r = rows["tw:1001"]
        self.assertEqual((r["direction"], r["type"], r["account"]), ("out", "reply", "user_001"))
        self.assertEqual(r["in_reply_to_status_id"], "2001")
        self.assertEqual(r["conversation_id"], "1000")           # 用同链另一侧补上
        self.assertEqual(r["parent_kind"], "")                   # 父帖在表里
        self.assertEqual(rows["tw:2001"]["parent_kind"], "root")
        self.assertEqual(rows["tw:1002"]["parent_kind"], "unknown")
        self.assertEqual(rows["tw:1002"]["conversation_id"], dc.PENDING)
        self.assertEqual(rows["tw:1002"]["is_greeting"], "true")
        self.assertEqual(rows["tw:1004"]["type"], "quote")
        self.assertEqual(rows["tw:1004"]["account"], "user_002")
        self.assertEqual(snap["chains"]["links_reply_to_other_side"], 2)   # 1001→2001, 2002→1001
        self.assertEqual(snap["chains"]["substantive_rounds"], 2)
        self.assertEqual(snap["discarded"]["丢弃_自己串推"], 1)
        self.assertEqual(snap["discarded"]["丢弃_排除账号"], 1)
        self.assertEqual(snap["discarded"]["丢弃_他人之间的楼中楼"], 1)

    def test_warnings(self):
        _, snap = self.run_dc()
        w = "\n".join(snap["warnings"])
        self.assertIn("重复 tweet_id 1 条", w)
        self.assertIn("conversation_id 补不上", w)
        self.assertIn("父帖没采集到", w)
        self.assertIn("空页：mentions_since.json", w)
        self.assertIn("posts 原始数据缺 conversation_id", w)

    def test_idempotent(self):
        self.run_dc()
        with open(os.path.join(self.raw, "interactions.csv"), encoding="utf-8") as f:
            a = f.read()
        self.run_dc()
        with open(os.path.join(self.raw, "interactions.csv"), encoding="utf-8") as f:
            b = f.read()
        self.assertEqual(a, b)

    def test_snapshot_has_no_handles(self):
        self.run_dc()
        with open(os.path.join(self.snap, "snapshot.json"), encoding="utf-8") as f:
            text = f.read()
        for u in USERS:
            self.assertNotIn(u["username"], text)

    def test_state_since_id(self):
        self.run_dc()
        with open(os.path.join(os.path.dirname(self.raw), "state.json"), encoding="utf-8") as f:
            st = json.load(f)
        self.assertEqual(st["newest_id"], {"posts": "1004", "mentions": "2004"})


class TestWindowAndPages(Base):
    def test_misaligned_and_empty_page_with_next(self):
        self.write("posts_p1.json", page([tw("1001", ME, "2026-10-17T10:00:00Z", "@user_001 好的", irt_user="201", parent="2001")]))
        self.write("mentions_p1.json", page([tw("2001", "201", "2026-10-18T20:00:00Z", "@me_demo 嗯", irt_user=ME, parent="1000", conv="1000")]))
        self.write("mentions_p2.json", {"meta": {"result_count": 0, "next_token": "zzz"}})
        _, snap = self.run_dc(extra=("--window-hours", "48"))
        w = "\n".join(snap["warnings"])
        self.assertIn("两个方向起点相差", w)
        self.assertIn("空页但还有 next_token", w)
        self.assertIn("对齐窗口只有", w)

    def test_missing_parent(self):
        self.write("mentions_p1.json", page([tw("2001", "201", "2026-10-18T20:00:00Z", "@me_demo 好文", irt_user=ME, conv="1000")]))
        _, snap = self.run_dc()
        self.assertIn("1 条回复缺少 in_reply_to_status_id", "\n".join(snap["warnings"]))
        self.assertIn("mentions 原始数据缺 replied_to(回复中)", "\n".join(snap["warnings"]))


class TestLikes(Base):
    def test_first_observed_keeps_earliest(self):
        post = tw("1000", ME, "2026-10-18T10:00:00Z", "帖子", conv="1000")
        self.write("posts_p1.json", page([post]))
        likers = {"data": [{"id": "201", "username": "user_001"}], "meta": {"result_count": 1}}
        self.write("likers_1000.json", likers)
        rows, _ = self.run_dc(observed="2026-10-19T14:00:00Z")
        r = rows["like:in:201:1000"]
        self.assertEqual(r["first_observed_at"], "2026-10-19T14:00:00Z")
        self.assertEqual(r["observed_baseline"], "true")       # 第一次采这个列表
        self.assertEqual(r["post_created_at"], "2026-10-18T10:00:00Z")
        # 第二天再采：保留最早的 first_observed_at；新出现的赞不是 baseline
        raw2 = os.path.join(os.path.dirname(self.raw), "2026-10-20")
        os.makedirs(raw2)
        with open(os.path.join(raw2, "posts_p1.json"), "w") as f:
            json.dump(page([post]), f)
        likers["data"].append({"id": "202", "username": "user_002"})
        with open(os.path.join(raw2, "likers_1000.json"), "w") as f:
            json.dump(likers, f)
        rows2, _ = self.run_dc(observed="2026-10-20T14:00:00Z", raw=raw2)
        self.assertEqual(rows2["like:in:201:1000"]["first_observed_at"], "2026-10-19T14:00:00Z")
        self.assertEqual(rows2["like:in:201:1000"]["observed_baseline"], "true")
        self.assertEqual(rows2["like:in:202:1000"]["first_observed_at"], "2026-10-20T14:00:00Z")
        self.assertEqual(rows2["like:in:202:1000"]["observed_baseline"], "false")

    def test_like_missing_post_time_warns(self):
        self.write("likers_9999.json", {"data": [{"id": "201", "username": "user_001"}], "meta": {"result_count": 1}})
        _, snap = self.run_dc()
        self.assertIn("点赞时间信息不全", "\n".join(snap["warnings"]))


class TestGreeting(unittest.TestCase):
    W = dc.load_greetings(os.path.join(os.path.dirname(__file__), "..", "config.json"))

    def test_cases(self):
        g = lambda s: dc.is_greeting(s, self.W)
        self.assertTrue(g("☀️☀️"))
        self.assertTrue(g("早安呀 @me_demo"))
        self.assertFalse(g("早安，昨天你说的那个本地模型我试了，速度确实慢不少"))
        self.assertTrue(g("GM!"))
        self.assertFalse(g("gmail 登不上了"))
        self.assertTrue(g("来咯来咯"))
        self.assertTrue(g("@user_001 串门来咯"))
        self.assertFalse(g("未来来了？"))                  # 「来了」只做开头匹配
        self.assertFalse(g("哇塞你好厉害"))
        self.assertTrue(g("你好呀"))


if __name__ == "__main__":
    unittest.main()
