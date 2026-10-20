"""生成「互动关系星级」的虚构示例数据（全部为假账号，与真实账号无关）。
当前窗口：2026-09-20 ~ 2026-10-19（30 天）；上一窗口：2026-08-21 ~ 2026-09-19。我自己 = me_demo。
每条回复都有唯一的 tweet_id，并用 in_reply_to_status_id 连成回复链。"""
import csv
from datetime import datetime, timedelta

FIELDS = ["id", "tweet_id", "ts", "account", "direction", "type", "post_id", "conversation_id",
          "in_reply_to_status_id", "parent_kind", "text", "post_created_at", "first_observed_at", "observed_baseline"]
rows = []
_seq = [9000000]

def tid():
    _seq[0] += 1
    return str(_seq[0])

def reply(ts, acc, direction, conv, parent, text, parent_kind=""):
    """parent_kind：父推文不在本表时由适配器填写：root=对话起点帖；other=已采集但不是我和对方之间的互动（分支）；
    unknown=没采集到。父推文在本表里时留空，由评分程序自己查。"""
    t = tid()
    rows.append(dict(id=f"tw:{t}", tweet_id=t, ts=ts, account=acc, direction=direction, type="reply", post_id=t,
                     conversation_id=conv, in_reply_to_status_id=parent, parent_kind=parent_kind, text=text))
    return t

def like(acc, direction, post_id, post_created_at, observed, baseline=False):
    rows.append(dict(id=f"like:{direction}:{acc}:{post_id}", type="like", account=acc, direction=direction,
                     post_id=post_id, conversation_id=post_id, post_created_at=post_created_at,
                     first_observed_at=observed, observed_baseline="true" if baseline else ""))

def root(prefix):
    """对话起点帖（我的或对方的原帖），本身不是互动，不入表，只返回 ID。"""
    return prefix + tid()

day0 = datetime(2026, 9, 20)
OBS = "2026-10-19T23:00:00"          # 最近一次采集时间

# user_101 问候互刷：30 天，双方每天各 5 条「早安」（都是对对方当天原帖的回复）；他赞我 10 次
for k in range(30):
    d = day0 + timedelta(days=k)
    mine, his = root("me"), root("u101_")
    for j in range(5):
        reply(f"{d:%Y-%m-%d}T08:{j:02d}:00", "user_101", "in", mine, mine, "早安", "root")
        reply(f"{d:%Y-%m-%d}T08:{j:02d}:30", "user_101", "out", his, his, "早安", "root")
for k in range(10):
    p = root("me"); like("user_101", "in", p, f"2026-10-{k+1:02d}T07:00:00", OBS)

# user_102 问候单向：30 天，他每天 5 条「早安」，我不回；他赞我 10 次
for k in range(30):
    d = day0 + timedelta(days=k); mine = root("me")
    for j in range(5):
        reply(f"{d:%Y-%m-%d}T07:{j:02d}:00", "user_102", "in", mine, mine, "早安", "root")
for k in range(10):
    p = root("me"); like("user_102", "in", p, f"2026-10-{k+1:02d}T07:00:00", OBS)

# user_103 真朋友：4 个对话、跨 4 周，每个对话是一条 4 层的真实回复链（方向交替），后两条在第二天
talk_in = ["这个数据你是怎么统计的？我这边口径不太一样", "那点赞的时间你怎么处理？", "明白了，我回头也按这个跑一遍", "跑完了，零互动率比我想的高"]
talk_out = ["我按 conversation_id 搜的回复，点赞用的是 liking_users", "点赞没有时间，只能按观察时间算", "有问题随时说，我把脚本发你", "正常，很多关注是一波一波来的"]
for d, first in [("2026-09-21", "out"), ("2026-09-30", "in"), ("2026-10-07", "out"), ("2026-10-15", "in")]:
    base = datetime.fromisoformat(d)
    conv = root("u103_" if first == "out" else "me")      # 我先说话就是在他的原帖下，反之在我的原帖下
    parent, kind, dirn = conv, "root", first
    for j in range(4):
        ts = base + timedelta(days=j // 2, hours=20 + j % 2)
        parent = reply(f"{ts:%Y-%m-%dT%H:%M:%S}", "user_103", dirn, conv, parent,
                       (talk_out if dirn == "out" else talk_in)[j], kind)
        kind, dirn = "", ("in" if dirn == "out" else "out")
for k in range(4):
    like("user_103", "in", root("me"), f"2026-10-{k*3+2:02d}T07:00:00", OBS)
    like("user_103", "out", root("u103_"), f"2026-10-{k*3+3:02d}T07:00:00", OBS)
# user_103 上一窗口的历史（测趋势）
c0 = root("me")
h = reply("2026-09-02T20:00:00", "user_103", "in", c0, c0, "第一次看到你的帖子，写得挺细", "root")
reply("2026-09-02T21:00:00", "user_103", "out", c0, h, "谢谢，还在慢慢摸索")
c00 = root("me")
reply("2026-09-10T20:00:00", "user_103", "in", c00, c00, "这个榜单我也关注了", "root")

# user_104 我单方面：我在他 10 条原帖下回复（8 个日期、跨 4 周），他只回过我 1 次（真实回复链）
days_b = ["2026-09-22", "2026-09-23", "2026-09-29", "2026-10-01", "2026-10-02", "2026-10-06", "2026-10-09", "2026-10-13"]
first_reply = None
for k in range(10):
    conv = root("u104_")
    t = reply(f"{days_b[k % 8]}T{10 + k % 3}:00:00", "user_104", "out", conv, conv, "这个思路我之前也试过，换成本地模型会慢一些", "root")
    if k == 0: first_reply, first_conv = t, conv
reply("2026-09-22T12:00:00", "user_104", "in", first_conv, first_reply, "谢谢，回头我也试试本地模型")

# user_105 样本不足：同一天一来一回
c = root("me")
h = reply("2026-10-18T10:00:00", "user_105", "in", c, c, "这个工具开源了吗？", "root")
reply("2026-10-18T10:30:00", "user_105", "out", c, h, "准备开源，整理完就发")

# user_106 只有点赞：赞了我 8 条区间内的帖子
for k in range(8):
    like("user_106", "in", root("me"), f"2026-10-{k+5:02d}T06:00:00", OBS)

# user_107 分支不是往返：在第三方帖子 Z 的同一个对话里，方向交替出现，但我回的是他的 h0（他回复第三方的分支），
# 他回的是我的 m0（我回复第三方的另一个分支），互相都没有接对方的话；另有 1 条回复缺少 in_reply_to
Z = root("third_")
h0, m0 = root("u107_h0_"), root("me_m0_")
reply("2026-10-02T09:00:00", "user_107", "out", Z, h0, "你说的这个测试方法我不太同意，样本太小", "other")
reply("2026-10-03T09:00:00", "user_107", "in", Z, m0, "楼上这个数据我也看到过，来源是哪里？", "other")
reply("2026-10-05T09:00:00", "user_107", "out", Z, h0, "补充一下，换个时间段结果会不一样", "other")
reply("2026-10-06T09:00:00", "user_107", "in", Z, m0, "你这个截图是哪个版本的？", "other")
c = root("me")
reply("2026-10-09T09:00:00", "user_107", "in", c, "", "这个系列还会继续写吗", "unknown")

# user_108 旧帖今天被赞：他在 3 天里各回复我一次（没有来回）；今天（10-18 采集时）发现他赞了我 6 条 2025 年的旧帖
for d in ["2026-09-25", "2026-10-04", "2026-10-12"]:
    c = root("me"); reply(f"{d}T15:00:00", "user_108", "in", c, c, "这篇收藏了，回头细看", "root")
for k in range(6):
    like("user_108", "in", root("me"), f"2025-0{k+1}-15T10:00:00", "2026-10-18T22:00:00")

# 重复捕获：同一条推文被导出两次（tweet_id 相同、内容相同），用来测试去重和校验警告
dup = next(r for r in rows if r["account"] == "user_103" and r["type"] == "reply")
rows.append(dict(dup))

with open("interactions.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=FIELDS, restval=""); w.writeheader(); w.writerows(rows)
print(len(rows), "rows")
