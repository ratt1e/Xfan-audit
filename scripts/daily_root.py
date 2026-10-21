"""只读合并日期目录；不推断缺失的对话字段，不复制任何输入文件。"""
import csv
from datetime import date, timedelta
from pathlib import Path
import re

OUTPUT_NAMES = ("accounts.csv", "dashboard.html", "dashboard_public.html", "名单.md")


def norm(value):
    return (value or "").strip().lstrip("@").lower()


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


def check_output(output, repo, root):
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
    for name in OUTPUT_NAMES:
        target = output / name
        if target.exists() or target.is_symlink():
            raise ValueError("目标输出文件已存在；请换一个 --out 目录，避免覆盖")
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
             "建议只是建议，工具不会执行任何操作。", ""]
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
                         f"实质天数 {r['sub_days']}；{r['action']}")
        if not selected:
            lines.append("暂无")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
