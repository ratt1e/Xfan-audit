#!/usr/bin/env python3
"""通用列名映射：把任意导出工具的 CSV（例如 XPorter、XTract 或你自己写的脚本）
转成 fan_audit.py 的 handle,name,bio 格式。离线运行。

例：python3 adapters/generic_csv.py export.csv -o data/followers.csv \
        --handle-col username --name-col name --bio-col description
不确定列名时先运行：python3 adapters/generic_csv.py export.csv --show-columns
"""
import argparse, csv, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--handle-col", default="handle")
    ap.add_argument("--name-col", default="name")
    ap.add_argument("--bio-col", default="bio")
    ap.add_argument("--show-columns", action="store_true")
    a = ap.parse_args()
    with open(a.input, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    cols = list(rows[0].keys()) if rows else []
    if a.show_columns or not a.output:
        print("列名：", cols)
        return
    for c in (a.handle_col,):
        if c not in cols:
            sys.exit(f"找不到列 {c}，现有列：{cols}")
    seen, out = set(), []
    for r in rows:
        h = (r.get(a.handle_col) or "").strip().lstrip("@").lower()
        if not h or h in seen:
            continue
        seen.add(h)
        out.append({"handle": h, "name": (r.get(a.name_col) or "").strip(),
                    "bio": " ".join((r.get(a.bio_col) or "").replace("\\n", " ").split())})
    with open(a.output, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["handle", "name", "bio"])
        w.writeheader(); w.writerows(out)
    print(f"写出 {len(out)} 行 -> {a.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
