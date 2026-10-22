#!/usr/bin/env python3
"""互动关系星级（SPEC v0.2 第 6 节）——离线打分。

读 interactions.csv（SPEC 5.1 格式，例如 scripts/daily_collect.py 的输出），按区间算
持续性 P、双向性 B、严格往返 R、点赞加分、问候上限，给出 0–100 分和 1–5 星。
ts 存 UTC，切日期和周前先转成 --tz 时区。所有参数都是初始值，待校准（SPEC 第 11 节）。

用法：
  python3 scripts/relationship_stars.py --interactions data/interactions.csv \
      --end 2026-10-19 [--days 30] [--tz America/Los_Angeles] [--like-time strict|observed] \
      [--config config.json] [--out output/relationship/relationship.csv]
  天数和点赞计时不写就用 config.json。时区优先级：--tz、config.json 的 timezone、系统本地时区。
"""
import argparse
import csv
import math
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

sys.path.insert(0, os.path.dirname(__file__))
from daily_collect import is_greeting  # noqa: E402

import json

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
# 内置默认值 = SPEC v0.2，和 config.json 一致；config.json 缺项时用这里的
CFG = dict(W_P=0.40, W_B=0.35, W_R=0.25, ALPHA=0.30, GREET_DAY=0.2, GREET_DAY_CAP=1.0,
           GREET_SHARE_CAP=0.8, GREET_MAX_SCORE=39.9, LIKE_PTS=0.5, LIKE_CAP=5.0,
           MIN_RAW=3, MIN_DAYS=2, STARS={5: 80, 4: 60, 3: 40, 2: 20})


def load_config(path=CONFIG_PATH):
    """读 config.json，返回 (原始配置 dict, 打分用的 CFG)。"""
    conf = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            conf = json.load(fh)
    w, pe, gc = conf.get("weights", {}), conf.get("persistence", {}), conf.get("greeting_cap", {})
    lk, ins = conf.get("likes", {}), conf.get("insufficient", {})
    cfg = dict(CFG)
    cfg.update({k: v for k, v in dict(
        W_P=w.get("persistence"), W_B=w.get("bidirectional"), W_R=w.get("rounds"),
        ALPHA=pe.get("alpha"), GREET_DAY=pe.get("greet_day"), GREET_DAY_CAP=pe.get("greet_day_cap"),
        GREET_SHARE_CAP=gc.get("share"), GREET_MAX_SCORE=gc.get("max_score"),
        LIKE_PTS=lk.get("points_each"), LIKE_CAP=lk.get("cap"),
        MIN_RAW=ins.get("min_raw"), MIN_DAYS=ins.get("min_days")).items() if v is not None})
    if conf.get("stars"):
        cfg["STARS"] = {int(k): v for k, v in conf["stars"].items()}
    return conf, cfg


def stars_of(S, cfg=CFG):
    for n in (5, 4, 3, 2):
        if S >= cfg["STARS"][n]:
            return n
    return 1
TALK = ("reply", "quote", "mention")


_TZ_ERROR = "时区无效，请用 IANA 名称，例如 Asia/Shanghai"


def local_timezone_name():
    """本机 IANA 时区名。读不到时用 UTC，不返回路径。"""
    current = datetime.now().astimezone().tzinfo
    key = getattr(current, "key", None)
    if key:
        name = str(key)
    else:
        name = ""
        env = os.environ.get("TZ", "").strip()
        if env.upper() in ("UTC", "GMT"):
            name = "UTC"
        elif env:
            picked = env[1:] if env.startswith(":") else env
            if "/" in picked and " " not in picked and "\\" not in picked:
                name = picked
        if not name:
            try:
                target = os.path.realpath("/etc/localtime").replace("\\", "/")
            except OSError:
                target = ""
            marker = "zoneinfo/"
            if marker in target:
                name = target.split(marker, 1)[1]
    if name in ("Etc/UTC", "Etc/GMT"):
        return "UTC"
    return name or "UTC"


def resolve_timezone_name(explicit=None, configured=None):
    """--tz 优先，其次配置里的 timezone，都空着就用本机时区。"""
    name = str(explicit or "").strip() or str(configured or "").strip()
    return name or local_timezone_name()


def zone(name):
    """把 IANA 名变成时区对象。没有 zoneinfo 模块时退回 UTC；名字无效则报固定中文，不带路径。"""
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except Exception:
        raise ValueError(_TZ_ERROR) from None


def to_local(s, tz):
    if not s:
        return None
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(tz)


def prepare(rows, tz, greetings=None, max_len=15):
    """去重（tweet_id / id），解析时间，问候字段缺失时现算。"""
    seen, out = set(), []
    for r in rows:
        key = ("tw:" + r["tweet_id"]) if r.get("type") in TALK and r.get("tweet_id") else r["id"]
        if key in seen:
            continue
        seen.add(key)
        r = dict(r)
        r["dt"] = to_local(r.get("ts"), tz)
        r["post_dt"] = to_local(r.get("post_created_at"), tz)
        r["obs_dt"] = to_local(r.get("first_observed_at"), tz)
        if r.get("type") in TALK:
            g = r.get("is_greeting")
            r["greet"] = (g == "true") if g in ("true", "false") else is_greeting(r.get("text"), greetings or [], max_len)
        out.append(r)
    return out


def like_in_range(r, s, e, mode):
    if mode == "strict":
        return r["post_dt"] is not None and r["obs_dt"] is not None and r["post_dt"].date() >= s and r["obs_dt"].date() <= e
    return r["obs_dt"] is not None and s <= r["obs_dt"].date() <= e and r.get("observed_baseline") != "true"


def window_scale(s, e, observed):
    """区间长度 D 和周序号。observed 为 None 时按整段日历（SPEC 6.1）。

    传入有数据的日期时，缺口是无数据，不是零互动：D 只数这些日期，并按时间顺序重新接上再切周。
    整天都有数据时，结果与日历算法相同。
    """
    span_days = (e - s).days + 1

    def calendar_week(day):
        return (day - s).days // 7

    if observed is None:
        return span_days, calendar_week, math.ceil(span_days / 7)
    covered = []
    day = s
    for _ in range(span_days):
        if day in observed:
            covered.append(day)
        day += timedelta(days=1)
    if len(covered) in (0, span_days):
        return span_days, calendar_week, math.ceil(span_days / 7)
    index = {day: i for i, day in enumerate(covered)}

    def covered_week(day):
        return index[day] // 7 if day in index else calendar_week(day)

    return len(covered), covered_week, math.ceil(len(covered) / 7)


def score(rows, s, e, like_mode="strict", cfg=CFG, observed=None):
    if observed is not None:
        observed = set(observed)
        for r in rows:
            if r.get("dt") and s <= r["dt"].date() <= e:
                observed.add(r["dt"].date())
    D, week_of, K = window_scale(s, e, observed)
    talk = [r for r in rows if r["type"] in TALK and r["dt"] and s <= r["dt"].date() <= e]
    likes_all = [r for r in rows if r["type"] == "like"]
    likes = [r for r in likes_all if like_in_range(r, s, e, like_mode)]
    sub = [r for r in talk if not r["greet"]]
    greet = [r for r in talk if r["greet"]]
    res = dict(raw=len(talk), sub=len(sub), greet=len(greet),
               active_days=len({r["dt"].date() for r in talk}),
               sub_days=len({r["dt"].date() for r in sub}),
               O=sum(r["direction"] == "out" for r in sub), I=sum(r["direction"] == "in" for r in sub),
               O_raw=sum(r["direction"] == "out" for r in talk), I_raw=sum(r["direction"] == "in" for r in talk),
               L_in=sum(r["direction"] == "in" for r in likes), L_out=sum(r["direction"] == "out" for r in likes),
               likes_unscored=len(likes_all) - len(likes))
    by_tid = {r["tweet_id"]: r for r in talk}
    rounds = unconfirmed = branch = 0
    for r in sub:
        if r["type"] != "reply":
            continue
        p = r.get("in_reply_to_status_id")
        if p and p in by_tid:
            par = by_tid[p]
            if par["direction"] != r["direction"] and not par["greet"]:
                rounds += 1
        elif r.get("parent_kind") == "root":
            pass
        elif r.get("parent_kind") == "other":
            branch += 1
        else:
            unconfirmed += 1
    convs = {r.get("conversation_id") or r["tweet_id"] for r in sub}
    T = len(convs)
    res.update(T=T, rounds=rounds, unconfirmed=unconfirmed, branch=branch)
    if len(talk) < cfg["MIN_RAW"] or res["active_days"] < cfg["MIN_DAYS"]:
        res["status"] = "样本不足"
        res["reason"] = "这段时间只有点赞，没有说话类互动" if not talk and likes_all else "互动太少，先不打分"
        return res
    sub_days = {r["dt"].date() for r in sub}
    greet_only = {r["dt"].date() for r in greet} - sub_days
    p_day = min(1.0, (len(sub_days) + min(cfg["GREET_DAY_CAP"], cfg["GREET_DAY"] * len(greet_only))) / (cfg["ALPHA"] * D))
    p_week = len({week_of(r["dt"].date()) for r in sub}) / K
    P = 0.5 * p_day + 0.5 * p_week
    O, I = res["O"], res["I"]
    B = min(O, I) / max(O, I) if O >= 1 and I >= 1 else 0.0
    R = min(1.0, rounds / max(2 * T, 4)) if T else 0.0
    base = 100 * (cfg["W_P"] * P + cfg["W_B"] * B + cfg["W_R"] * R)
    bonus = min(cfg["LIKE_CAP"], cfg["LIKE_PTS"] * (res["L_in"] + res["L_out"]), base)
    S = min(100.0, base + bonus)
    share = len(greet) / len(talk)
    capped = share >= cfg["GREET_SHARE_CAP"]
    if capped:
        S = min(S, cfg["GREET_MAX_SCORE"])
    stars = stars_of(S, cfg)
    res.update(status="ok", greet_share=round(share, 2), P=round(P, 3), B=round(B, 3), R=round(R, 3),
               base=round(base, 1), bonus=round(bonus, 1), score=round(S, 1), stars=stars, greet_cap=capped)
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description="互动关系星级（离线）")
    ap.add_argument("--interactions", required=True)
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("--end", help="截止日 YYYY-MM-DD，默认该时区的今天")
    ap.add_argument("--days", type=int)
    ap.add_argument("--tz", help="IANA 时区。不写则用 config.json 的 timezone，再没有就用本机时区")
    ap.add_argument("--like-time", choices=["strict", "observed"])
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    conf, cfg = load_config(a.config)
    win = conf.get("window", {})
    a.days = a.days or win.get("days", 30)
    a.like_time = a.like_time or conf.get("likes", {}).get("time_mode", "strict")
    try:
        tz_name = resolve_timezone_name(a.tz, win.get("timezone"))
        tz = zone(tz_name)
    except ValueError as exc:
        ap.error(str(exc))
    g = conf.get("greetings", {})
    with open(a.interactions, encoding="utf-8") as f:
        rows = prepare(list(csv.DictReader(f)), tz, g.get("words", []), g.get("max_core_len", 15))
    e = date.fromisoformat(a.end) if a.end else datetime.now(tz).date()
    s = e - timedelta(days=a.days - 1)
    by = defaultdict(list)
    for r in rows:
        by[r["account"]].append(r)
    results = []
    for acc, rs in by.items():
        res = score(rs, s, e, a.like_time, cfg)
        res["account"] = acc
        results.append(res)
    results.sort(key=lambda r: (r["status"] != "ok", -r.get("score", 0), r["account"]))
    print(f"互动关系星级 · 最近 {a.days} 天（{s} ~ {e}，{tz_name}）· 点赞计时：{a.like_time}")
    print("这里只统计公开的回复、引用和点赞。分数只是线索，不代表真实关系。")
    for r in results:
        lab = f"{'★' * r['stars']}{'☆' * (5 - r['stars'])} {r['score']}" if r["status"] == "ok" else "样本不足"
        print(f"{r['account']:<20} {lab:<14} 我对他 {r['O']} / 他对我 {r['I']} 实质；问候 {r['greet']}；往返 {r['rounds']}")
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        keys = ["account", "status", "score", "stars", "P", "B", "R", "base", "bonus", "greet_cap", "greet_share",
                "raw", "sub", "greet", "O", "I", "O_raw", "I_raw", "active_days", "sub_days", "T", "rounds",
                "unconfirmed", "branch", "L_in", "L_out", "likes_unscored", "reason"]
        with open(a.out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            w.writerows(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
