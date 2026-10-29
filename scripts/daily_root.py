"""只读合并日期目录；不推断缺失的对话字段，不复制任何输入文件。"""
import csv
from datetime import date, timedelta
import math
from pathlib import Path
import re

OUTPUT_NAMES = ("accounts.csv", "dashboard.html", "dashboard_public.html", "follow_summary.json", "lists_snapshot.json", "名单.md", "没回关.md", "没回关.csv")


def norm(value):
    return (value or "").strip().lstrip("@").lower()


def _js_round(value):
    """和名单展示里的 Math.round 对齐：正数 .5 向上。"""
    if value >= 0:
        return int(math.floor(value + 0.5))
    return int(math.ceil(value - 0.5))


def revisit_text(row):
    """回访率只用于展示，不参与打分，也不改变星级门槛。

    分子 I_raw：对方回复我的条数，含问候。
    分母 O_raw：我发给对方的条数，含问候。
    百分比 = round(100 * I_raw / O_raw)。分母不是正数时返回「—」，不用 0% 充数。
    分子缺失而分母有效时按 0，可以显示 0%。可以超过 100%。
    """
    row = row or {}
    if row.get("O_raw") in (None, ""):
        return "—"
    try:
        denom = float(row.get("O_raw"))
        numer = 0.0 if row.get("I_raw") in (None, "") else float(row.get("I_raw"))
    except (TypeError, ValueError):
        return "—"
    if denom <= 0 or numer < 0:
        return "—"
    return f"{_js_round(100 * numer / denom)}%"


def count_text(value):
    if value in (None, ""):
        return "—"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    if number < 0:
        return "—"
    return str(_js_round(number))


def list_facts(row):
    """互动用 raw（说话条数，不含点赞）。往返用已确认的 rounds。"""
    row = row or {}
    extra = ""
    unconfirmed = row.get("unconfirmed")
    try:
        if unconfirmed not in (None, "") and float(unconfirmed) > 0:
            extra = "，未确认 " + str(_js_round(float(unconfirmed)))
    except (TypeError, ValueError):
        extra = ""
    return f"回访 {revisit_text(row)} · 互动 {count_text(row.get('raw'))} · 往返 {count_text(row.get('rounds'))}{extra}"


def date_name(name):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", name):
        return False
    try:
        date.fromisoformat(name)
        return True
    except ValueError:
        return False


def read_table(path, required):
    """错误只报告固定字段名，不打印输入内容或含账号的文件名。"""
    try:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if not set(required).issubset(reader.fieldnames or []):
                raise ValueError("输入 CSV 缺少必要列，请用结构检查工具核对")
            return list(reader)
    except (OSError, UnicodeError, csv.Error):
        raise ValueError("输入 CSV 无法读取，请检查文件权限和编码") from None


def load_daily_root(root, lists=None):
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError("每日数据根目录不存在或不是目录")
    data = dict(rows=[], following={}, followers={}, profiles={}, warnings=[])
    merged, read_days, input_dirs = {}, [], []
    before = unkeyed = 0
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or not date_name(folder.name):
            continue
        parent = folder / "private" if (folder / "private").exists() else folder
        path = parent / "interactions.csv"
        if not path.is_file():
            continue
        rows = read_table(path, ("ts", "account", "direction", "type"))
        read_days.append(folder.name)
        input_dirs.append(parent.resolve())
        before += len(rows)
        for number, source in enumerate(rows, 1):
            r = dict(source)
            r["account"] = norm(r.get("account"))
            for field in ("id", "tweet_id", "post_id", "in_reply_to_status_id",
                          "conversation_id", "parent_kind"):
                r[field] = (r.get(field) or "").strip()
            if not r["account"] or r.get("direction") not in ("in", "out"):
                raise ValueError("每日数据有空账号或无效方向；请本地核对，不猜测")
            # “待核实”不是一个共享对话 ID；空值让原打分器使用逐帖回退。
            for field in ("conversation_id", "in_reply_to_status_id"):
                if r[field].lower() in ("待核实", "unknown", "null", "none", "n/a"):
                    r[field] = ""
            if r["id"]:
                key = ("id", r["id"])
            elif r["tweet_id"]:
                key = ("tweet", r["tweet_id"])
            elif r.get("type") == "like" and r["post_id"]:
                key = ("like", r["account"], r["post_id"])
            else:
                # 没有可靠标识，不能把不同互动误合并。
                key = ("unkeyed", folder.name, str(number))
                unkeyed += 1
            if not r["id"]:
                r["id"] = ":".join(key)
            # 按目录日期递增处理，整行采用较晚版本，不拼造字段。
            merged[key] = r
    if not read_days:
        raise ValueError("未找到可读取的日期目录 interactions.csv")
    data["rows"] = list(merged.values())
    present = {}
    for field in ("following", "followers"):
        path = Path(lists).expanduser() / (field + ".csv") if lists else None
        present[field] = bool(path and path.is_file())
        if present[field]:
            rows = read_table(path, ("handle",))
            data[field] = {norm(r["handle"]): r for r in rows if norm(r["handle"])}
    if not all(present.values()):
        data["warnings"].append("需要 following.csv 和 followers.csv，暂时算不出来互关和沉睡互关")
    if any(present.values()):
        data["warnings"].append("关系表导出日期与每日数据日期是否一致：待核实（不以文件修改时间代替导出日期）")
    if unkeyed:
        data["warnings"].append(f"{unkeyed} 条互动缺少可靠去重标识，未擅自合并，待核实")
    for field in ("conversation_id", "parent_kind"):
        missing = sum(r.get("type") in ("reply", "quote", "mention") and
                      r.get(field, "").lower() in ("", "待核实", "unknown", "null", "none", "n/a")
                      for r in data["rows"])
        if missing:
            data["warnings"].append(f"{field} 有 {missing} 条缺失或未确认，待核实；未推断补值")
    data["coverage"] = dict(read_days=read_days, before=before, after=len(merged),
                            input_dirs=input_dirs, lists_complete=all(present.values()))
    return data


def within(path, parent):
    return path == parent or parent in path.parents


def own_output_entries(output):
    """确认目录里只有本工具生成的普通文件。不删除，也不跟随符号链接。"""
    if not output.exists():
        return []
    if output.is_symlink() or not output.is_dir():
        raise ValueError("输出路径不是目录，拒绝覆盖")
    entries = list(output.iterdir())
    for entry in entries:
        if entry.name not in OUTPUT_NAMES or entry.is_symlink() or not entry.is_file():
            raise ValueError("输出目录里有不是本工具生成的文件，已停止，没有删除任何文件")
    return entries


def clear_own_outputs(output):
    """只删除本工具的旧结果。调用前必须已经确认目录里没有其他文件。"""
    output = Path(output).expanduser().resolve()
    for entry in own_output_entries(output):
        entry.unlink()


def check_output(output, repo, root, overwrite=False):
    """解析符号链接后再检查；也不允许把分析结果写回日期输入目录。"""
    output = Path(output).expanduser().resolve()
    repo = Path(repo).resolve()
    root = Path(root).expanduser().resolve()
    if within(output, repo):
        raise ValueError("--data-root 的输出不能在仓库内")
    if root.is_dir():
        for folder in root.iterdir():
            if date_name(folder.name) and folder.is_dir() and (
                    within(output, folder.resolve()) or
                    ((folder / "private").is_dir() and within(output, (folder / "private").resolve()))):
                raise ValueError("输出不能写入日期输入目录或 private 原件目录")
    if overwrite:
        own_output_entries(output)
    else:
        for name in OUTPUT_NAMES:
            target = output / name
            if target.exists() or target.is_symlink():
                raise ValueError("目标输出文件已存在；请换一个 --out 目录，或加上 --overwrite")
    return output


def coverage_lines(data, meta, me="", excluded=()):
    coverage = data["coverage"]
    start, end = date.fromisoformat(meta["start"]), date.fromisoformat(meta["end"])
    expected = [(start + timedelta(days=n)).isoformat() for n in range((end - start).days + 1)]
    missing = [d for d in expected if d not in coverage["read_days"]]
    covered = meta.get("covered_days")
    if covered is None:
        covered = [d for d in expected if d in coverage["read_days"]]
    uncovered = meta.get("uncovered_days")
    if uncovered is None:
        uncovered = [d for d in expected if d not in set(covered)]
    excluded = {norm(x) for x in excluded} | {norm(me)}
    replies = [r for r in data["rows"] if r["type"] == "reply" and r["account"] not in excluded]
    absent = sum(not r.get("in_reply_to_status_id") for r in replies)
    fraction = f"{absent / len(replies):.2%}" if replies else "不适用（无回复）"
    return [
        f"已读采集日期（{len(coverage['read_days'])} 天）：" + "、".join(coverage["read_days"]),
        f"分析区间缺采集文件的日期（{len(missing)} 天）：" + ("、".join(missing) or "无"),
        "缺采集文件不等于没有互动；单日文件也可能含历史补采。",
        f"有数据的日期（覆盖 {len(covered)} 天）：" + ("、".join(covered) or "无"),
        f"无数据的日期（{len(uncovered)} 天）：" + ("、".join(uncovered) or "无"),
        "无数据不是零互动，不进入持续性分母；计分只按有数据的日期。",
        f"计分天数：{meta.get('scoring_days', len(covered) or meta['days'])}。请求区间 {meta['days']} 天。",
        f"每日行数：合并前 {coverage['before']}，去重后 {coverage['after']}",
        f"全部去重回复缺父帖 ID：{absent}/{len(replies)}（{fraction}）",
    ]


def write_roster(path, res, meta, data, coverage, stars_txt):
    lines = ["# 互动关系名单（仅本机）", "",
             f"区间：{meta['start']} ~ {meta['end']}；数据天数：{len(data['coverage']['read_days'])}。",
             "回访率 = 对方回复我的条数 ÷ 我发出的条数（都含问候）。我没有发出过就写 —。工具不会执行任何操作。", ""]
    lines.extend(coverage)
    lines.extend([""] + meta["warnings"] + [""])
    for tier in ("金牌", "银牌", "单向·他常来我少回", "单向·我常去他没回", "沉睡互关"):
        lines.extend(["## " + tier, ""])
        if tier == "沉睡互关" and not data["coverage"]["lists_complete"]:
            lines.extend(["需要 following.csv 和 followers.csv，暂时算不出来", ""])
            continue
        selected = [r for r in res if r["tier"] == tier]
        for r in selected:
            account = re.sub(r"[\r\n]", "", r["account"])
            lines.append(f"- {account}：{stars_txt(r)} / {r.get('score', '样本不足')}；"
                         f"实质回复 我→他 {r['O']} / 他→我 {r['I']}，往返 {r['rounds']}，"
                         f"实质天数 {r['sub_days']}；{list_facts(r)}")
        if not selected:
            lines.append("暂无")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


EXCLUDE_FILENAME = "排除名单.txt"
_EXCLUDE_SPLIT = re.compile(r"[\s,，;；]+")
_EXCLUDE_HANDLE = re.compile(r"^[a-z0-9_]{1,15}$")
_DIFF_KEYS = ("unfollowed_me", "new_followers", "i_unfollowed", "i_followed")


def parse_exclude_text(text):
    """本地排除名单。空行和 # 注释忽略；逗号、换行、@ 都能认；大小写不区分。

    纯数字当作用户 ID，其余必须像用户名。不连接 X，也不保存注释后的说明。
    """
    ids, handles = set(), set()
    for line in (text or "").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        body = re.split(r"\s+#", raw, maxsplit=1)[0]
        for token in _EXCLUDE_SPLIT.split(body):
            token = token.strip().strip(",").strip().strip('"').strip("'")
            if token.startswith("@"):
                token = token[1:].strip()
            if not token or token.startswith("#"):
                continue
            if token.isdigit():
                ids.add(token)
            else:
                handle = norm(token)
                if _EXCLUDE_HANDLE.match(handle):
                    handles.add(handle)
    return ids, handles


def read_exclude_file(path):
    file = Path(path).expanduser()
    try:
        if not file.is_file():
            raise OSError
        text = file.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        raise ValueError("排除名单文件不存在，或不是文本文件") from None
    return parse_exclude_text(text)


def find_exclude(explicit, directory):
    """显式路径必须存在。默认文件不存在时返回空，调用方保持原行为。"""
    if explicit:
        ids, handles = read_exclude_file(explicit)
        return ids, handles, len(ids) + len(handles), True
    path = Path(directory).expanduser() / EXCLUDE_FILENAME
    if not path.is_file():
        return set(), set(), 0, False
    ids, handles = read_exclude_file(path)
    return ids, handles, len(ids) + len(handles), True


def _row_id(row):
    if not isinstance(row, dict):
        return ""
    for key in ("user_id", "id_str", "rest_id", "id"):
        value = str(row.get(key) or "")
        if value.isdigit():
            return value
    return ""


def expand_exclude(data, ids, handles):
    ids, handles = set(ids), set(handles)
    for bucket in ("following", "followers", "profiles"):
        for handle, row in (data.get(bucket) or {}).items():
            uid = _row_id(row)
            name = norm(handle)
            if (name and name in handles) or (uid and uid in ids):
                if name:
                    handles.add(name)
                if uid:
                    ids.add(uid)
    return ids, handles


def person_excluded(person, ids, handles):
    if not isinstance(person, dict):
        return False
    uid = str(person.get("id") or person.get("user_id") or "")
    handle = norm(person.get("handle") or person.get("account") or "")
    if uid and uid in ids:
        return True
    if handle and handle in handles:
        return True
    return False


def apply_exclude(data, ids, handles):
    """从本次分析用的副本里拿掉。不改打分公式，也不删磁盘上的原始 CSV。"""
    ids, handles = expand_exclude(data, ids, handles)
    if not ids and not handles:
        return ids, handles
    for key in ("following", "followers", "profiles"):
        bucket = data.get(key) or {}
        data[key] = {
            handle: row for handle, row in bucket.items()
            if norm(handle) not in handles and _row_id(row) not in ids
        }
    return ids, handles


def filter_people(items, ids, handles):
    if items is None:
        return None
    if not ids and not handles:
        return items
    return [item for item in items if not person_excluded(item, ids, handles)]


def filter_follow_diff(diff, ids, handles):
    if not diff or (not ids and not handles):
        return diff
    out = dict(diff)
    for key in _DIFF_KEYS:
        out[key] = filter_people(diff.get(key), ids, handles)
    return out


def filter_not_back(info, ids, handles):
    if not info or not info.get("items") or (not ids and not handles):
        return info
    out = dict(info)
    out["items"] = filter_people(info["items"], ids, handles)
    return out
