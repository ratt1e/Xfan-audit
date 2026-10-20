#!/usr/bin/env python3
"""X 官方账号归档（设置 → 你的账号 → 下载数据归档）→ replies.csv。离线运行。

归档里只有**你自己发的**推文，所以只能得到「我→他」方向（direction=out）；
「他→我」还得用 twitter-web-exporter 等工具补。follower.js / following.js 里只有数字 ID、没有用户名，
本脚本不处理名单。字段名按常见归档格式（tweets.js：window.YTD.tweets.part0 = [{"tweet": {...}}]），
X 改版后可能变化，待核实。

用法：
  python3 adapters/x_archive.py 归档解压目录/data/tweets.js -o data/replies_out.csv
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime


def load_js(path):
    with open(path, encoding="utf-8") as f:
        t = f.read()
    return json.loads(t[t.index("["):])


def iso(s):
    try:
        return datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y").strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return s or ""


def main(argv=None):
    ap = argparse.ArgumentParser(description="X 官方归档 tweets.js -> replies.csv（只有 我→他 方向）")
    ap.add_argument("tweets_js", nargs="+")
    ap.add_argument("-o", "--output", required=True)
    a = ap.parse_args(argv)
    rows = []
    for p in a.tweets_js:
        for item in load_js(p):
            t = item.get("tweet", item)
            target = (t.get("in_reply_to_screen_name") or "").lower()
            parent = t.get("in_reply_to_status_id_str") or ""
            if not parent or not target:
                continue
            rows.append({"tweet_id": t.get("id_str") or t.get("id"), "created_at": iso(t.get("created_at")),
                         "direction": "out", "account": target, "text": t.get("full_text") or t.get("text") or "",
                         "in_reply_to_status_id": parent, "conversation_id": "", "parent_kind": ""})
    os.makedirs(os.path.dirname(a.output) or ".", exist_ok=True)
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["tweet_id", "created_at", "direction", "account", "text",
                                          "in_reply_to_status_id", "conversation_id", "parent_kind"])
        w.writeheader()
        w.writerows(rows)
    print(f"写出 {len(rows)} 条我的回复 -> {a.output}（自己回自己的串推也会算在内，audit.py 会按 account 过滤掉你自己）",
          file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
