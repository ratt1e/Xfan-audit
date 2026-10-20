"""「互动关系星级」评分的参考实现（对应 SPEC v0.2），只用来核对 SPEC 第 14 节的期望值。
正式实现请按 docs/SPEC_relationship_stars.md 编写；这里为了简单，时间按 naive 本地时间处理。

用法：python reference_score.py [interactions.csv] [--like-time strict|observed] [--end 2026-10-19]"""
import argparse, csv, math, re, sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

CFG = dict(
    W_P=0.40, W_B=0.35, W_R=0.25,       # 待验证
    ALPHA=0.30,                          # 实质互动天数达到区间的 30% 记满
    GREET_DAY=0.2, GREET_DAY_CAP=1.0,    # 每个「只有问候」的日子算 0.2 天，合计最多 1 天
    GREET_SHARE_CAP=0.8, GREET_MAX_SCORE=39.9,   # 问候占比 ≥80% → 最多 2 星
    LIKE_PTS=0.5, LIKE_CAP=5.0,
    MIN_RAW=3, MIN_DAYS=2,
)
GREET = ["早安", "早上好", "午安", "晚安", "互关", "回关", "互粉", "浇水", "浇朋友", "浇浇", "打卡", "来了", "你好", "新朋友"]
GREET_EN = ["gm", "gn", "follow back"]

def is_greeting(text):
    t = re.sub(r"@\w+|https?://\S+", "", text or "")
    core = re.sub(r"[\s\W_]+", "", t, flags=re.UNICODE)
    if not core:
        return True
    hit = any(k in t for k in GREET) or any(re.search(rf"\b{re.escape(k)}\b", t, re.I) for k in GREET_EN)
    return len(core) <= 15 and hit

def parse(s):
    return datetime.fromisoformat(s) if s else None

def load_and_validate(path):
    """去重 + 校验。返回 (rows, warnings)。"""
    raw = list(csv.DictReader(open(path, encoding="utf-8")))
    warns, by_id, out = [], {}, []
    dup_same = dup_conflict = 0
    for r in raw:
        key = r["id"]
        if r["type"] in ("reply", "quote"):
            if not r.get("tweet_id"):
                warns.append(f"回复缺少 tweet_id：{key}"); continue
            key = "tw:" + r["tweet_id"]
        if key in by_id:
            a = by_id[key]
            if all(a.get(f) == r.get(f) for f in ("account", "direction", "type", "text", "ts", "in_reply_to_status_id")):
                dup_same += 1
            else:
                dup_conflict += 1; warns.append(f"tweet_id 重复且内容不同（保留第一条）：{key}")
            continue
        by_id[key] = r; out.append(r)
    if dup_same: warns.append(f"重复 tweet_id {dup_same} 条（内容相同，已合并）")
    if dup_conflict: warns.append(f"重复 tweet_id 且内容冲突 {dup_conflict} 条")
    # 同一对话里一个 post_id 被多条回复共用，通常是把对话 ID 当成了推文 ID
    pc = Counter(r["post_id"] for r in out if r["type"] in ("reply", "quote"))
    bad = [p for p, c in pc.items() if c > 1]
    if bad: warns.append(f"{len(bad)} 个 post_id 被多条回复共用，检查是不是把 conversation_id 写进了 post_id")
    miss = sum(1 for r in out if r["type"] == "reply" and not r.get("in_reply_to_status_id"))
    if miss: warns.append(f"{miss} 条回复缺少 in_reply_to_status_id，这些回复无法确认往返")
    for r in out:
        r["dt"] = parse(r.get("ts"))
        r["post_dt"] = parse(r.get("post_created_at"))
        r["obs_dt"] = parse(r.get("first_observed_at"))
        if r["type"] in ("reply", "quote"):
            r["greet"] = is_greeting(r["text"])
    return out, warns

def like_in_range(r, s, e, mode):
    """strict：点赞时间一定落在 [post_created_at, first_observed_at] 里，这个区间整个落在 [s, e] 内才计入。
    observed：按第一次观察到的时间算，基线批次（第一次采集就看到的旧点赞）不算。"""
    if mode == "strict":
        return r["post_dt"] is not None and r["obs_dt"] is not None and r["post_dt"].date() >= s and r["obs_dt"].date() <= e
    return r["obs_dt"] is not None and s <= r["obs_dt"].date() <= e and r.get("observed_baseline") != "true"

def score(rows, s, e, like_mode="strict", cfg=CFG):
    D = (e - s).days + 1
    K = math.ceil(D / 7)
    talk = [r for r in rows if r["type"] in ("reply", "quote") and r["dt"] and s <= r["dt"].date() <= e]
    likes_all = [r for r in rows if r["type"] == "like"]
    likes = [r for r in likes_all if like_in_range(r, s, e, like_mode)]
    sub = [r for r in talk if not r["greet"]]
    greet = [r for r in talk if r["greet"]]
    res = dict(raw=len(talk), sub=len(sub), greet=len(greet),
               active_days=len({r["dt"].date() for r in talk}),
               O=sum(r["direction"] == "out" for r in sub), I=sum(r["direction"] == "in" for r in sub),
               L_in=sum(r["direction"] == "in" for r in likes), L_out=sum(r["direction"] == "out" for r in likes),
               likes_unscored=len(likes_all) - len(likes))
    # 往返（严格）：父推文必须是本表里对方方向的实质互动
    by_tid = {r["tweet_id"]: r for r in talk}
    rounds = unconfirmed = branch = 0
    for r in sub:
        p = r.get("in_reply_to_status_id")
        if p and p in by_tid:
            par = by_tid[p]
            if par["direction"] != r["direction"] and not par["greet"]:
                rounds += 1
        elif r.get("parent_kind") == "root":
            pass                                   # 回复对话起点帖，属于开头，不是往返
        elif r.get("parent_kind") == "other":
            branch += 1                            # 已确认是别的分支
        else:
            unconfirmed += 1                       # 缺 in_reply_to 或父推文没采集到
    # 宽松提示（不计分）：同一对话内方向切换次数
    seqs = defaultdict(list)
    for r in sorted(sub, key=lambda r: r["dt"]):
        seqs[r["conversation_id"]].append(r["direction"])
    loose = sum(sum(a != b for a, b in zip(q, q[1:])) for q in seqs.values())
    T = len(seqs)
    res.update(T=T, rounds=rounds, unconfirmed=unconfirmed, branch=branch, loose_switches=loose)
    if len(talk) < cfg["MIN_RAW"] or res["active_days"] < cfg["MIN_DAYS"]:
        res["status"] = "样本不足"; return res
    sub_days = {r["dt"].date() for r in sub}
    greet_only_days = {r["dt"].date() for r in greet} - sub_days
    g_eq = min(cfg["GREET_DAY_CAP"], cfg["GREET_DAY"] * len(greet_only_days))
    p_day = min(1.0, (len(sub_days) + g_eq) / (cfg["ALPHA"] * D))
    weeks = {(r["dt"].date() - s).days // 7 for r in sub}
    p_week = len(weeks) / K
    P = 0.5 * p_day + 0.5 * p_week
    O, I = res["O"], res["I"]
    B = min(O, I) / max(O, I) if O >= 1 and I >= 1 else 0.0
    R = min(1.0, rounds / max(2 * T, 4)) if T else 0.0
    base = 100 * (cfg["W_P"] * P + cfg["W_B"] * B + cfg["W_R"] * R)
    bonus = min(cfg["LIKE_CAP"], cfg["LIKE_PTS"] * (res["L_in"] + res["L_out"]), base)
    S = min(100.0, base + bonus)
    greet_share = len(greet) / len(talk)
    capped = greet_share >= cfg["GREET_SHARE_CAP"]
    if capped:
        S = min(S, cfg["GREET_MAX_SCORE"])
    stars = 5 if S >= 80 else 4 if S >= 60 else 3 if S >= 40 else 2 if S >= 20 else 1
    res.update(status="ok", greet_share=round(greet_share, 2), greet_only_days=len(greet_only_days),
               p_day=round(p_day, 3), p_week=round(p_week, 3), P=round(P, 3), B=round(B, 3), R=round(R, 3),
               base=round(base, 1), bonus=round(bonus, 1), score=round(S, 1), stars=stars,
               greet_cap=capped)
    return res

def trend(now, prev):
    if now["status"] == "ok" and prev["status"] == "ok":
        d = now["score"] - prev["score"]
        return f"↑ +{d:.1f}" if d >= 10 else f"↓ {d:.1f}" if d <= -10 else "→ 持平"
    if now["status"] == "ok": return "新出现"
    if prev["status"] == "ok": return "变少了"
    return "—"

def label(r):
    if r["status"] != "ok": return "样本不足"
    return f"{'★' * r['stars']}{'☆' * (5 - r['stars'])} {r['score']}" + ("（问候上限）" if r["greet_cap"] else "")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default="interactions.csv")
    ap.add_argument("--like-time", choices=["strict", "observed"], default="strict")
    ap.add_argument("--end", default="2026-10-19")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    rows, warns = load_and_validate(a.path)
    for w in warns: print("⚠", w, file=sys.stderr)
    end = date.fromisoformat(a.end); start = end - timedelta(days=a.days - 1)
    pe = start - timedelta(days=1); ps = pe - timedelta(days=a.days - 1)
    by = defaultdict(list)
    for r in rows: by[r["account"]].append(r)
    mode = "严格（时间能确定的点赞）" if a.like_time == "strict" else "按观察时间（点赞时间是推断的）"
    print(f"== 最近 {a.days} 天 {start}~{end}，点赞计时：{mode}")
    for acc in sorted(by):
        now = score(by[acc], start, end, a.like_time); prev = score(by[acc], ps, pe, a.like_time)
        print(f"{acc}  {label(now)}  趋势 {trend(now, prev)}")
        if a.verbose: print("   ", now)
