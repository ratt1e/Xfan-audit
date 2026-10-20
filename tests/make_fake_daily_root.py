#!/usr/bin/env python3
"""把 examples/relationship/interactions.csv（虚构数据）拆成「Mac 每日数据目录」的样子，给 T02 做测试夹具。

  python3 make_fake_daily_root.py --src examples/relationship/interactions.csv --out /tmp/fake_daily

生成：
  /tmp/fake_daily/2026-09-20/private/interactions.csv
  /tmp/fake_daily/2026-09-21/private/interactions.csv  ...
  /tmp/fake_daily/2026-09-20/snapshot.json（只放条数，不含账号名）
每一天除了当天的行，还会故意带上前一天的全部行（模拟每晚采集的重叠），
所以「按 id/tweet_id 去重后合并」的结果应该和原始文件完全一致。
另外放一个 notes/ 目录和一个 bad-name/ 目录，验证读取时会跳过不是日期的文件夹。
"""
import argparse
import csv
import json
import os
from collections import OrderedDict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="examples/relationship/interactions.csv")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.src, encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        cols, rows = rd.fieldnames, list(rd)
    by_day = OrderedDict()
    for r in sorted(rows, key=lambda r: r["ts"] or r.get("first_observed_at") or ""):
        day = (r["ts"] or r.get("first_observed_at") or "")[:10] or "unknown"
        by_day.setdefault(day, []).append(r)
    prev = []
    for day, rs in by_day.items():
        d = os.path.join(a.out, day, "private")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "interactions.csv"), "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(prev + rs)
        with open(os.path.join(a.out, day, "snapshot.json"), "w", encoding="utf-8") as f:
            json.dump({"date": day, "interactions": len(prev + rs)}, f)
        prev = rs
    os.makedirs(os.path.join(a.out, "notes"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "bad-name", "private"), exist_ok=True)
    with open(os.path.join(a.out, "bad-name", "private", "interactions.csv"), "w", encoding="utf-8") as f:
        f.write("this,should,be,skipped\n")
    print(f"{len(by_day)} 天，原始 {len(rows)} 行 → {a.out}")


if __name__ == "__main__":
    main()
