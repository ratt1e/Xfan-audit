#!/usr/bin/env python3
"""对比两份关注 / 粉丝名单，列出取关和新关注。离线、只读。

有用户 ID（user_id、id_str、rest_id 或 id）时按 ID 对齐，对方改名也算同一个人。
没有 ID 时用用户名。两边都有 ID 且不相同，即使用户名一样也算两个人。

  python3 scripts/follow_diff.py --old ~/x-lists-old --new ~/x-lists --out ~/x-data/_关注变化

旧目录、新目录里可以放 following.csv / followers.csv，或 twitter-web-exporter 的 JSON。
账号名只写进 --out，终端只打印人数。
这份对比不按天切分，所以没有时区参数。
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
from datetime import datetime
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
SNAPSHOT_NAME = "lists_snapshot.json"
SUMMARY_NAME = "follow_summary.json"
EXPORT_GAP_MS = 12 * 60 * 60 * 1000
WAITING_NOTE = "只有一份名单，下次导出后会自动对比。"


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
            raise ValueError("名单文件读取失败，请确认是否为有效的 JSON 或 CSV 文件") from None
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
        raise ValueError("名单文件读取失败，请确认是否为有效的 JSON 或 CSV 文件") from None
    for path in entries:
        if path.is_file() and path.suffix.lower() in (".csv", ".json") and _name_matches(path.stem, role):
            matched.append(path)
    named_csv = [path for path in matched if path.suffix.lower() == ".csv"]
    return named_csv or matched


def load_role(directory, explicit, role):
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise ValueError("名单文件读取失败，请确认是否为有效的 JSON 或 CSV 文件")
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


def compare_indexed(old_fol, new_fol, old_fer, new_fer):
    """已经读好的名单。某一边是 None 表示这个角色缺文件，对应的两组先不算。"""
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
    groups["auto"] = {"waiting": False, "kept": False, "note": "", "from": "", "to": ""}
    return groups


def compare_sources(old_dir=None, new_dir=None, old_following=None, old_followers=None,
                    new_following=None, new_followers=None):
    return compare_indexed(
        load_role(old_dir, old_following, "following"),
        load_role(new_dir, new_following, "following"),
        load_role(old_dir, old_followers, "followers"),
        load_role(new_dir, new_followers, "followers"),
    )


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


def export_stamp(path):
    """文件名里的 13 位毫秒优先，否则用文件修改时间。"""
    found = re.findall(r"(?<!\d)(\d{13})(?!\d)", path.name)
    if found:
        return int(found[-1])
    try:
        return int(path.stat().st_mtime * 1000)
    except OSError:
        return 0


def format_stamp(stamp):
    return datetime.fromtimestamp(stamp / 1000).strftime("%Y-%m-%d %H:%M")


def compared_note(old_label, new_label):
    return "对比的是 %s → %s。" % (old_label, new_label)


def kept_note(old_label, new_label):
    return "关系文件没有新的导出，沿用 %s → %s 的对比。" % (old_label, new_label)


def role_export_files(directory, role):
    """同一层里这个角色的全部名单。不进子目录，也不跟随符号链接。"""
    if not directory:
        return []
    folder = Path(directory).expanduser()
    if not folder.is_dir():
        return []
    matched = []
    try:
        entries = sorted(folder.iterdir(), key=lambda item: item.name)
    except OSError:
        raise ValueError("名单文件读取失败，请确认是否为有效的 JSON 或 CSV 文件") from None
    for path in entries:
        if path.is_symlink() or not path.is_file():
            continue
        if path.suffix.lower() not in (".csv", ".json"):
            continue
        if path.name in EXACT[role] or _name_matches(path.stem, role):
            matched.append(path)
    return matched


def collapse_role(paths):
    """12 小时内的同一角色收成一次导出，同一次里优先用 CSV。"""
    stamped = [(export_stamp(path), path) for path in paths]
    stamped.sort(key=lambda item: (item[0], item[1].name))
    if not stamped:
        return []
    clusters = [[stamped[0]]]
    for stamp, path in stamped[1:]:
        if stamp - clusters[-1][-1][0] <= EXPORT_GAP_MS:
            clusters[-1].append((stamp, path))
        else:
            clusters.append([(stamp, path)])
    sessions = []
    for cluster in clusters:
        csvs = [item for item in cluster if item[1].suffix.lower() == ".csv"]
        chosen = max(csvs or cluster, key=lambda item: (item[0], item[1].name))
        sessions.append(chosen)
    sessions.sort(key=lambda item: (item[0], item[1].name), reverse=True)
    return sessions


def build_generations(directory):
    """按新旧把两个角色配成一代。最新的正在关注配最新的关注者，只看各自第几新，不按两个角色的时间互相拆开。"""
    following = collapse_role(role_export_files(directory, "following"))
    followers = collapse_role(role_export_files(directory, "followers"))
    generations = []
    for index in range(max(len(following), len(followers))):
        left = following[index] if index < len(following) else None
        right = followers[index] if index < len(followers) else None
        stamps = [item[0] for item in (left, right) if item]
        stamp = max(stamps) if stamps else 0
        generations.append({
            "stamp": stamp,
            "label": format_stamp(stamp) if stamps else "",
            "following": left[1] if left else None,
            "followers": right[1] if right else None,
        })
    return generations


def fingerprint_of(generation):
    parts = []
    for role in ("following", "followers"):
        path = generation.get(role)
        if path is None:
            continue
        stat = path.stat()
        parts.append("%s|%s|%s|%s" % (role, path.name, stat.st_size, getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1e9))))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def items_from_index(indexed):
    if indexed is None:
        return None
    return [{"id": item.get("id") or "", "handle": item.get("handle") or ""} for item in indexed["items"]]


def index_from_rows(rows):
    if rows is None:
        return None
    if not isinstance(rows, list):
        return None
    return index_accounts(rows)


def load_generation(generation):
    following = load_accounts([generation["following"]]) if generation.get("following") else None
    followers = load_accounts([generation["followers"]]) if generation.get("followers") else None
    return following, followers


def generation_record(generation, following, followers):
    return {
        "label": generation.get("label") or "",
        "stamp": generation.get("stamp") or 0,
        "following": items_from_index(following),
        "followers": items_from_index(followers),
    }


def empty_snapshot():
    return {"version": 1, "fingerprint": "", "latest": None, "baseline": None}


def read_snapshot(path):
    target = Path(path)
    if target.is_symlink() or not target.is_file():
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != 1:
        return None
    latest, baseline = data.get("latest"), data.get("baseline")
    if latest is not None and not isinstance(latest, dict):
        return None
    if baseline is not None and not isinstance(baseline, dict):
        return None
    return {
        "version": 1,
        "fingerprint": str(data.get("fingerprint") or ""),
        "latest": latest,
        "baseline": baseline,
    }


def write_json_file(path, payload):
    target = Path(path)
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("结果文件不是普通文件，已停止，未作修改")
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def summary_payload(diff):
    auto = (diff or {}).get("auto") or {}
    body = {
        "version": 1,
        "from": auto.get("from") or "",
        "to": auto.get("to") or "",
        "waiting": bool(auto.get("waiting")),
        "kept": bool(auto.get("kept")),
        "note": auto.get("note") or "",
    }
    for key, _label in GROUP_ORDER:
        if not diff:
            body[key] = None
        else:
            items = diff.get(key)
            body[key] = None if items is None else len(items)
    return body


def _with_note(diff, note, auto):
    diff["notes"].insert(0, note)
    diff["auto"] = auto
    return diff


def waiting_diff():
    return {
        "unfollowed_me": None,
        "new_followers": None,
        "i_unfollowed": None,
        "i_followed": None,
        "notes": [WAITING_NOTE],
        "collisions": set(),
        "ready": True,
        "auto": {"waiting": True, "kept": False, "note": WAITING_NOTE, "from": "", "to": ""},
    }


def _canonical(path, filename):
    if path is None:
        return False
    try:
        resolved = path.resolve()
    except OSError:
        return False
    return resolved.name == filename and resolved.is_file()


def apply_latest(data, scan):
    """计分只用最新一代。已经读过的 following.csv / followers.csv 保留认证和粉丝数。"""
    generations = scan["generations"]
    if not generations:
        return
    latest = generations[0]
    following, followers = latest["following_index"], latest["followers_index"]

    def install(role, indexed, filename):
        if indexed is None:
            return
        if _canonical(latest.get(role), filename) and data.get(role):
            return
        mapping = {}
        for item in indexed["items"]:
            handle = item.get("handle") or ""
            if not handle:
                continue
            mapping[handle] = {"handle": handle, "user_id": item.get("id") or "", "name": item.get("name") or ""}
        data[role] = mapping

    install("following", following, "following.csv")
    install("followers", followers, "followers.csv")
    if latest.get("following") and latest.get("followers"):
        data["warnings"] = [
            item for item in (data.get("warnings") or [])
            if "following.csv" not in item and "followers.csv" not in item
        ]
        coverage = data.get("coverage")
        if isinstance(coverage, dict):
            coverage["lists_complete"] = True


def scan_lists(directory):
    folder = Path(directory).expanduser()
    if not folder.is_dir():
        raise ValueError("名单目录不存在，或不是目录")
    loaded = []
    for generation in build_generations(folder):
        following, followers = load_generation(generation)
        item = dict(generation)
        item["following_index"] = following
        item["followers_index"] = followers
        loaded.append(item)
    fingerprint = fingerprint_of(loaded[0]) if loaded else ""
    latest_pair = (loaded[0]["following_index"], loaded[0]["followers_index"]) if loaded else (None, None)
    return {"generations": loaded, "fingerprint": fingerprint, "latest_pair": latest_pair}


def _bundle(following, followers, prev_following, prev_followers):
    return {
        "following": items_from_index(following),
        "followers": items_from_index(followers),
        "prev_following": items_from_index(prev_following),
        "prev_followers": items_from_index(prev_followers),
    }


def resolve_scanned(scan, snapshot):
    """目录里有两代及以上时以目录为准。只有一代时，文件变了就和快照里的上一份比；文件没变就沿用上次的对比。"""
    generations = scan["generations"]
    snap = snapshot if isinstance(snapshot, dict) else None
    if not generations:
        return {"diff": None, "snapshot": empty_snapshot(), "bundle": _bundle(None, None, None, None)}
    latest = generations[0]
    following, followers = latest["following_index"], latest["followers_index"]
    fingerprint = scan["fingerprint"]
    if len(generations) >= 2:
        older = generations[1]
        note = compared_note(older["label"], latest["label"])
        diff = _with_note(
            compare_indexed(older["following_index"], following, older["followers_index"], followers),
            note,
            {"waiting": False, "kept": False, "note": note, "from": older["label"], "to": latest["label"]},
        )
        saved = {
            "version": 1,
            "fingerprint": fingerprint,
            "latest": generation_record(latest, following, followers),
            "baseline": generation_record(older, older["following_index"], older["followers_index"]),
        }
        return {
            "diff": diff,
            "snapshot": saved,
            "bundle": _bundle(following, followers, older["following_index"], older["followers_index"]),
        }
    if snap and snap.get("fingerprint") == fingerprint and snap.get("baseline"):
        baseline = snap["baseline"]
        old_following = index_from_rows(baseline.get("following"))
        old_followers = index_from_rows(baseline.get("followers"))
        old_label = baseline.get("label") or ""
        new_label = (snap.get("latest") or {}).get("label") or latest["label"]
        note = kept_note(old_label, new_label)
        diff = _with_note(
            compare_indexed(old_following, following, old_followers, followers),
            note,
            {"waiting": False, "kept": True, "note": note, "from": old_label, "to": new_label},
        )
        saved = {
            "version": 1,
            "fingerprint": snap.get("fingerprint") or fingerprint,
            "latest": snap.get("latest"),
            "baseline": baseline,
        }
        return {"diff": diff, "snapshot": saved, "bundle": _bundle(following, followers, old_following, old_followers)}
    if snap and snap.get("latest") and (snap.get("fingerprint") or "") != fingerprint:
        previous = snap["latest"]
        old_following = index_from_rows(previous.get("following"))
        old_followers = index_from_rows(previous.get("followers"))
        old_label = previous.get("label") or ""
        note = compared_note(old_label, latest["label"])
        diff = _with_note(
            compare_indexed(old_following, following, old_followers, followers),
            note,
            {"waiting": False, "kept": False, "note": note, "from": old_label, "to": latest["label"]},
        )
        saved = {
            "version": 1,
            "fingerprint": fingerprint,
            "latest": generation_record(latest, following, followers),
            "baseline": previous,
        }
        return {"diff": diff, "snapshot": saved, "bundle": _bundle(following, followers, old_following, old_followers)}
    diff = waiting_diff()
    saved = {
        "version": 1,
        "fingerprint": fingerprint,
        "latest": generation_record(latest, following, followers),
        "baseline": None,
    }
    return {"diff": diff, "snapshot": saved, "bundle": _bundle(following, followers, None, None)}


def write_result(diff, out_dir):
    folder = Path(out_dir).expanduser()
    if folder.exists() and (folder.is_symlink() or not folder.is_dir()):
        raise ValueError("结果路径不是目录，已停止")
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "关注变化.md"
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("结果文件不是普通文件，已停止，未作修改")
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
    print("具体账号名单已写入输出目录的关注变化.md")
    if not diff["ready"]:
        print("名单不完整，暂不计算关注变化", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
