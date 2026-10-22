#!/usr/bin/env python3
"""对比两份关注 / 粉丝名单，列出取关和新关注。离线、只读。

有用户 ID（user_id、id_str、rest_id 或 id）时按 ID 对齐，对方改名也算同一个人。
没有 ID 时用用户名。两边都有 ID 且不相同，即使用户名一样也算两个人。

  python3 scripts/follow_diff.py --old ~/x-lists-old --new ~/x-lists --out ~/x-data/_关注变化

旧目录、新目录里可以放 following.csv / followers.csv，或 twitter-web-exporter 的 JSON。
账号名只写进 --out，终端只打印人数。
"""
import argparse
import csv
import json
import os
import sys
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "adapters"))
import twitter_web_exporter as twe  # noqa: E402

GROUP_ORDER = (
    ("unfollowed_me", "取关我的"),
    ("new_followers", "新粉丝"),
    ("i_unfollowed", "我取关的"),
    ("i_followed", "我新关注的"),
)
NOTE = "和上一份名单比。有用户 ID 时按 ID 对齐，没有就用用户名。只读，不会关注或取关。"
FOLLOWERS_NOTE = "没有同时找到旧的和新的关注者，取关我的和新粉丝先不算"
FOLLOWING_NOTE = "没有同时找到旧的和新的正在关注，我取关的和我新关注的先不算"
ID_KEYS = ("user_id", "id_str", "rest_id", "id")
HANDLE_KEYS = ("screen_name", "handle", "username")
EXACT = {
    "following": ("following.csv", "following.json"),
    "followers": ("followers.csv", "followers.json"),
}
HINTS = {
    "following": ("正在关注", "following"),
    "followers": ("关注者", "followers", "粉丝"),
}
EMPTY_ID = {"", "none", "null", "n/a", "undefined"}


def pick_id(record):
    for key in ID_KEYS:
        if key not in record or record[key] in (None, ""):
            continue
        text = str(record[key]).strip()
        if text.lower() in EMPTY_ID:
            continue
        return text
    return ""


def pick_handle(record):
    for key in HANDLE_KEYS:
        if record.get(key):
            return twe.norm(str(record[key]))
    return ""


def pick_name(record):
    return " ".join(str(record.get("name") or "").replace("\\n", " ").split())


def index_accounts(records):
    """同一份名单里按 ID 去重；没有 ID 的再用用户名去重。"""
    items, by_id, by_handle = [], {}, {}
    for record in records:
        if not isinstance(record, dict):
            continue
        uid, handle = pick_id(record), pick_handle(record)
        if not uid and not handle:
            continue
        if uid and uid in by_id:
            continue
        if not uid and handle in by_handle:
            continue
        if uid and handle and handle in by_handle and not by_handle[handle]["id"]:
            item = by_handle[handle]
            item["id"] = uid
            by_id[uid] = item
            continue
        item = {"id": uid, "handle": handle, "name": pick_name(record)}
        if uid and handle and handle in by_handle and by_handle[handle]["id"] not in ("", uid):
            items.append(item)
            by_id[uid] = item
            continue
        items.append(item)
        if uid:
            by_id[uid] = item
        if handle and handle not in by_handle:
            by_handle[handle] = item
    return {"items": items, "by_id": by_id, "by_handle": by_handle}


def find_match(item, other):
    """有 ID 就按 ID。对不上、或其中一边没有 ID 时，才退回用户名。"""
    if item["id"] and item["id"] in other["by_id"]:
        return other["by_id"][item["id"]]
    handle = item["handle"]
    if not handle or handle not in other["by_handle"]:
        return None
    cand = other["by_handle"][handle]
    if item["id"] and cand["id"] and item["id"] != cand["id"]:
        return None
    return cand


def only_in(left, right):
    found = [item for item in left["items"] if not find_match(item, right)]
    found.sort(key=lambda item: (item["handle"], item["id"]))
    return found


def load_accounts(paths):
    records = []
    for path in paths:
        try:
            records.extend(twe.load_records(os.fspath(path)))
        except (OSError, UnicodeError, json.JSONDecodeError, csv.Error, ValueError):
            raise ValueError("有一份名单读不了，请确认是 JSON 或 CSV") from None
    return index_accounts(records)


def _name_matches(stem, role):
    low = stem.lower()
    return any(hint.lower() in low or hint in stem for hint in HINTS[role])


def find_role_files(directory, role):
    """精确文件名优先。没有 following.csv 时，再按文件名把插件 JSON 收进来。"""
    if not directory:
        return []
    folder = Path(directory).expanduser()
    if not folder.is_dir():
        return []
    exact = [folder / name for name in EXACT[role] if (folder / name).is_file()]
    csvs = [path for path in exact if path.suffix.lower() == ".csv"]
    if csvs:
        return csvs[:1]
    if exact:
        return exact[:1]
    matched = []
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        raise ValueError("有一份名单读不了，请确认是 JSON 或 CSV") from None
    for path in entries:
        if path.is_file() and path.suffix.lower() in (".csv", ".json") and _name_matches(path.stem, role):
            matched.append(path)
    named_csv = [path for path in matched if path.suffix.lower() == ".csv"]
    return named_csv or matched


def load_role(directory, explicit, role):
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise ValueError("有一份名单读不了，请确认是 JSON 或 CSV")
        return load_accounts([path])
    paths = find_role_files(directory, role)
    if not paths:
        return None
    return load_accounts(paths)


def collisions_of(groups):
    seen, bad = {}, set()
    for items in groups:
        for item in items or []:
            if not item["handle"] or not item["id"]:
                continue
            prev = seen.get(item["handle"])
            if prev and prev != item["id"]:
                bad.add(item["handle"])
            else:
                seen[item["handle"]] = item["id"]
    return bad


def compare_sources(old_dir=None, new_dir=None, old_following=None, old_followers=None,
                    new_following=None, new_followers=None):
    old_fer = load_role(old_dir, old_followers, "followers")
    new_fer = load_role(new_dir, new_followers, "followers")
    old_fol = load_role(old_dir, old_following, "following")
    new_fol = load_role(new_dir, new_following, "following")
    notes = []
    if old_fer is None or new_fer is None:
        unfollowed_me = new_followers_group = None
        notes.append(FOLLOWERS_NOTE)
    else:
        unfollowed_me = only_in(old_fer, new_fer)
        new_followers_group = only_in(new_fer, old_fer)
    if old_fol is None or new_fol is None:
        i_unfollowed = i_followed = None
        notes.append(FOLLOWING_NOTE)
    else:
        i_unfollowed = only_in(old_fol, new_fol)
        i_followed = only_in(new_fol, old_fol)
    groups = {
        "unfollowed_me": unfollowed_me,
        "new_followers": new_followers_group,
        "i_unfollowed": i_unfollowed,
        "i_followed": i_followed,
        "notes": notes,
        "collisions": collisions_of((unfollowed_me, new_followers_group, i_unfollowed, i_followed)),
    }
    groups["ready"] = any(groups[key] is not None for key, _label in GROUP_ORDER)
    return groups


def compare_dirs(old_dir, new_dir):
    return compare_sources(old_dir=old_dir, new_dir=new_dir)


def account_text(item, collisions, at=False):
    if item["handle"] and item["id"] and item["handle"] in collisions:
        body = f"{item['handle']}（id {item['id']}）"
    else:
        body = item["handle"] or item["id"]
    if at and body and not body.startswith("@"):
        return "@" + body
    return body


def public_key(item, collisions):
    if item["handle"] and item["id"] and item["handle"] in collisions:
        return item["handle"] + "#" + item["id"]
    return item["handle"] or item["id"]


def summary_line(diff):
    parts = []
    for key, label in GROUP_ORDER:
        items = diff[key]
        parts.append(label + " " + ("—" if items is None else str(len(items))))
    return "关注变化：" + "，".join(parts)


def render_markdown(diff):
    lines = ["# 关注变化", "", NOTE, ""]
    for note in diff["notes"]:
        lines.extend([note, ""])
    collisions = diff["collisions"]
    for key, label in GROUP_ORDER:
        items = diff[key]
        if items is None:
            lines.extend([f"## {label}", "", "先不算", ""])
            continue
        lines.extend([f"## {label}（{len(items)}）", ""])
        if not items:
            lines.append("（暂时没有）")
        else:
            for item in items:
                lines.append("- " + account_text(item, collisions))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_result(diff, out_dir):
    folder = Path(out_dir).expanduser()
    if folder.exists() and (folder.is_symlink() or not folder.is_dir()):
        raise ValueError("结果路径不是目录，已停止")
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "关注变化.md"
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("结果文件不是普通文件，已停止，没有改动")
    target.write_text(render_markdown(diff), encoding="utf-8")
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description="对比两份关注和粉丝名单（离线、只读）")
    ap.add_argument("--old", help="旧名单目录")
    ap.add_argument("--new", help="新名单目录")
    ap.add_argument("--old-following", help="旧的正在关注，JSON 或 CSV")
    ap.add_argument("--old-followers", help="旧的关注者，JSON 或 CSV")
    ap.add_argument("--new-following", help="新的正在关注，JSON 或 CSV")
    ap.add_argument("--new-followers", help="新的关注者，JSON 或 CSV")
    ap.add_argument("--out", required=True, help="结果目录。账号名只写在这里")
    args = ap.parse_args(argv)
    if not (args.old or args.old_following or args.old_followers):
        ap.error("请提供旧名单：--old 目录，或 --old-following / --old-followers")
    if not (args.new or args.new_following or args.new_followers):
        ap.error("请提供新名单：--new 目录，或 --new-following / --new-followers")
    if args.old and not Path(args.old).expanduser().is_dir():
        print("旧名单目录不存在，或不是目录", file=sys.stderr)
        return 1
    if args.new and not Path(args.new).expanduser().is_dir():
        print("新名单目录不存在，或不是目录", file=sys.stderr)
        return 1
    try:
        diff = compare_sources(
            old_dir=args.old, new_dir=args.new,
            old_following=args.old_following, old_followers=args.old_followers,
            new_following=args.new_following, new_followers=args.new_followers,
        )
        write_result(diff, args.out)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(summary_line(diff))
    print("账号名写在结果目录的关注变化.md")
    if not diff["ready"]:
        print("名单没齐，关注变化先不算", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
