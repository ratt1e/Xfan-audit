#!/usr/bin/env python3
"""把 twitter-web-exporter（https://github.com/prinsss/twitter-web-exporter）的导出文件
转换成 fan_audit.py 需要的 CSV。离线运行，不联网。

字段名依据该项目源码中的 exportKey（src/components/table/columns-user.tsx、
columns-tweet.tsx，核对于 2026-10-19，对应 v1.4.3）。上游改版后字段可能变化。

用法：
  # 1) 用户列表（Following / Followers / Verified Followers / Retweeters 页导出的 JSON 或 CSV）
  python3 adapters/twitter_web_exporter.py users following_export.json -o data/following.csv
  python3 adapters/twitter_web_exporter.py users followers_export.csv  -o data/followers.csv

  # 1.5) 回复 -> replies.csv（给 audit.py 打星用）
  python3 adapters/twitter_web_exporter.py replies tweets_export.json --owner my_handle -o data/replies.csv

  # 2) 互动：回复（在自己每条帖子的详情页滚动后导出的推文 JSON/CSV）
  #    + 转帖者 / 点赞者（每个文件对应一条帖子的用户列表导出）
  python3 adapters/twitter_web_exporter.py engagement --owner my_handle \
      --replies tweets_export.json --post-ids 123,456 \
      --retweeters rt_post1.json rt_post2.json \
      --likers likers_post1.json \
      -o data/engagement.csv
"""
import argparse, csv, json, os, sys
from collections import Counter

USER_KEYS = ("screen_name", "name", "description")


def norm(h):
    return (h or "").strip().lstrip("@").strip().lower()


def unescape(s):
    # 上游 CSV 导出把换行写成字面量 \n
    return " ".join(str(s or "").replace("\\n", " ").replace("\\r", " ").split())


def load_records(path):
    """读取 JSON（记录数组）或 CSV，返回 dict 列表。"""
    with open(path, encoding="utf-8-sig") as f:
        head = f.read(1)
        f.seek(0)
        if head in "[{":
            data = json.load(f)
            if isinstance(data, dict):
                data = data.get("data") or data.get("records") or [data]
            return [r for r in data if isinstance(r, dict)]
        return list(csv.DictReader(f))


def cmd_users(a):
    seen, rows, blank, dup = set(), [], 0, 0
    for path in a.inputs:
        for r in load_records(path):
            h = norm(r.get("screen_name"))
            if not h:
                blank += 1
                continue
            if h in seen:
                dup += 1
                continue
            if a.only_blue_verified and str(r.get("is_blue_verified")).lower() not in ("true", "1", "yes"):
                continue
            seen.add(h)
            rows.append({"handle": h, "name": unescape(r.get("name")), "bio": unescape(r.get("description")),
                         "followed_by": r.get("followed_by", ""), "following": r.get("following", ""),
                         "is_blue_verified": r.get("is_blue_verified", ""), "verified_type": r.get("verified_type", ""),
                         "followers_count": r.get("followers_count", ""), "friends_count": r.get("friends_count", "")})
    os.makedirs(os.path.dirname(a.output) or ".", exist_ok=True)
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["handle", "name", "bio"])
        w.writeheader()
        w.writerows(rows)
    print(f"users: 写出 {len(rows)} 个账号 -> {a.output}（空用户名 {blank}，重复 {dup}）", file=sys.stderr)


def count_users(files):
    c = Counter()
    for path in files or []:
        per_file = {norm(r.get("screen_name")) for r in load_records(path)} - {""}
        c.update(per_file)  # 每个文件代表一条帖子：同一账号在同一文件里只算一次
    return c


def cmd_engagement(a):
    owner = norm(a.owner)
    post_ids = {x.strip() for x in (a.post_ids or "").split(",") if x.strip()}
    replies = Counter()
    seen_ids = set()
    for path in a.replies or []:
        for t in load_records(path):
            tid = str(t.get("id") or "")
            if tid and tid in seen_ids:
                continue
            seen_ids.add(tid)
            h = norm(t.get("screen_name"))
            irt = str(t.get("in_reply_to") or "").strip()
            if not h or h == owner or not irt or irt.lower() in ("none", "null", "n/a"):
                continue
            if post_ids and irt not in post_ids:
                continue
            replies[h] += 1
    likes, reposts = count_users(a.likers), count_users(a.retweeters)
    likes.pop(owner, None); reposts.pop(owner, None)
    hs = sorted(set(replies) | set(likes) | set(reposts))
    os.makedirs(os.path.dirname(a.output) or ".", exist_ok=True)
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["handle", "likes", "replies", "quotes", "reposts"])
        for h in hs:
            w.writerow([h, likes[h], replies[h], 0, reposts[h]])
    print(f"engagement: {len(hs)} 个账号，点赞 {sum(likes.values())}，回复 {sum(replies.values())}，转帖 {sum(reposts.values())} -> {a.output}", file=sys.stderr)
    if not post_ids and a.replies:
        print("提示：没给 --post-ids，会把导出文件里所有「回复某条帖子」的推文都算进去（包括楼中楼）。", file=sys.stderr)


def cmd_replies(a):
    """推文导出 -> replies.csv（audit.py 的标准输入）。
    字段：id、created_at、full_text、screen_name、in_reply_to（父推文 id），conversation_id 和
    in_reply_to_screen_name 如果有就用（上游字段名待核实）。父推文也在导出里时，用它的作者判断方向。"""
    owner = norm(a.owner)
    recs, seen = [], set()
    for path in a.inputs:
        for t in load_records(path):
            tid = str(t.get("id") or t.get("rest_id") or "").strip()
            if tid and tid not in seen:
                seen.add(tid)
                recs.append(t)
    author = {str(t.get("id") or t.get("rest_id")): norm(t.get("screen_name")) for t in recs}
    rows, skipped = [], Counter()
    for t in recs:
        tid = str(t.get("id") or t.get("rest_id"))
        h = norm(t.get("screen_name"))
        parent = str(t.get("in_reply_to") or t.get("in_reply_to_status_id_str") or "").strip()
        if parent.lower() in ("none", "null", "n/a"):
            parent = ""
        if not parent:
            skipped["不是回复"] += 1
            continue
        target = norm(t.get("in_reply_to_screen_name")) or author.get(parent, "")
        if h == owner and target and target != owner:
            direction, acc = "out", target
        elif h != owner and target == owner:
            direction, acc = "in", h
        elif not target:
            skipped["父推文作者未知（把父帖也导出来就能判断）"] += 1
            continue
        else:
            skipped["自己串推或别人之间的楼中楼"] += 1
            continue
        rows.append({"tweet_id": tid, "created_at": t.get("created_at", ""), "direction": direction, "account": acc,
                     "text": unescape(t.get("full_text") or t.get("text")), "in_reply_to_status_id": parent,
                     "conversation_id": t.get("conversation_id") or t.get("conversation_id_str") or "", "parent_kind": ""})
    os.makedirs(os.path.dirname(a.output) or ".", exist_ok=True)
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["tweet_id", "created_at", "direction", "account", "text",
                                          "in_reply_to_status_id", "conversation_id", "parent_kind"])
        w.writeheader()
        w.writerows(rows)
    print(f"replies: 写出 {len(rows)} 条 -> {a.output}；跳过 {dict(skipped)}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="twitter-web-exporter -> fan_audit CSV")
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("users", help="用户列表 -> handle,name,bio")
    u.add_argument("inputs", nargs="+")
    u.add_argument("-o", "--output", required=True)
    u.add_argument("--only-blue-verified", action="store_true", help="只保留 is_blue_verified=true 的账号")
    u.set_defaults(func=cmd_users)
    e = sub.add_parser("engagement", help="回复/转帖/点赞 -> engagement.csv")
    e.add_argument("--owner", required=True, help="你自己的用户名（会被排除）")
    e.add_argument("--replies", nargs="*", help="推文导出文件（帖子详情页）")
    e.add_argument("--post-ids", help="只统计直接回复这些帖子 id 的推文，逗号分隔")
    e.add_argument("--retweeters", nargs="*", help="每个文件 = 一条帖子的转帖者列表")
    e.add_argument("--likers", nargs="*", help="每个文件 = 一条帖子的点赞者列表（上游暂未正式支持，见文档）")
    e.add_argument("-o", "--output", required=True)
    e.set_defaults(func=cmd_engagement)
    r = sub.add_parser("replies", help="推文导出 -> replies.csv（audit.py 用）")
    r.add_argument("inputs", nargs="+")
    r.add_argument("--owner", required=True, help="你自己的用户名")
    r.add_argument("-o", "--output", required=True)
    r.set_defaults(func=cmd_replies)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
