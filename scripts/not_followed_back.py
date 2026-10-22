#!/usr/bin/env python3
"""我关注、对方没回关。离线、只读，不会取关或屏蔽。

有用户 ID 时按 ID 对齐，没有 ID 时用用户名。零互动的排在前面，然后按分数从低到高。
"""
import csv
from pathlib import Path

import follow_diff

MD_NAME = "没回关.md"
CSV_NAME = "没回关.csv"
SAFETY = "工具不会自动取关或屏蔽。要取关请手动、慢慢来。"
MISSING = "没有同时找到正在关注和关注者，没回关先不算。"
KEEP_HEADERS = {"handle", "user_id", "id", "id_str", "rest_id", "screen_name", "username", "账号"}


def profile_url(handle):
    if not handle:
        return ""
    return "https://x.com/" + handle


def parse_keep_text(text):
    ids, handles = set(), set()
    for line in (text or "").splitlines():
        token = line.strip()
        if not token or token.startswith("#"):
            continue
        token = token.strip(",").strip().strip('"').strip("'")
        if token.startswith("@"):
            token = token[1:].strip()
        if not token or token.lower() in KEEP_HEADERS:
            continue
        if token.isdigit():
            ids.add(token)
        else:
            handles.add(follow_diff.twe.norm(token))
    return ids, handles


def load_keep(path):
    if not path:
        return set(), set()
    file = Path(path).expanduser()
    try:
        if not file.is_file():
            raise OSError
        text = file.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        raise ValueError("保留名单读不了，请确认是否为文本文件") from None
    return parse_keep_text(text)


def interaction_count(row):
    if not row:
        return 0
    return int(row.get("raw") or 0) + int(row.get("L_in") or 0) + int(row.get("L_out") or 0)


def sort_key(item):
    score = item["score"]
    return (
        0 if item["interactions"] == 0 else 1,
        0 if score is None else 1,
        0 if score is None else score,
        item["handle"] or "",
        item["id"] or "",
    )


def assemble(following, followers, rows, keep_ids=(), keep_handles=()):
    """following / followers 是 follow_diff.index_accounts 的结果；缺一份就是还不能算。"""
    if following is None or followers is None:
        return {"ready": False, "items": None, "note": MISSING}
    by_handle = {row["account"]: row for row in rows or [] if row.get("account")}
    keep_ids, keep_handles = set(keep_ids), set(keep_handles)
    items = []
    for person in follow_diff.only_in(following, followers):
        if person["id"] and person["id"] in keep_ids:
            continue
        if person["handle"] and person["handle"] in keep_handles:
            continue
        row = by_handle.get(person["handle"])
        score = None
        tier = ""
        if row:
            if row.get("status") == "ok":
                score = row.get("score")
            tier = row.get("tier") or ""
        items.append({
            "id": person["id"],
            "handle": person["handle"],
            "interactions": interaction_count(row),
            "score": score,
            "tier": tier,
            "profile": profile_url(person["handle"]),
        })
    items.sort(key=sort_key)
    return {"ready": True, "items": items, "note": ""}


def build(lists_dir, rows, keep_path=None, indexes=None):
    if indexes is not None:
        following, followers = indexes
    elif not lists_dir:
        following = followers = None
    else:
        following = follow_diff.load_role(lists_dir, None, "following")
        followers = follow_diff.load_role(lists_dir, None, "followers")
    keep_ids, keep_handles = load_keep(keep_path)
    return assemble(following, followers, rows, keep_ids, keep_handles)


def score_text(item):
    if item["score"] is None:
        return "—"
    score = item["score"]
    return str(int(score)) if isinstance(score, float) and score.is_integer() else str(score)


def collisions_of(items):
    return follow_diff.collisions_of((items,))


def render_markdown(info):
    lines = ["# 没回关", "",
             "我关注了、对方没有回关。零互动的排在前面，然后按分数从低到高。",
             SAFETY, ""]
    if not info["ready"]:
        lines.extend([info["note"], ""])
        return "\n".join(lines)
    items = info["items"]
    lines.append(f"共 {len(items)} 个。")
    lines.append("")
    if not items:
        lines.extend(["（暂时没有）", ""])
        return "\n".join(lines)
    collisions = collisions_of(items)
    lines.extend(["| 账号 | 互动 | 分数 | 分层 | 主页 |", "| --- | --- | --- | --- | --- |"])
    for item in items:
        lines.append("| {who} | {n} | {score} | {tier} | {url} |".format(
            who=follow_diff.account_text(item, collisions), n=item["interactions"],
            score=score_text(item), tier=item["tier"] or "—", url=item["profile"] or "—"))
    lines.append("")
    return "\n".join(lines)


def render_csv(info):
    rows = []
    if info["ready"]:
        for item in info["items"]:
            rows.append({
                "handle": item["handle"],
                "user_id": item["id"],
                "interactions": item["interactions"],
                "score": "" if item["score"] is None else item["score"],
                "tier": item["tier"],
                "profile": item["profile"],
            })
    return rows


def ensure_writable(directory):
    """符号链接或目录不覆盖。目录还不存在时什么都不做。"""
    folder = Path(directory)
    if not folder.exists():
        return
    for name in (MD_NAME, CSV_NAME):
        path = folder / name
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError("结果文件不是普通文件，已停止，未作修改")


def write_private(directory, info):
    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    ensure_writable(folder)
    (folder / MD_NAME).write_text(render_markdown(info), encoding="utf-8")
    with (folder / CSV_NAME).open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=["handle", "user_id", "interactions", "score", "tier", "profile"])
        writer.writeheader()
        writer.writerows(render_csv(info))


def summary_line(info):
    if not info["ready"]:
        return "没回关 —"
    return f"没回关 {len(info['items'])}"
