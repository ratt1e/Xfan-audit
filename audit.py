#!/usr/bin/env python3
"""fan-audit v0.1：一行命令，从 CSV 生成「互动关系星级」看板。

  python3 audit.py --data sample_data      # 先用假数据试跑
  python3 audit.py                         # 默认读 data/，输出到 output/

离线、只读：不联网，不调用任何 X 接口，不会点赞、关注或取关任何人。
只用 Python 标准库（3.9+）。输入格式见 docs/DATA_EXPORT.md。
"""
import argparse
import csv
import glob
import html
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import relationship_stars as rs  # noqa: E402
from daily_root import load_daily_root, check_output, clear_own_outputs, coverage_lines, write_roster  # noqa: E402

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

TIERS = ["金牌", "银牌", "单向·他常来我少回", "单向·我常去他没回", "沉睡互关", "样本不足", "其他有分", "零互动"]
TIER_NOTE = {
    "金牌": "两边都在认真说话，重点维护、可以谈合作",
    "银牌": "有来有回但还不够，多接几次话就能升级",
    "单向·他常来我少回": "他常来，你很少回",
    "单向·我常去他没回": "你常去，他没回（也可能是没采到）",
    "沉睡互关": "互相关注，但这段时间零回复、零点赞",
    "样本不足": "互动太少（<3 条或只在 1 天），先不打星",
    "其他有分": "有分，但还没到银牌",
    "零互动": "只在名单里出现，没有互动，也不是互关",
}


def norm(h):
    return (h or "").strip().lstrip("@").strip().lower()


def read_csv(path, required=()):
    if not os.path.exists(path):
        return None
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if rows:
        miss = [c for c in required if c not in rows[0]]
        if miss:
            sys.exit(f"{path} 缺少列：{', '.join(miss)}（标准表头见 templates/ 和 docs/DATA_EXPORT.md）")
    return rows


def truthy(v):
    return str(v or "").strip().lower() in ("1", "true", "yes", "y", "是", "✔")


def load_inputs(d):
    """读 data 目录。replies.csv（推荐）或 interactions.csv（scripts/daily_collect.py 的输出）至少要有一个。"""
    out = {"warnings": []}
    following = read_csv(os.path.join(d, "following.csv"), ["handle"]) or []
    followers = read_csv(os.path.join(d, "followers.csv"), ["handle"]) or []
    out["following"] = {norm(r["handle"]): r for r in following if norm(r["handle"])}
    out["followers"] = {norm(r["handle"]): r for r in followers if norm(r["handle"])}
    if not following:
        out["warnings"].append("没有 following.csv：互关和沉睡互关算不出来")
    if not followers:
        out["warnings"].append("没有 followers.csv：互关和沉睡互关算不出来")
    rows = []
    inter = read_csv(os.path.join(d, "interactions.csv"), ["tweet_id", "ts", "account", "direction", "type"])
    if inter:
        rows += inter
    replies = None
    for fp in sorted(glob.glob(os.path.join(d, "replies*.csv"))):   # replies.csv、replies_out.csv … 都会读，按 tweet_id 去重
        replies = (replies or []) + (read_csv(fp, ["tweet_id", "created_at", "direction", "account", "text"]) or [])
    for r in replies or []:
        direction = r["direction"].strip().lower()
        direction = {"我→他": "out", "他→我": "in"}.get(direction, direction)
        if direction not in ("in", "out"):
            out["warnings"].append(f"replies.csv 里 direction 只能是 in/out：{r['tweet_id']}")
            continue
        rows.append({"id": "tw:" + r["tweet_id"], "tweet_id": r["tweet_id"], "ts": r["created_at"],
                     "account": norm(r["account"]), "direction": direction, "type": (r.get("type") or "reply").strip() or "reply",
                     "post_id": r["tweet_id"], "conversation_id": r.get("conversation_id", ""),
                     "in_reply_to_status_id": r.get("in_reply_to_status_id", ""),
                     "parent_kind": r.get("parent_kind", ""), "text": r.get("text", "")})
    likes = read_csv(os.path.join(d, "likes.csv"), ["account", "post_id"])
    for r in likes or []:
        a = norm(r["account"])
        rows.append({"id": f"like:in:{a}:{r['post_id']}", "tweet_id": "", "ts": "", "account": a,
                     "direction": (r.get("direction") or "in").strip() or "in", "type": "like", "post_id": r["post_id"],
                     "post_created_at": r.get("post_created_at", ""), "first_observed_at": r.get("first_observed_at", ""),
                     "observed_baseline": r.get("observed_baseline", "")})
    if inter is None and replies is None:
        sys.exit(f"{d}/ 里没有 replies.csv（或 interactions.csv）。先看 docs/DATA_EXPORT.md 准备数据，"
                 "或者用 `python3 audit.py --data sample_data` 试跑。")
    for r in rows:
        r["account"] = norm(r["account"])
    out["rows"] = rows
    prof = read_csv(os.path.join(d, "profiles.csv"), ["handle"]) or []
    out["profiles"] = {norm(r["handle"]): r for r in prof}
    miss_parent = sum(1 for r in rows if r["type"] == "reply" and not r.get("in_reply_to_status_id"))
    if miss_parent:
        out["warnings"].append(f"{miss_parent} 条回复没有 in_reply_to_status_id：这些回复确认不了往返，往返分会偏低")
    if not likes:
        out["warnings"].append("没有 likes.csv：点赞加分为 0（点赞只是辅助，最多 +5 分）")
    return out


def classify(x, tcfg):
    g, s, o = tcfg["gold"], tcfg["silver"], tcfg["one_way"]
    their = x.get("I_raw", 0)
    rounds = x.get("rounds") or 0
    # 金牌、银牌都要对方至少回过 1 条，并且至少有 1 次确认往返。
    if x["status"] == "ok" and their >= g.get("min_their_replies", 1) and rounds >= s.get("min_confirmed_rounds", 1):
        if (x["score"] >= g["min_score"] and rounds >= g["min_rounds"] and x["O"] >= g["min_each_side"]
                and x["I"] >= g["min_each_side"] and x.get("greet_share", 1) < g["max_greet_share"]
                and x["sub_days"] >= g["min_sub_days"]):
            return "金牌"
        if x["score"] >= s["min_score"] or rounds >= s["min_rounds"]:
            return "银牌"
    if their >= o["min_from_one_side"] and x.get("O_raw", 0) <= o["max_from_other_side"]:
        return "单向·他常来我少回"
    # 对方回复数为 0：优先单向，分数到了银牌线也不进银牌。
    if x.get("O_raw", 0) >= o["min_from_one_side"] and their == 0:
        return "单向·我常去他没回"
    if x.get("mutual") and x.get("raw", 0) == 0 and x.get("L_in", 0) == 0:
        return "沉睡互关"
    if x["status"] == "样本不足" and (x.get("raw", 0) or x.get("L_in", 0)):
        return "样本不足"
    if x["status"] == "ok":
        return "其他有分"
    return "零互动"


def action(x):
    t = x["tier"]
    parts = []
    if t == "金牌":
        parts.append("重点维护：他发帖时优先接他的话题，挑一条好帖引用并加上你的观点")
        parts.append("聊得来可以试着邀请互推或一起做一条内容（对方意愿待核实）")
    elif t == "银牌":
        if x["I"] > x["O"]:
            parts.append("他回你比你回他多，多接他的话")
        elif x["O"] > x["I"] + 1:
            parts.append("你去得多、他回得少，挑他主页的实质话题再聊")
        if x["rounds"] >= 2:
            parts.append(f"已经有 {x['rounds']} 轮真往返，再多聊几天就可能升金牌")
        else:
            parts.append("下次他回你时再接一句，把单句评论聊成对话")
        if x.get("greet", 0) >= 2:
            parts.append("少一点问候，多一点具体内容")
    elif t == "单向·他常来我少回":
        parts.append("回他一两句实质内容，这是成本最低的升级")
    elif t == "单向·我常去他没回":
        parts.append("先别再大量串门；看看是不是没采到他的回复")
    elif t == "沉睡互关":
        parts.append("不急着取关（零公开互动≠没看过）；挑简介方向接近的主动聊一次")
    if t in ("金牌", "银牌"):
        if x.get("verified"):
            parts.append("蓝V：他的曝光算进 OCR 认证曝光")
        if not x.get("mutual") and not x.get("i_follow"):
            parts.append("你还没关注他，可以考虑回关")
    return "；".join(parts)


def analyze(data, conf, cfg, end=None, days=None, all_days=False):
    win = conf.get("window", {})
    tz = ZoneInfo(win.get("timezone", "America/Los_Angeles")) if ZoneInfo else timezone.utc
    g = conf.get("greetings", {})
    excl = {norm(a) for a in conf.get("exclude_accounts", []) + [conf.get("me") or ""] if norm(a)}
    rows = [r for r in data["rows"] if r["account"] not in excl]
    prep = rs.prepare(rows, tz, g.get("words", []), g.get("max_core_len", 15))
    dts = [r["dt"].date() for r in prep if r.get("dt")]
    if end in (None, "auto"):
        end = win.get("end", "auto")
    e = (max(dts) if dts else date.today()) if end == "auto" else date.fromisoformat(end)
    days = days or win.get("days", 30)
    s = e - timedelta(days=days - 1)
    if all_days:
        dates = [r[field].date() for r in prep for field in ("dt", "post_dt", "obs_dt") if r.get(field)]
        if not dates and data.get("coverage"):
            dates = [date.fromisoformat(d) for d in data["coverage"]["read_days"]]
        s, e = (min(dates), max(dates)) if dates else (e, e)
        days = (e - s).days + 1
    by = defaultdict(list)
    for r in prep:
        by[r["account"]].append(r)
    # 有数据的日期：采集日（只有 --data-root 有）、互动时间、点赞第一次被看到的时间。
    # 单目录没有采集日。这些日期以外是无数据，不进持续性分母。帖子发布时间单独不算。
    observed = set()
    if data.get("coverage"):
        observed.update(date.fromisoformat(day) for day in data["coverage"]["read_days"])
    for r in prep:
        if r.get("dt"):
            observed.add(r["dt"].date())
        if r.get("obs_dt"):
            observed.add(r["obs_dt"].date())
    fol, fer, prof = data["following"], data["followers"], data["profiles"]
    accounts = set(by) | set(fol) | set(fer)
    accounts -= excl
    tcfg = conf.get("tiers") or json.load(open(rs.CONFIG_PATH, encoding="utf-8"))["tiers"]
    pb = tcfg.get("priority_bonus", {})
    res = []
    for a in sorted(accounts):
        x = rs.score(by.get(a, []), s, e, conf.get("likes", {}).get("time_mode", "strict"), cfg, observed)
        x["account"] = a
        x["i_follow"], x["follows_me"] = a in fol, a in fer
        x["mutual"] = x["i_follow"] and x["follows_me"]
        p = prof.get(a, {})
        f = (fer.get(a) or fol.get(a) or {})
        x["verified"] = truthy(p.get("verified") or f.get("verified") or f.get("is_blue_verified"))
        try:
            x["followers_count"] = int(p.get("followers_count") or f.get("followers_count") or 0) or None
        except ValueError:
            x["followers_count"] = None
        x["tier"] = classify(x, tcfg)
        x["priority"] = round((x.get("score") or 0) + pb.get("mutual", 5) * x["mutual"] + pb.get("verified", 5) * x["verified"]
                              + pb.get("followers_log10_max", 5) * min(1, math.log10((x["followers_count"] or 0) + 1) / 4), 1)
        x["action"] = action(x)
        res.append(x)
    res.sort(key=lambda x: (TIERS.index(x["tier"]), -x["priority"], x["account"]))
    meta = dict(start=str(s), end=str(e), days=days, tz=str(tz), n_rows=len(rows),
                n_following=len(fol), n_followers=len(fer), n_mutual=sum(1 for a in fol if a in fer),
                warnings=data["warnings"])
    if observed is not None:
        span = [s + timedelta(days=i) for i in range((e - s).days + 1)]
        covered = [d for d in span if d in observed]
        meta["covered_days"] = [d.isoformat() for d in covered]
        meta["uncovered_days"] = [d.isoformat() for d in span if d not in observed]
        meta["scoring_days"] = len(covered) if covered else days
    return res, meta


# ---------------- 看板 ----------------

CSS = """
body{font-family:-apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;background:#F7F8FA;color:#1F2937;margin:0;padding:28px}
h1{font-size:28px;margin:0 0 4px} .sub{color:#6B7280;font-size:14px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:18px}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:16px 18px}
.num{font-size:34px;font-weight:700} .lab{color:#6B7280;font-size:13px;margin-top:4px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:820px){.panels{grid-template-columns:1fr}}
h2{font-size:18px;margin:0 0 12px} .bar{display:flex;align-items:center;margin:6px 0;font-size:14px}
.bar .k{width:150px;white-space:nowrap} .bar .b{height:16px;border-radius:4px;background:#3B82F6;margin-right:8px}
.bar .b.gray{background:#CBD5E1} .bar .b.gold{background:#F59E0B} .bar .b.silver{background:#94A3B8}
.bar .b.green{background:#10B981} .bar .b.red{background:#F43F5E}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #EEF0F3;vertical-align:top}
th{color:#6B7280;font-weight:600;white-space:nowrap} td:nth-child(-n+8){white-space:nowrap} td:last-child{min-width:260px} .star{color:#F59E0B;white-space:nowrap} .muted{color:#6B7280;font-size:12px}
.warn{background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
footer{color:#6B7280;font-size:13px;text-align:center;margin-top:18px}
"""


def stars_txt(x):
    return ("★" * x["stars"] + "☆" * (5 - x["stars"])) if x["status"] == "ok" else "样本不足"


def coverage_note(meta):
    covered = meta.get("covered_days")
    if covered is None:
        return ""
    missing = len(meta.get("uncovered_days") or [])
    note = f"；覆盖 {len(covered)} 天"
    if missing:
        note += f"，{missing} 天无数据（不算零互动）"
    return note


def mutual_txt(x):
    return "✔ 互关" if x["mutual"] else "→ 我关注" if x["i_follow"] else "← 关注我" if x["follows_me"] else ""


def bars(items, maxv, cls=""):
    out = []
    for k, v, c in items:
        w = 0 if not maxv else max(2 if v else 0, int(260 * v / maxv))
        out.append(f'<div class="bar"><span class="k">{html.escape(k)}</span>'
                   f'<span class="b {c or cls}" style="width:{w}px"></span><b>{v}</b></div>')
    return "\n".join(out)


def render(res, meta, public=False):
    alias = {}

    def name(x):
        if not public:
            return "@" + html.escape(x["account"])
        alias.setdefault(x["account"], f"账号#{len(alias) + 1:02d}")
        return alias[x["account"]]

    scored = [x for x in res if x["status"] == "ok"]
    st = Counter(x["stars"] for x in scored)
    tiers = Counter(x["tier"] for x in res)
    active = sum(1 for x in res if x.get("raw", 0) or x.get("L_in", 0))
    star_items = [(f"{'★' * n}", st.get(n, 0), "") for n in (5, 4, 3, 2, 1)]
    star_items.append(("样本不足", sum(1 for x in res if x["status"] == "样本不足" and (x.get("raw") or x.get("L_in"))), "gray"))
    tier_cls = {"金牌": "gold", "银牌": "silver", "单向·他常来我少回": "green", "单向·我常去他没回": "red", "沉睡互关": "gray"}
    tier_items = [(t, tiers.get(t, 0), tier_cls.get(t, "gray")) for t in TIERS[:6]]

    def table(tier, limit=50):
        xs = [x for x in res if x["tier"] == tier][:limit]
        if not xs:
            return '<p class="muted">（这一层暂时没有人）</p>'
        h = ['<table><tr><th>账号</th><th>星级</th><th>分数</th><th>实质 我→他/他→我</th><th>真往返</th>'
             '<th>活跃天</th><th>互关</th><th>认证</th><th>建议动作</th></tr>']
        for x in xs:
            h.append(f"<tr><td>{name(x)}</td><td class='star'>{stars_txt(x)}</td><td>{x.get('score', '—')}</td>"
                     f"<td>{x['O']} / {x['I']}</td><td>{x['rounds']}</td><td>{x['sub_days']}</td>"
                     f"<td>{mutual_txt(x)}</td><td>{'蓝V' if x['verified'] else ''}</td>"
                     f"<td>{html.escape(x['action'])}</td></tr>")
        h.append("</table>")
        return "\n".join(h)

    def small_list(tier, key):
        xs = [x for x in res if x["tier"] == tier]
        if not xs:
            return '<p class="muted">（暂时没有）</p>'
        if public:
            return f'<p class="muted">共 {len(xs)} 个（对外版不列名单）</p>'
        return "<p>" + "、".join(f"{name(x)}（{key(x)}）" for x in xs[:60]) + ("…" if len(xs) > 60 else "") + "</p>"

    warn = "".join(f"<div>⚠ {html.escape(w)}</div>" for w in meta["warnings"])
    title = "粉丝体检 · 互动关系星级（试用版）" + ("· 对外打码版" if public else "")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{CSS}</style></head><body>
<h1>{title}</h1>
<div class="sub">区间 {meta['start']} ~ {meta['end']}（请求 {meta['days']} 天，{html.escape(meta['tz'])}）{coverage_note(meta)} · 只统计公开回复、引用和点赞 · 分数只是线索，不代表真实关系</div>
{f'<div class="warn">{warn}</div>' if warn else ''}
<div class="grid">
<div class="card"><div class="num">{meta['n_following']}</div><div class="lab">我关注的</div></div>
<div class="card"><div class="num">{meta['n_followers']}</div><div class="lab">粉丝（名单里的）</div></div>
<div class="card"><div class="num">{meta['n_mutual']}</div><div class="lab">互关</div></div>
<div class="card"><div class="num">{active}</div><div class="lab">有公开互动的账号</div></div>
<div class="card"><div class="num" style="color:#D97706">{tiers.get('金牌', 0)}</div><div class="lab">金牌用户</div></div>
<div class="card"><div class="num" style="color:#64748B">{tiers.get('沉睡互关', 0)}</div><div class="lab">沉睡互关</div></div>
</div>
<div class="panels">
<div class="card"><h2>星级分布</h2>{bars(star_items, max([v for _, v, _ in star_items] or [0]))}
<p class="muted">样本不足 = 少于 3 条或只在 1 天里，不打星。</p></div>
<div class="card"><h2>分层</h2>{bars(tier_items, max([v for _, v, _ in tier_items] or [0]))}
<p class="muted">{'；'.join(f'{k}：{v}' for k, v in list(TIER_NOTE.items())[:5])}</p></div>
</div>
<div class="card" style="margin-bottom:16px"><h2>🥇 金牌（重点维护 / 可谈合作）</h2>{table('金牌')}</div>
<div class="card" style="margin-bottom:16px"><h2>🥈 银牌（有潜力，可以升级）</h2>{table('银牌')}</div>
<div class="panels">
<div class="card"><h2>单向</h2><b>他常来、我少回</b>{small_list('单向·他常来我少回', lambda x: f"他 {x.get('I_raw', 0)} / 我 {x.get('O_raw', 0)}")}
<b>我常去、他没回</b>{small_list('单向·我常去他没回', lambda x: f"我 {x.get('O_raw', 0)} 条")}</div>
<div class="card"><h2>沉睡互关</h2>{small_list('沉睡互关', lambda x: '零互动')}
<p class="muted">零公开互动 ≠ 没看过，别急着取关；要清理也请手动、分批、慢慢来。</p></div>
</div>
<footer>fan-audit v0.1 · 试用版 · 权重待验证 · 所有建议都只是建议，工具不会执行任何操作</footer>
</body></html>"""


def write_csv(res, path):
    keys = ["account", "tier", "status", "score", "stars", "priority", "O", "I", "O_raw", "I_raw", "greet", "rounds", "T",
            "unconfirmed", "active_days", "sub_days", "L_in", "P", "B", "R", "greet_cap", "mutual", "i_follow",
            "follows_me", "verified", "followers_count", "action"]
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(res)


def main(argv=None):
    ap = argparse.ArgumentParser(description="fan-audit：从 CSV 生成互动关系星级看板（离线、只读）")
    ap.add_argument("--data", help="单目录输入，默认 data/；不与 --data-root 同用")
    ap.add_argument("--data-root", help="每日数据根目录；也可用 FAN_AUDIT_DATA_ROOT")
    ap.add_argument("--lists", help="每日模式可选关系表目录，只读 following.csv 和 followers.csv")
    ap.add_argument("--out", help="输出目录；每日模式默认在数据根目录的 _分析结果/截止日期/")
    ap.add_argument("--overwrite", action="store_true",
                    help="覆盖 --out 里本工具上次生成的结果；目录里有其他文件则停止，不删除")
    ap.add_argument("--config", default=rs.CONFIG_PATH)
    ap.add_argument("--end", help="截止日 YYYY-MM-DD，默认取 config（auto=数据里最晚一天）")
    period = ap.add_mutually_exclusive_group()
    period.add_argument("--days", type=int, help="区间天数，默认取 config")
    period.add_argument("--all-days", action="store_true", help="按本地时区从最早互动到最晚互动")
    ap.add_argument("--me", help="你自己的用户名（自己回自己的串推会被排除），也可以写进 config.json 的 me")
    a = ap.parse_args(argv)
    root = a.data_root or (os.environ.get("FAN_AUDIT_DATA_ROOT") if not a.data else None)
    if a.data_root and a.data:
        ap.error("--data 与 --data-root 不同用；关系表请使用 --lists")
    if a.lists and not root:
        ap.error("--lists 只用于 --data-root")
    if a.days is not None and a.days < 1:
        ap.error("--days 必须大于 0")
    if a.all_days and a.end:
        ap.error("--all-days 不与 --end 同用")
    conf, cfg = rs.load_config(a.config)
    if a.me:
        conf["me"] = a.me
    if root:
        try:
            if a.out:
                check_output(a.out, HERE, root, a.overwrite)
            data = load_daily_root(root, a.lists)
            # 空文件或只有点赞时，默认截止日期仍有确定来源。
            daily_conf = dict(conf, window=dict(conf.get("window", {})))
            if not any(r.get("ts") for r in data["rows"]) and daily_conf["window"].get("end", "auto") == "auto":
                daily_conf["window"]["end"] = data["coverage"]["read_days"][-1]
            try:
                res, meta = analyze(data, daily_conf, cfg, a.end, a.days, a.all_days)
            except (ValueError, TypeError, KeyError, OverflowError):
                raise ValueError("每日数据的时间或字段格式无效，请在本机核对；具体值未打印") from None
            from pathlib import Path
            target = a.out or Path(root).expanduser() / "_分析结果" / meta["end"]
            a.out = str(check_output(target, HERE, root, a.overwrite))
        except (ValueError, OSError) as exc:
            # OSError 的路径可能带账号；不把原始异常内容输出。
            ap.error(str(exc) if isinstance(exc, ValueError) else "每日数据或输出目录无法访问")
    else:
        data = load_inputs(a.data or "data")
        res, meta = analyze(data, conf, cfg, a.end, a.days, a.all_days)
        a.out = a.out or "output"
    if root and a.overwrite:
        try:
            clear_own_outputs(a.out)
        except (ValueError, OSError) as exc:
            ap.error(str(exc) if isinstance(exc, ValueError) else "输出目录无法更新")
    os.makedirs(a.out, exist_ok=True)
    write_csv(res, os.path.join(a.out, "accounts.csv"))
    with open(os.path.join(a.out, "dashboard.html"), "w", encoding="utf-8") as f:
        f.write(render(res, meta, public=False))
    with open(os.path.join(a.out, "dashboard_public.html"), "w", encoding="utf-8") as f:
        f.write(render(res, meta, public=True))
    if root:
        coverage = coverage_lines(data, meta, conf.get("me", ""), conf.get("exclude_accounts", []))
        write_roster(Path(a.out) / "名单.md", res, meta, data, coverage, stars_txt)
        for line in coverage:
            print(line)
    for w in meta["warnings"]:
        print("⚠", w)
    c = Counter(x["tier"] for x in res)
    extra = ""
    if meta.get("covered_days") is not None:
        extra = f"；计分覆盖 {meta['scoring_days']} 天，无数据 {len(meta.get('uncovered_days') or [])} 天"
    print(f"区间 {meta['start']} ~ {meta['end']}{extra}，{len(res)} 个账号：" + "，".join(f"{t} {c.get(t, 0)}" for t in TIERS))
    if root:
        print("已在仓库外写出 accounts.csv、dashboard.html、dashboard_public.html、名单.md（私有名单不在终端展示）")
    else:
        print(f"看板：{os.path.join(a.out, 'dashboard.html')}（含账号名，只给自己看）")
        print(f"对外打码版：{os.path.join(a.out, 'dashboard_public.html')}；明细：{os.path.join(a.out, 'accounts.csv')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
