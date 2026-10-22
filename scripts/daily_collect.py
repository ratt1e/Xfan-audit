#!/usr/bin/env python3
"""每日采集：把 X API v2 原始 JSON 转成 interactions.csv，并输出校验警告和不含账号名的快照。

离线、只读：本脚本不联网、不调用任何 X 接口。接口调用由外部（定时任务 / AI 代理）
按 docs/DAILY_COLLECT.md 完成，把原始响应存成 JSON 放进 --raw-dir。

原始文件命名（--raw-dir 下）：
  posts_*.json            GET /2/users/:id/tweets（我的帖子，含回复）
  mentions_*.json         GET /2/users/:id/mentions（提及我）
  quotes_<帖子ID>_*.json   GET /2/tweets/:id/quote_tweets（引用我某条帖子）
  likers_<帖子ID>_*.json   GET /2/tweets/:id/liking_users（谁赞了我某条帖子）
  reposters_<帖子ID>_*.json GET /2/tweets/:id/retweeted_by（只计数，不进 interactions）
  profile.json            可选，GET /2/users/by/username/:username

输出：
  <raw-dir>/interactions.csv   含账号名，只能放 private/
  <raw-dir>/validation.txt     校验警告
  <snapshot-dir>/snapshot.json 不含任何账号名：计数、覆盖率、时间窗、警告
  <state>                      跨天状态：每类最新 id（下一晚的 since_id）、点赞 first_observed_at
"""
import argparse
import csv
import glob
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone

PENDING = "待核实"
FIELDS = ["id", "tweet_id", "ts", "account", "account_id", "direction", "type", "post_id",
          "conversation_id", "in_reply_to_status_id", "parent_kind", "text", "is_greeting",
          "post_created_at", "first_observed_at", "observed_baseline", "source_file", "captured_at"]
REQUIRED_TWEET_FIELDS = ["created_at", "author_id", "conversation_id"]


# ---------- 问候识别（SPEC 第 7 节） ----------

def load_greetings(path):
    """读问候词表。支持 config.json（取 greetings.words）或每行一个词的 txt。"""
    words = []
    if not path or not os.path.exists(path):
        return words
    if path.endswith(".json"):
        with open(path, encoding="utf-8") as fh:
            return list(json.load(fh).get("greetings", {}).get("words", []))
    with open(path, encoding="utf-8") as fh:
        for line in fh.read().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                words.append(line)
    return words


_MENTION = re.compile(r"@\w+")
_URL = re.compile(r"https?://\S+")


def strip_text(text):
    return _URL.sub("", _MENTION.sub("", text or "")).strip()


def core_of(text):
    s = strip_text(text)
    return "".join(ch for ch in s if unicodedata.category(ch)[0] in ("L", "N"))


def is_greeting(text, words, max_len=15):
    core = core_of(text)
    if not core:
        return True
    if len(core) > max_len:
        return False
    low = strip_text(text).lower()
    for w in words:
        prefix = w.startswith("^")
        w = w.lstrip("^").lower()
        if re.fullmatch(r"[a-z0-9 ]+", w):
            pat = r"\b" + re.escape(w) + r"\b"
            pat = "^" + pat if prefix else pat
            if re.search(pat, low):
                return True
        elif (low.startswith(w) if prefix else w in low):
            return True
    return False


# ---------- 读取原始 JSON ----------

def parse_dt(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def fmt_dt(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if d else ""


def load_json(path):
    """读一个原始响应。容忍前后有工具附加的文字（如额度提示）。"""
    with open(path, encoding="utf-8") as fh:
        t = fh.read()
    i = t.find("{")
    if i < 0:
        raise ValueError(f"{path}: 没有 JSON")
    obj, _ = json.JSONDecoder().raw_decode(t[i:])
    return obj


def kind_of(fname):
    base = os.path.basename(fname)
    m = re.match(r"(posts|mentions)(?:_.*)?\.json$", base)
    if m:
        return m.group(1), None
    m = re.match(r"(quotes|likers|reposters)_(\d+)(?:_.*)?\.json$", base)
    if m:
        return m.group(1), m.group(2)
    return None, None


def replied_to(t):
    for r in t.get("referenced_tweets") or []:
        if r.get("type") == "replied_to":
            return r.get("id")
    return None


def quoted(t):
    for r in t.get("referenced_tweets") or []:
        if r.get("type") == "quoted":
            return r.get("id")
    return None


def is_retweet(t):
    return any(r.get("type") == "retweeted" for r in t.get("referenced_tweets") or [])


class Raw:
    def __init__(self):
        self.tweets = {}            # id -> tweet（posts/mentions/quotes 的 data）
        self.tweet_src = {}         # id -> source file
        self.tweet_kind = {}        # id -> posts/mentions/quotes
        self.included = {}          # id -> tweet（includes.tweets，只用于查父帖）
        self.users = {}             # id -> username
        self.likers = defaultdict(dict)   # post_id -> {user_id: (username, file)}
        self.reposters = defaultdict(set)
        self.pages = []             # 每页信息
        self.dup_same = 0
        self.dup_diff = []
        self.profile = None
        self.kind_ranges = defaultdict(list)
        self.field_seen = defaultdict(Counter)   # kind -> 字段缺失计数（合并前，按原始行）


def load_raw(raw_dir):
    raw = Raw()
    files = sorted(glob.glob(os.path.join(raw_dir, "*.json")))
    for f in files:
        base = os.path.basename(f)
        if base == "profile.json":
            raw.profile = load_json(f).get("data")
            continue
        kind, post_id = kind_of(f)
        if not kind:
            continue
        d = load_json(f)
        data = d.get("data") or []
        meta = d.get("meta") or {}
        inc = d.get("includes") or {}
        for u in inc.get("users") or []:
            raw.users[u["id"]] = u.get("username", "")
        for t in inc.get("tweets") or []:
            raw.included.setdefault(t["id"], t)
        raw.pages.append({"file": base, "kind": kind, "n": len(data),
                          "result_count": meta.get("result_count"),
                          "has_next": bool(meta.get("next_token"))})
        if kind in ("likers", "reposters"):
            for u in data:
                raw.users[u["id"]] = u.get("username", "")
                if kind == "likers":
                    raw.likers[post_id].setdefault(u["id"], (u.get("username", ""), base))
                else:
                    raw.reposters[post_id].add(u["id"])
            continue
        for t in data:
            tid = t["id"]
            raw.kind_ranges[kind].append(t.get("created_at"))
            fs = raw.field_seen[kind]
            fs["_n"] += 1
            for fld in REQUIRED_TWEET_FIELDS:
                fs[fld] += 0 if t.get(fld) else 1
            if t.get("in_reply_to_user_id"):
                fs["_rep"] += 1
                fs["replied_to(回复中)"] += 0 if replied_to(t) else 1
            if tid in raw.tweets:
                if (raw.tweets[tid].get("text") or "") == (t.get("text") or ""):
                    raw.dup_same += 1
                    # 合并：补上前一份缺的字段（例如 posts 缺 conversation_id，mentions 有）
                    for k, v in t.items():
                        if raw.tweets[tid].get(k) in (None, "") and v not in (None, ""):
                            raw.tweets[tid][k] = v
                else:
                    raw.dup_diff.append(tid)
                continue
            raw.tweets[tid] = dict(t)
            raw.tweet_src[tid] = base
            raw.tweet_kind[tid] = kind
    return raw


# ---------- 生成 interactions ----------

def build(raw, me_id, me_handle, greetings, exclude, state, observed_at):
    me_handle = (me_handle or "").lower()
    exclude = {e.lower() for e in exclude}
    rows, stats = [], Counter()
    lookup = dict(raw.included)
    lookup.update(raw.tweets)

    def handle(uid):
        return (raw.users.get(uid) or "").lower() or uid

    # 1) conversation_id：缺失时用同链另一侧补（父帖或子帖），反复传播到不动为止
    conv = {tid: t.get("conversation_id") for tid, t in lookup.items()}
    children = defaultdict(list)
    for tid, t in lookup.items():
        p = replied_to(t)
        if p:
            children[p].append(tid)
    filled_from_chain = set()
    changed = True
    while changed:
        changed = False
        for tid in list(conv):
            if conv[tid]:
                continue
            t = lookup[tid]
            cand = None
            p = replied_to(t)
            if p and conv.get(p):
                cand = conv[p]
            elif not p and not quoted(t) and t.get("author_id"):
                cand = tid  # 原创帖：自己就是对话起点
            else:
                for c in children.get(tid, []):
                    if conv.get(c):
                        cand = conv[c]
                        break
            if cand:
                conv[tid] = cand
                filled_from_chain.add(tid)
                changed = True

    # 2) 方向判定（SPEC 5.2）
    for tid, t in raw.tweets.items():
        author = t.get("author_id")
        irt_user = t.get("in_reply_to_user_id")
        parent = replied_to(t)
        q = quoted(t)
        if is_retweet(t):
            stats["丢弃_转推"] += 1
            continue
        if author == me_id:
            if irt_user and irt_user != me_id:
                direction, typ, other = "out", "reply", irt_user
            elif irt_user == me_id:
                stats["丢弃_自己串推"] += 1
                continue
            elif q and lookup.get(q, {}).get("author_id") not in (None, me_id):
                direction, typ, other = "out", "quote", lookup[q]["author_id"]
            elif q:
                stats["丢弃_引用作者未知"] += 1
                continue
            else:
                stats["我的原创帖"] += 1
                continue
        else:
            if irt_user == me_id:
                direction, typ, other = "in", "reply", author
            elif raw.tweet_kind.get(tid) == "quotes" or (q and lookup.get(q, {}).get("author_id") == me_id):
                direction, typ, other = "in", "quote", author
            elif irt_user:
                stats["丢弃_他人之间的楼中楼"] += 1
                continue
            else:
                direction, typ, other = "in", "mention", author
        acc = handle(other)
        if acc in exclude:
            stats["丢弃_排除账号"] += 1
            continue
        rows.append({
            "id": f"tw:{tid}", "tweet_id": tid, "ts": fmt_dt(parse_dt(t.get("created_at"))),
            "account": acc, "account_id": other, "direction": direction, "type": typ,
            "post_id": tid, "conversation_id": conv.get(tid) or PENDING,
            "in_reply_to_status_id": parent or "", "parent_kind": "",
            "text": (t.get("text") or "").replace("\r", " "),
            "is_greeting": str(is_greeting(t.get("text"), greetings)).lower(),
            "post_created_at": "", "first_observed_at": "", "observed_baseline": "",
            "source_file": raw.tweet_src.get(tid, ""), "captured_at": observed_at,
        })

    # 3) parent_kind
    by_tid = {r["tweet_id"]: r for r in rows}
    for r in rows:
        if r["type"] != "reply":
            continue
        p = r["in_reply_to_status_id"]
        if not p:
            continue
        if p in by_tid:
            r["parent_kind"] = ""
        elif r["conversation_id"] != PENDING and p == r["conversation_id"]:
            r["parent_kind"] = "root"
        elif p in lookup:
            pt = lookup[p]
            # 父帖是我的原创帖（他直接回我的帖）也是对话起点
            if pt.get("author_id") == me_id and not replied_to(pt):
                r["parent_kind"] = "root"
            elif not replied_to(pt) and not quoted(pt):
                r["parent_kind"] = "root"
            else:
                r["parent_kind"] = "other"
        else:
            r["parent_kind"] = "unknown"

    # 4) 点赞：first_observed_at 跨天保留最早
    likes_state = state.setdefault("likes", {})
    seen_lists = set(state.setdefault("liker_lists_seen", []))
    for post_id, likers in raw.likers.items():
        first_time = post_id not in seen_lists
        pt = lookup.get(post_id)
        for uid, (uname, src) in likers.items():
            key = f"like:in:{uid}:{post_id}"
            prev = likes_state.get(key)
            if prev:
                fo, base_flag = prev["first_observed_at"], prev["observed_baseline"]
                if observed_at < fo:
                    fo = observed_at
            else:
                fo, base_flag = observed_at, first_time
            likes_state[key] = {"first_observed_at": fo, "observed_baseline": base_flag}
            acc = (uname or uid).lower()
            if acc in exclude or uid == me_id:
                continue
            rows.append({
                "id": key, "tweet_id": "", "ts": "", "account": acc, "account_id": uid,
                "direction": "in", "type": "like", "post_id": post_id,
                "conversation_id": (pt or {}).get("conversation_id") or conv.get(post_id) or post_id,
                "in_reply_to_status_id": "", "parent_kind": "", "text": "", "is_greeting": "",
                "post_created_at": fmt_dt(parse_dt((pt or {}).get("created_at"))),
                "first_observed_at": fo, "observed_baseline": str(base_flag).lower(),
                "source_file": src, "captured_at": observed_at,
            })
        seen_lists.add(post_id)
    state["liker_lists_seen"] = sorted(seen_lists)
    return rows, stats, filled_from_chain, lookup


# ---------- 校验和快照 ----------

def rate(a, b):
    return round(a / b, 4) if b else None


def validate(raw, rows, stats, filled, lookup, me_id, window_hours, now):
    warns = []
    talk = [r for r in rows if r["type"] in ("reply", "quote", "mention")]
    replies = [r for r in talk if r["type"] == "reply"]
    by_tid = {r["tweet_id"]: r for r in talk}

    # 字段缺失率（原始 data）
    missing = {}
    for kind in ("posts", "mentions", "quotes"):
        fs = raw.field_seen.get(kind)
        if not fs or not fs["_n"]:
            continue
        missing[kind] = {f: rate(fs[f], fs["_n"]) for f in REQUIRED_TWEET_FIELDS}
        missing[kind]["replied_to(回复中)"] = rate(fs["replied_to(回复中)"], fs["_rep"])
        for f, v in missing[kind].items():
            if v:
                warns.append(f"{kind} 原始数据缺 {f}：{v:.0%}")

    # 重复
    if raw.dup_same:
        warns.append(f"重复 tweet_id {raw.dup_same} 条（内容相同，已合并）")
    for tid in raw.dup_diff:
        warns.append(f"tweet_id 重复且内容不同（保留第一条）：tw:{tid}")

    # 空页 / 未翻到底
    for p in raw.pages:
        if p["n"] == 0 and p["has_next"]:
            warns.append(f"空页但还有 next_token：{p['file']}（不是结尾，要继续翻）")
        elif p["n"] == 0:
            warns.append(f"空页：{p['file']}（没有新数据，正常结束）")
    # 回复链
    no_parent = [r for r in replies if not r["in_reply_to_status_id"]]
    if no_parent:
        warns.append(f"{len(no_parent)} 条回复缺少 in_reply_to_status_id，这些回复无法确认往返")
    conv_pending = [r for r in talk if r["conversation_id"] == PENDING]
    if conv_pending:
        warns.append(f"{len(conv_pending)} 条互动的 conversation_id 补不上，标「{PENDING}」")
    pk = Counter(r["parent_kind"] or "in_table" for r in replies)
    if pk.get("unknown"):
        warns.append(f"{pk['unknown']} 条回复的父帖没采集到（parent_kind=unknown）")
    shared = Counter(r["post_id"] for r in talk)
    nshared = sum(1 for v in shared.values() if v > 1)
    if nshared:
        warns.append(f"{nshared} 个 post_id 被多条回复共用，检查是不是把 conversation_id 写进了 post_id")
    likes = [r for r in rows if r["type"] == "like"]
    bad_likes = [r for r in likes if not r["post_created_at"] or not r["first_observed_at"]]
    if bad_likes:
        warns.append(f"{len(bad_likes)} 个点赞时间信息不全，严格模式下不计分")

    # 时间窗对齐：用原始页的时间范围（posts=我对他，mentions=他对我）
    def rng(kind):
        ds = [parse_dt(x) for x in raw.kind_ranges.get(kind, []) if x]
        return (min(ds), max(ds)) if ds else (None, None)
    o0, o1 = rng("posts")
    i0, i1 = rng("mentions")
    window = {"out_posts": [fmt_dt(o0), fmt_dt(o1)], "in_mentions": [fmt_dt(i0), fmt_dt(i1)]}
    aligned = None
    if o0 and i0:
        a0, a1 = max(o0, i0), min(o1, i1)
        aligned = [fmt_dt(a0), fmt_dt(a1)]
        if abs((o0 - i0).total_seconds()) > 3600:
            warns.append(f"两个方向起点相差 {abs((o0 - i0).total_seconds()) / 3600:.1f} 小时"
                         f"（我对他从 {fmt_dt(o0)}，他对我从 {fmt_dt(i0)}）；对比时只用对齐窗口 {aligned[0]} ~ {aligned[1]}")
        if abs((o1 - i1).total_seconds()) > 3600:
            warns.append(f"两个方向终点相差 {abs((o1 - i1).total_seconds()) / 3600:.1f} 小时")
        if window_hours:
            span = (a1 - a0).total_seconds() / 3600
            if span < window_hours - 1:
                warns.append(f"对齐窗口只有 {span:.1f} 小时，目标 {window_hours} 小时")
        outside = sum(1 for r in talk if r["ts"] and not (a0 <= parse_dt(r["ts"]) <= a1))
        window["rows_outside_aligned"] = outside
    else:
        warns.append("只有一个方向的数据，无法检查时间窗对齐")
    window["aligned"] = aligned

    # 链接数：回复的父帖在表里、且是对方方向
    links = [r for r in replies if r["in_reply_to_status_id"] in by_tid
             and by_tid[r["in_reply_to_status_id"]]["direction"] != r["direction"]
             and by_tid[r["in_reply_to_status_id"]]["account_id"] == r["account_id"]]
    rounds = [r for r in links if r["is_greeting"] == "false"
              and by_tid[r["in_reply_to_status_id"]]["is_greeting"] == "false"]

    # 父帖只出现在 includes 里、是别人回我、但 mentions 没收到 → mentions 可能漏
    talk_ids = set(by_tid)
    inc_inbound = [tid for tid, t in raw.included.items()
                   if tid not in raw.tweets and t.get("in_reply_to_user_id") == me_id
                   and t.get("author_id") != me_id]
    if inc_inbound:
        warns.append(f"{len(inc_inbound)} 条别人回我的推文只在父帖展开里出现、mentions 没收到（入站可能漏收）")

    cov = {
        "replies": len(replies),
        "in_reply_to_status_id": rate(len(replies) - len(no_parent), len(replies)),
        "conversation_id": rate(len(talk) - len(conv_pending), len(talk)),
        "conversation_id_filled_from_chain": sum(1 for r in talk if r["tweet_id"] in filled),
        "parent_kind": dict(pk),
    }
    chain = {"links_reply_to_other_side": len(links), "substantive_rounds": len(rounds)}
    return warns, missing, window, cov, chain, inc_inbound


def snapshot(raw, rows, stats, warns, missing, window, cov, chain, inc_inbound, date, timezone_name=""):
    talk = [r for r in rows if r["type"] != "like"]
    by = Counter(f"{r['direction']}_{r['type']}" for r in rows)
    accounts = {d: len({r["account_id"] for r in rows if r["direction"] == d}) for d in ("in", "out")}
    both = len({r["account_id"] for r in rows if r["direction"] == "in"} &
               {r["account_id"] for r in rows if r["direction"] == "out"})
    snap = {
        "date": date,
        "timezone": timezone_name,
        "note": "不含任何账号名，只有计数和比例。",
        "profile_public_metrics": (raw.profile or {}).get("public_metrics"),
        "pages": {k: sum(1 for p in raw.pages if p["kind"] == k) for k in sorted({p["kind"] for p in raw.pages})},
        "raw_tweets": len(raw.tweets),
        "interactions": len(rows),
        "by_direction_type": dict(by),
        "greetings": sum(1 for r in talk if r["is_greeting"] == "true"),
        "accounts": {"in": accounts["in"], "out": accounts["out"], "both_directions": both},
        "discarded": {k: v for k, v in stats.items() if k.startswith("丢弃")},
        "my_original_posts": stats.get("我的原创帖", 0),
        "liker_lists": len(raw.likers),
        "reposters_total": sum(len(v) for v in raw.reposters.values()),
        "field_missing_rate": missing,
        "coverage": cov,
        "chains": chain,
        "inbound_only_in_parent_expansion": len(inc_inbound),
        "time_window_utc": window,
        "warnings": [scrub(w) for w in warns],
    }
    return snap


def scrub(text):
    return re.sub(r"@\w+", "@***", text)


def newest_ids(raw):
    out = {}
    for kind in ("posts", "mentions"):
        ids = [int(tid) for tid, k in raw.tweet_kind.items() if k == kind]
        if ids:
            out[kind] = str(max(ids))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="每日采集：原始 X JSON -> interactions.csv + 校验 + 匿名快照（离线）")
    ap.add_argument("--raw-dir", required=True, help="当天原始 JSON 目录（放 private/ 下）")
    ap.add_argument("--me-id", required=True, help="我的 X 数字 ID")
    ap.add_argument("--me", default="", help="我的用户名（只用于排除）")
    ap.add_argument("--snapshot-dir", required=True, help="不含账号名的快照输出目录")
    ap.add_argument("--state", help="跨天状态文件（默认 raw-dir 的上一级 state.json）")
    ap.add_argument("--greetings", default=os.path.join(os.path.dirname(__file__), "..", "config.json"),
                    help="config.json（读 greetings.words）或每行一个词的 txt")
    ap.add_argument("--exclude", default="grok", help="逗号分隔，默认 grok")
    ap.add_argument("--window-hours", type=float, default=0, help="目标窗口小时数，用于提示覆盖不够")
    ap.add_argument("--observed-at", help="采集时间（UTC ISO），默认现在")
    ap.add_argument("--date", help="快照日期标签，默认 raw-dir 目录名。请按 --tz 的本地日期命名，本参数不改这个默认")
    ap.add_argument("--tz", help="IANA 时区名，写入快照。优先级：--tz、config.json 的 timezone、系统本地时区")
    a = ap.parse_args(argv)
    configured = ""
    if a.greetings and str(a.greetings).endswith(".json") and os.path.exists(a.greetings):
        try:
            with open(a.greetings, encoding="utf-8") as fh:
                configured = ((json.load(fh).get("window") or {}).get("timezone")) or ""
        except (OSError, json.JSONDecodeError, AttributeError):
            configured = ""
    import relationship_stars as stars
    try:
        tz_name = stars.resolve_timezone_name(a.tz, configured)
        stars.zone(tz_name)
    except ValueError as exc:
        ap.error(str(exc))

    now = datetime.now(timezone.utc)
    observed_at = a.observed_at or fmt_dt(now)
    state_path = a.state or os.path.join(os.path.dirname(os.path.abspath(a.raw_dir)), "state.json")
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as fh:
            state = json.load(fh)
    raw = load_raw(a.raw_dir)
    greetings = load_greetings(a.greetings)
    exclude = [x.strip() for x in a.exclude.split(",") if x.strip()]
    if a.me:
        exclude = [x for x in exclude if x.lower() != a.me.lower()]
    rows, stats, filled, lookup = build(raw, a.me_id, a.me, greetings, exclude, state, observed_at)
    rows.sort(key=lambda r: (r["ts"] or r["first_observed_at"], r["id"]))
    warns, missing, window, cov, chain, inc_inbound = validate(raw, rows, stats, filled, lookup, a.me_id, a.window_hours, now)

    out_csv = os.path.join(a.raw_dir, "interactions.csv")
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    with open(os.path.join(a.raw_dir, "validation.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join("⚠ " + x for x in warns) + "\n")

    date = a.date or os.path.basename(os.path.normpath(a.raw_dir))
    snap = snapshot(raw, rows, stats, warns, missing, window, cov, chain, inc_inbound, date, tz_name)
    os.makedirs(a.snapshot_dir, exist_ok=True)
    with open(os.path.join(a.snapshot_dir, "snapshot.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=1)

    nid = newest_ids(raw)
    prev = state.get("newest_id", {})
    for k, v in nid.items():
        if int(v) > int(prev.get(k, 0)):
            prev[k] = v
    state["newest_id"] = prev
    state["last_run"] = {"date": date, "observed_at": observed_at}
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)

    for x in warns:
        print("⚠ " + x, file=sys.stderr)
    print(f"interactions: {len(rows)} 行 -> {out_csv}", file=sys.stderr)
    print(f"快照 -> {os.path.join(a.snapshot_dir, 'snapshot.json')}（时区 {tz_name}，日期标签 {date}）；下一晚 since_id: {prev}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
