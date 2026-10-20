#!/usr/bin/env python3
"""生成 sample_data/ 里的假数据：20 个虚构账号（user_01 … user_20），覆盖各种星级和分层。
我 = me_demo。截止日 2026-10-19，区间 30 天。全部是编的，和任何真实账号无关。

  python3 sample_data/make_sample.py
"""
import csv
import os
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
END = date(2026, 10, 19)
TALK = ["这个思路挺有意思，我回头试试", "我上周也踩过这个坑，最后换了个办法", "数据能分享一下吗？想对比看看",
        "同意，关键还是坚持写", "这个工具我也在用，体验还行", "哈哈确实，我也是这么想的",
        "你说的第二点我不太同意，样本太少了", "已收藏，周末细看", "第一次听说，求个教程",
        "我那边结果差不多，涨得很慢"]
rows, tid = [], [100000]


def nid():
    tid[0] += 1
    return str(tid[0])


def ts(day_offset, minute):
    d = END - timedelta(days=day_offset)
    return f"{d.isoformat()}T{17 + minute // 60:02d}:{minute % 60:02d}:00Z"   # 约 10 点（UTC-7）


def add(acc, direction, day, minute, text, parent="", conv="", kind=""):
    t = nid()
    rows.append(dict(tweet_id=t, created_at=ts(day, minute), direction=direction, account=acc, text=text,
                     in_reply_to_status_id=parent, conversation_id=conv or t, parent_kind=kind))
    return t


def chain(acc, day, turns, first="in", greet_first=False):
    """一段真实回复链：first 方向先说（回我的帖或他的帖 = root），之后轮流接话。"""
    root = nid()  # 起点帖（不在表里）
    d, parent = first, root
    for k in range(turns):
        text = "早安" if (greet_first and k == 0) else TALK[(tid[0] + k) % len(TALK)]
        parent = add(acc, d, day if k < 2 else day - 1 if day > 0 else day, 10 * k, text, parent, root,
                     "root" if k == 0 else "")
        d = "out" if d == "in" else "in"


# 金牌
for wk in range(4):
    chain("user_01", 2 + 7 * wk, 4)                  # 4 周、每周一段 4 层回复链
for wk in range(3):
    chain("user_02", 3 + 7 * wk, 3, first="out")
for day in (4, 12, 19):
    chain("user_03", day, 3)
# 银牌
chain("user_04", 5, 3); chain("user_04", 15, 2, first="out")
for day, d in ((1, "out"), (6, "out"), (9, "in"), (13, "out"), (20, "out"), (22, "in")):
    add("user_05", d, day, 0, TALK[day % len(TALK)], nid(), "", "root")
chain("user_06", 8, 3, greet_first=True); add("user_06", "in", 18, 0, "早早早", nid(), "", "root")
add("user_06", "out", 18, 5, "早安", nid(), "", "root")
# 问候为主（问候上限）
for day in range(0, 30, 2):
    add("user_07", "in", day, 0, "早安☀️", nid(), "", "root")
    add("user_07", "out", day, 3, "早安", nid(), "", "root")
add("user_07", "in", 11, 30, "最近在看什么书？", nid(), "", "root")
# 单向：他常来我少回 / 我常去他没回
for day in (1, 5, 9, 16):
    add("user_08", "in", day, 0, TALK[day % len(TALK)], nid(), "", "root")
for day in (2, 3, 10, 17, 24):
    add("user_09", "out", day, 0, TALK[day % len(TALK)], nid(), "", "root")
# 样本不足
add("user_13", "in", 3, 0, "写得好", nid(), "", "root"); add("user_13", "out", 3, 5, "谢谢！", nid(), "", "root")
add("user_15", "in", 7, 0, "路过支持一下", nid(), "", "root")
# 有分但不到银牌
for day in (6, 14, 14):
    add("user_16", "out", day, len(rows) % 50, TALK[day % len(TALK)], nid(), "", "root")
add("user_16", "in", 25, 0, "嗯嗯", nid(), "", "root")
# 一条缺 in_reply_to 的回复（演示校验警告）
add("user_19", "in", 4, 0, "这个能开源吗？")
add("user_19", "out", 4, 8, "在整理了", nid(), "", "root")
add("user_19", "in", 11, 0, "期待！", nid(), "", "root")
# user_20：他回了 3 次，我回 1 次
for day in (2, 8, 21):
    add("user_20", "in", day, 0, TALK[(day + 3) % len(TALK)], nid(), "", "root")
add("user_20", "out", 8, 9, "对的", nid(), "", "root")
for r in rows:
    if r["account"] == "user_19" and r["text"] == "这个能开源吗？":
        r["in_reply_to_status_id"] = ""

with open(os.path.join(HERE, "replies.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["tweet_id", "created_at", "direction", "account", "text",
                                      "in_reply_to_status_id", "conversation_id", "parent_kind"])
    w.writeheader(); w.writerows(rows)

people = {f"user_{i:02d}": (f"示例账号{i:02d}", b) for i, b in enumerate(
    ["", "AI 工具和效率", "独立开发｜出海", "在东京生活", "读书笔记", "跨境电商", "每日打卡", "早安互关",
     "量化与投资", "摄影", "设计", "旅行", "美食", "程序员", "日常", "随便看看", "运营", "产品经理",
     "AI 绘画", "开源爱好者", "自媒体"], 0) if i}
following = ["user_01", "user_02", "user_04", "user_05", "user_06", "user_07", "user_09", "user_10", "user_11",
             "user_12", "user_16", "user_17", "user_19", "user_20"]
followers = ["user_01", "user_02", "user_03", "user_04", "user_05", "user_06", "user_07", "user_08", "user_10",
             "user_11", "user_12", "user_14", "user_18", "user_20"]
for fn, lst in (("following.csv", following), ("followers.csv", followers)):
    with open(os.path.join(HERE, fn), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["handle", "name", "bio"])
        for h in lst:
            w.writerow([h, *people[h]])
with open(os.path.join(HERE, "likes.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["account", "post_id", "post_created_at", "first_observed_at"])
    for k in range(4):
        w.writerow(["user_01", f"9000{k}", "2026-10-10T17:00:00Z", "2026-10-18T17:00:00Z"])
    for k in range(5):
        w.writerow(["user_14", f"9000{k}", "2026-10-10T17:00:00Z", "2026-10-18T17:00:00Z"])
    w.writerow(["user_08", "90009", "2025-03-01T17:00:00Z", "2026-10-18T17:00:00Z"])   # 旧帖：严格模式不计分
with open(os.path.join(HERE, "profiles.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["handle", "followers_count", "verified"])
    for i, (fc, v) in enumerate([(3200, 1), (850, 1), (4100, 1), (600, 0), (1200, 1), (300, 0), (90, 0), (450, 1),
                                 (2000, 0), (700, 1), (520, 1), (310, 0)], 1):
        w.writerow([f"user_{i:02d}", fc, v])
print(f"replies.csv {len(rows)} 行；following {len(following)}；followers {len(followers)}")
