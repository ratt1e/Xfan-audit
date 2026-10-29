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
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import follow_diff  # noqa: E402
import not_followed_back as nfb  # noqa: E402
import relationship_stars as rs  # noqa: E402
from daily_root import load_daily_root, check_output, clear_own_outputs, coverage_lines, list_facts, write_roster, find_exclude, apply_exclude, filter_follow_diff, filter_not_back, filter_people  # noqa: E402

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


def analyze(data, conf, cfg, end=None, days=None, all_days=False, hide=()):
    win = conf.get("window", {})
    tz_name = rs.resolve_timezone_name(configured=win.get("timezone"))
    tz = rs.zone(tz_name)
    g = conf.get("greetings", {})
    excl = {norm(a) for a in conf.get("exclude_accounts", []) + [conf.get("me") or ""] if norm(a)}
    hide = {norm(a) for a in (hide or ()) if norm(a)}
    rows = [r for r in data["rows"] if r["account"] not in excl]
    prep = rs.prepare(rows, tz, g.get("words", []), g.get("max_core_len", 15))
    dts = [r["dt"].date() for r in prep if r.get("dt")]
    if end in (None, "auto"):
        end = win.get("end", "auto")
    e = (max(dts) if dts else datetime.now(tz).date()) if end == "auto" else date.fromisoformat(end)
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
    accounts -= hide
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
    meta = dict(start=str(s), end=str(e), days=days, tz=tz_name, n_rows=len(rows),
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


def dashboard_css():
    """和打分脚本放在一起的样式。生成的看板把这段嵌进去，不额外请求文件。"""
    page = os.path.join(HERE, "engine", "dashboard.css")
    with open(page, encoding="utf-8") as f:
        text = f.read().strip()
    if not text or ".card" not in text:
        raise ValueError("看板样式读不了")
    return text


_PROFILE_ANCHOR = """  function profileAnchor(handle, text) {
    if (!handle) return escHtml(text);
    var href = "https:" + "//x.com/" + handle;
    return '<a href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(text) + "</a>";
  }"""

_PROFILE_ANCHOR_MASKED = """  function profileAnchor(handle, text) {
    return escHtml(text);
  }"""

_BOOT_JS = """
(function () {
  if (typeof document === "undefined") return;
  var payload = JSON.parse(document.getElementById("fan-audit-data").textContent);
  var state = {mode: "custom", open: {}, masked: false};
  function storedMask() {
    try {
      return localStorage.getItem("fan-audit-mask") === "1";
    } catch (err) {
      return false;
    }
  }
  state.masked = !!payload.masked || location.hash === "#mask" || storedMask();
  var maskBtn = document.getElementById("mask");
  function syncMask() {
    if (!maskBtn) return;
    maskBtn.classList.toggle("on", state.masked);
    maskBtn.textContent = state.masked ? "显示账号名" : "打码模式";
  }
  var writing = false;
  var startEl = document.getElementById("start");
  var endEl = document.getElementById("end");
  var tzEl = document.getElementById("tz");
  var tzLabel = document.getElementById("tz-label");
  var out = document.getElementById("out");
  function chosenZone() {
    var value = tzEl && tzEl.value ? String(tzEl.value).trim() : "";
    if (value) return value;
    if (payload.tz) return payload.tz;
    var win = payload.config && payload.config.window;
    return win && win.timezone ? String(win.timezone).trim() : "";
  }
  function optionsFor() {
    var opt = {me: payload.me || "", config: payload.config, masked: !!payload.masked || !!state.masked, showAll: true, open: state.open};
    var zoneName = chosenZone();
    if (zoneName) opt.tz = zoneName;
    if (state.mode === "all") opt.allDays = true;
    else if (state.mode === "7" || state.mode === "30") opt.days = state.mode === "7" ? 7 : 30;
    else {
      opt.end = endEl.value || payload.view.end;
      var start = startEl.value || payload.view.start;
      if (opt.end && start) {
        var span = Math.round((Date.parse(opt.end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000) + 1;
        opt.days = span >= 1 ? span : 1;
      } else opt.days = payload.view.days;
    }
    return opt;
  }
  function showZoneError(message) {
    if (tzLabel) tzLabel.textContent = "当前时区：" + chosenZone();
    var warn = document.getElementById("tz-warn");
    if (!warn && tzLabel && tzLabel.parentNode) {
      warn = document.createElement("div");
      warn.id = "tz-warn";
      warn.className = "warn";
      tzLabel.parentNode.insertBefore(warn, tzLabel.nextSibling);
    }
    if (warn) warn.textContent = message || "时区无效，请填 IANA 名称，例如 Asia/Shanghai";
  }
  function paint(keep) {
    var scrollY = keep ? window.scrollY : 0;
    ["d7", "d30", "dall"].forEach(function (id) {
      var button = document.getElementById(id);
      button.classList.toggle("on", button.getAttribute("data-mode") === state.mode);
    });
    var view;
    try {
      view = FanAudit.renderReport(payload.data, optionsFor());
    } catch (err) {
      showZoneError(err && err.message);
      return;
    }
    var warn = document.getElementById("tz-warn");
    if (warn) warn.textContent = "";
    writing = true;
    startEl.value = view.meta.start;
    endEl.value = view.meta.end;
    writing = false;
    var meta = view.meta;
    if (tzLabel) tzLabel.textContent = "当前时区：" + (meta.tz || chosenZone());
    var cover = "区间 " + meta.start + " ~ " + meta.end + "（请求 " + meta.days + " 天）";
    cover += "；覆盖 " + meta.covered + " 天";
    if (meta.uncovered) cover += "，" + meta.uncovered + " 天无数据（不算零互动）";
    else cover += "，无数据 0 天";
    if (meta.tz) cover += " · 当前时区：" + meta.tz;
    document.getElementById("coverage").textContent = cover + " · 只统计公开回复、引用和点赞 · 分数只是线索，不代表真实关系";
    out.innerHTML = view.html;
    if (keep) window.scrollTo(0, scrollY);
  }
  ["d7", "d30", "dall"].forEach(function (id) {
    document.getElementById(id).onclick = function () {
      state.mode = this.getAttribute("data-mode");
      paint();
    };
  });
  startEl.onchange = endEl.onchange = function () {
    if (writing) return;
    state.mode = "custom";
    paint();
  };
  if (tzEl) tzEl.onchange = function () {
    if (!String(tzEl.value || "").trim()) tzEl.value = payload.tz || "";
    paint();
  };
  if (maskBtn) maskBtn.onclick = function () {
    if (payload.masked) return;
    state.masked = !state.masked;
    try {
      localStorage.setItem("fan-audit-mask", state.masked ? "1" : "0");
    } catch (err) {}
    if (state.masked) location.hash = "mask";
    else if (location.hash === "#mask") location.hash = "";
    syncMask();
    paint(true);
  };
  syncMask();
  out.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== out) {
      if (el.getAttribute && el.getAttribute("data-expand")) {
        state.open[el.getAttribute("data-expand")] = true;
        paint(true);
        return;
      }
      if (el.getAttribute && el.getAttribute("data-jump-id")) {
        jump(el.getAttribute("data-jump-id"));
        return;
      }
      if (el.getAttribute && el.getAttribute("data-jump")) {
        jump("tier-" + el.getAttribute("data-jump"));
        return;
      }
      el = el.parentNode;
    }
  });
  function jump(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var plan = FanAudit.jumpPlan(+(el.getAttribute("data-total") || 0));
    var note = document.getElementById("jump-note");
    if (note) note.textContent = plan.message;
    if (plan.scroll) el.scrollIntoView({behavior: "smooth", block: "start"});
    var title = el.querySelector("h2");
    if (!title) return;
    title.classList.remove("flash");
    void title.offsetWidth;
    title.classList.add("flash");
  }
  paint();
})();
"""


def dashboard_engine(public=False):
    """和油猴版同一段打分脚本。打码版拿掉主页链接，生成的文件不额外请求。"""
    page = os.path.join(HERE, "engine", "fan_audit_engine.js")
    with open(page, encoding="utf-8") as f:
        script = f.read().strip()
    if _PROFILE_ANCHOR not in script:
        raise ValueError("打分脚本读不了")
    if public:
        script = script.replace(_PROFILE_ANCHOR, _PROFILE_ANCHOR_MASKED, 1)
        for banned in ("https", "x.com", 'target="_blank"', "user_"):
            if banned in script:
                raise ValueError("打码脚本里还有不该出现的内容")
    return script


def _json_for_html(payload):
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return text.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")


class _OrderMask:
    """打码用的代号。同一真实值始终同一代号，并且按原字符串的顺序编号，排序才和私有版一致。"""

    def __init__(self):
        self.handles, self.ids, self.tokens = {}, {}, {}

    def add_handle(self, value):
        key = norm(value)
        if key:
            self.handles.setdefault(key, None)

    def add_id(self, value):
        key = str(value or "").strip()
        if key:
            self.ids.setdefault(key, None)

    def add_token(self, value):
        key = str(value or "").strip()
        if key:
            self.tokens.setdefault(key, None)

    def finish(self):
        for index, key in enumerate(sorted(self.handles), 1):
            self.handles[key] = "a%04d" % index
        for index, key in enumerate(sorted(self.ids), 1):
            self.ids[key] = "i%04d" % index
        for index, key in enumerate(sorted(self.tokens), 1):
            self.tokens[key] = "t%04d" % index

    def handle(self, value):
        key = norm(value)
        return "" if not key else self.handles[key]

    def uid(self, value):
        key = str(value or "").strip()
        return "" if not key else self.ids[key]

    def token(self, value):
        key = str(value or "").strip()
        return "" if not key else self.tokens[key]


def _role_items(directory, role):
    if not directory:
        return None
    loaded = follow_diff.load_role(directory, None, role)
    if loaded is None:
        return None
    return [{"id": item.get("id") or "", "handle": item.get("handle") or ""} for item in loaded["items"]]


def _map_handle(mask, value):
    return mask.handle(value) if mask else norm(value)


def _map_plain(mask, value, kind):
    text = str(value or "").strip()
    if not text or not mask:
        return text
    return mask.uid(text) if kind == "id" else mask.token(text)


def _emit_people(items, mask):
    if not items:
        return []
    out = []
    for item in items:
        handle = _map_handle(mask, item.get("handle"))
        uid = _map_plain(mask, item.get("id"), "id")
        if handle or uid:
            out.append({"id": uid, "handle": handle})
    return out


def _people_map(mapping, mask):
    out = {}
    for handle, row in (mapping or {}).items():
        key = _map_handle(mask, handle)
        if not key:
            continue
        count = row.get("followers_count")
        out[key] = {
            "verified": row.get("verified") or "",
            "is_blue_verified": row.get("is_blue_verified") or "",
            "followers_count": "" if count in (None, "") else count,
        }
    return out


def _embed_rows(rows, conf, mask):
    greet = conf.get("greetings") or {}
    words = greet.get("words") or []
    max_len = greet.get("max_core_len", 15)
    from daily_collect import is_greeting
    embedded = []
    for row in rows or []:
        kind = (row.get("type") or "").strip()
        item = {
            "id": _map_plain(mask, row.get("id"), "token"),
            "tweet_id": _map_plain(mask, row.get("tweet_id"), "token"),
            "ts": row.get("ts") or "",
            "account": _map_handle(mask, row.get("account")),
            "direction": row.get("direction") or "",
            "type": kind,
            "conversation_id": _map_plain(mask, row.get("conversation_id"), "token"),
            "in_reply_to_status_id": _map_plain(mask, row.get("in_reply_to_status_id"), "token"),
            "parent_kind": row.get("parent_kind") or "",
            "post_created_at": row.get("post_created_at") or "",
            "first_observed_at": row.get("first_observed_at") or "",
            "observed_baseline": row.get("observed_baseline") or "",
        }
        if kind in ("reply", "quote", "mention"):
            flag = row.get("is_greeting")
            if flag not in ("true", "false"):
                flag = "true" if is_greeting(row.get("text"), words, max_len) else "false"
            item["is_greeting"] = flag
        embedded.append(item)
    return embedded


def _scoring_config(conf, mask):
    cfg = {}
    for key in ("window", "weights", "persistence", "greeting_cap", "likes", "insufficient", "stars", "tiers", "greetings"):
        value = conf.get(key)
        if value is not None:
            cfg[key] = _strip_notes(value)
    cfg["exclude_accounts"] = [_map_handle(mask, name) for name in (conf.get("exclude_accounts") or [])]
    return cfg


def _strip_notes(value):
    if isinstance(value, dict):
        return {key: _strip_notes(item) for key, item in value.items() if not str(key).startswith("_")}
    if isinstance(value, list):
        return [_strip_notes(item) for item in value]
    return value


def dashboard_payload(data, conf, meta, public, lists_dir, prev_dir, keep_path, bundle=None, exclude_ids=(), exclude_handles=()):
    """嵌进看板的原始行和关系名单。打码版只留代号，不留用户名、用户 ID 和正文。"""
    mask = _OrderMask() if public else None
    if bundle is None:
        following_items = _role_items(lists_dir, "following")
        follower_items = _role_items(lists_dir, "followers")
        prev_following = _role_items(prev_dir, "following")
        prev_followers = _role_items(prev_dir, "followers")
    else:
        following_items = bundle.get("following")
        follower_items = bundle.get("followers")
        prev_following = bundle.get("prev_following")
        prev_followers = bundle.get("prev_followers")
    following_items = filter_people(following_items, exclude_ids, exclude_handles)
    follower_items = filter_people(follower_items, exclude_ids, exclude_handles)
    prev_following = filter_people(prev_following, exclude_ids, exclude_handles)
    prev_followers = filter_people(prev_followers, exclude_ids, exclude_handles)
    keep_ids, keep_handles = nfb.load_keep(keep_path)
    source_rows = list(data.get("rows") or [])
    if exclude_handles:
        blocked = {norm(name) for name in exclude_handles}
        source_rows = [row for row in source_rows if norm(row.get("account")) not in blocked]
    if mask:
        for row in source_rows:
            mask.add_handle(row.get("account"))
            mask.add_token(row.get("id"))
            mask.add_token(row.get("tweet_id"))
            mask.add_token(row.get("conversation_id"))
            mask.add_token(row.get("in_reply_to_status_id"))
        for bucket in (data.get("following"), data.get("followers"), data.get("profiles")):
            for handle in bucket or {}:
                mask.add_handle(handle)
        for group in (following_items, follower_items, prev_following, prev_followers):
            for item in group or []:
                mask.add_handle(item.get("handle"))
                mask.add_id(item.get("id"))
        for handle in keep_handles:
            mask.add_handle(handle)
        for uid in keep_ids:
            mask.add_id(uid)
        if norm(conf.get("me")):
            mask.add_handle(conf.get("me"))
        for name in conf.get("exclude_accounts") or []:
            mask.add_handle(name)
        mask.finish()
    me = _map_handle(mask, conf.get("me"))
    kept_ids = {_map_plain(mask, uid, "id"): 1 for uid in keep_ids if _map_plain(mask, uid, "id")}
    kept_handles = {_map_handle(mask, handle): 1 for handle in keep_handles if _map_handle(mask, handle)}
    coverage = data.get("coverage") or {}
    read_days = set(coverage.get("read_days") or [])
    if exclude_handles:
        blocked = {norm(name) for name in exclude_handles}
        hidden_rows = [row for row in data.get("rows") or [] if norm(row.get("account")) in blocked]
        try:
            tz = rs.zone(meta.get("tz") or rs.resolve_timezone_name())
        except ValueError:
            tz = None
        if tz is not None:
            for row in hidden_rows:
                for field in ("ts", "post_created_at", "first_observed_at"):
                    local = rs.to_local(row.get(field), tz)
                    if local:
                        read_days.add(local.date().isoformat())
    body = {
        "rows": _embed_rows(source_rows, conf, mask),
        "following": _people_map(data.get("following"), mask),
        "followers": _people_map(data.get("followers"), mask),
        "profiles": _people_map(data.get("profiles"), mask),
        "coverage": {"read_days": sorted(read_days)},
        "sawFollowing": following_items is not None,
        "sawFollowers": follower_items is not None,
        "followingAccounts": _emit_people(following_items, mask),
        "followerAccounts": _emit_people(follower_items, mask),
        "sawPrevFollowing": prev_following is not None,
        "sawPrevFollowers": prev_followers is not None,
        "prevFollowingAccounts": _emit_people(prev_following, mask),
        "prevFollowerAccounts": _emit_people(prev_followers, mask),
        "keepIds": kept_ids,
        "keepHandles": kept_handles,
        "notBackAlways": True,
    }
    auto = (meta.get("follow_diff") or {}).get("auto") or {}
    if auto.get("note"):
        body["followAuto"] = {
            "waiting": bool(auto.get("waiting")),
            "kept": bool(auto.get("kept")),
            "note": auto.get("note") or "",
            "from": auto.get("from") or "",
            "to": auto.get("to") or "",
        }
    payload = {
        "masked": bool(public),
        "me": me,
        "config": _scoring_config(conf, mask),
        "tz": meta.get("tz") or "",
        "view": {"start": meta["start"], "end": meta["end"], "days": meta["days"]},
        "data": body,
    }
    if public:
        blob = json.dumps(payload, ensure_ascii=False)
        if any(token in blob for token in ("user_", "https", "x.com")):
            raise ValueError("打码数据里还有不该出现的内容")
    return payload


def profile_link(handle, label):
    url = "https://x.com/" + handle
    return (
        f'<a href="{html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">'
        f"{html.escape(label)}</a>"
    )


def masked_name(alias, key):
    alias.setdefault(key, f"账号#{len(alias) + 1:02d}")
    return html.escape(alias[key])


def person_html(item, collisions, alias, public):
    if public:
        return masked_name(alias, follow_diff.public_key(item, collisions))
    text = follow_diff.account_text(item, collisions, at=True)
    if item.get("handle"):
        return profile_link(item["handle"], text)
    return html.escape(text)


def not_back_block(info, alias, public):
    """没回关。打码版沿用上面的账号#，并且不放主页链接。"""
    if not info:
        return ""
    ready = info["ready"]
    count = None if not ready else len(info["items"])
    heading = "没回关" if count is None else f"没回关（{count}）"
    head = (
        '<section class="card tier-block" id="not-followed-back" style="margin-bottom:16px"'
        f' data-total="{0 if count is None else count}">'
        f'<div class="block-head"><h2>{html.escape(heading)}</h2>'
        '<a class="back-top" href="#top">回到顶部</a></div>'
        '<p class="muted">我关注了、对方没有回关。零互动的排在前面，然后按分数从低到高。</p>'
        f'<p class="muted">{html.escape(nfb.SAFETY)}</p>'
    )
    if not ready:
        body = f'<p class="muted">{html.escape(info["note"])}</p>'
    elif not info["items"]:
        body = '<p class="muted">（暂时没有）</p>'
    else:
        collisions = nfb.collisions_of(info["items"])
        rows = ["<table><tr><th>账号</th><th>互动</th><th>分数</th><th>分层</th></tr>"]
        for item in info["items"]:
            cell = person_html(item, collisions, alias, public)
            rows.append(
                f"<tr><td>{cell}</td><td>{item['interactions']}</td>"
                f"<td>{html.escape(nfb.score_text(item))}</td>"
                f"<td>{html.escape(item['tier'] or '—')}</td></tr>"
            )
        rows.append("</table>")
        body = "\n".join(rows)
    return head + body + "</section>"


def follow_count(diff):
    groups = [diff[key] for key, _title in follow_diff.GROUP_ORDER]
    if all(items is None for items in groups):
        return "—"
    return str(sum(len(items) for items in groups if items is not None))


def follow_block(diff, alias, public):
    """关注变化。打码时和上面的名单共用同一套账号#，不另起一套。"""
    collisions = diff["collisions"]
    notes = "".join(f'<p class="muted">{html.escape(note)}</p>' for note in diff["notes"])
    cards, lists = [], []
    for key, title in follow_diff.GROUP_ORDER:
        items = diff[key]
        count = "—" if items is None else str(len(items))
        cards.append(f'<div class="card"><div class="num">{count}</div><div class="lab">{html.escape(title)}</div></div>')
        if items is None:
            body = '<p class="muted">先不算</p>'
            heading = title
        elif not items:
            body = '<p class="muted">（暂时没有）</p>'
            heading = f"{title}（0）"
        else:
            shown = [person_html(item, collisions, alias, public) for item in items[:60]]
            text = "、".join(shown) + ("…" if len(items) > 60 else "")
            body = f"<p>{text}</p>"
            heading = f"{title}（{len(items)}）"
        lists.append(f"<p><b>{html.escape(heading)}</b></p>{body}")
    return (
        '<section class="card tier-block" id="follow-diff" style="margin-bottom:16px">'
        '<div class="block-head"><h2>关注变化</h2><a class="back-top" href="#top">回到顶部</a></div>'
        f'<p class="muted">{html.escape(follow_diff.NOTE)}</p>{notes}'
        f'<div class="grid">{"".join(cards)}</div>{"".join(lists)}</section>'
    )


def bar_row(label, value, maxv, color, href=None):
    width = 0 if not maxv else max(2 if value else 0, int(220 * value / maxv))
    inner = (f'<span class="k">{html.escape(label)}</span>'
             f'<span class="b {color}" style="width:{width}px"></span><b>{value}</b>')
    if href:
        return f'<a class="bar" href="{html.escape(href, quote=True)}">{inner}</a>'
    return f'<div class="bar">{inner}</div>'


def jump_card(href, count, label, empty=False):
    kind = "card tier-card empty" if empty else "card tier-card"
    return (f'<a class="{kind}" href="{html.escape(href, quote=True)}">'
            f'<div class="num">{html.escape(str(count))}</div>'
            f'<div class="lab">{html.escape(label)}</div></a>')


def tier_color(tier):
    if tier == "金牌":
        return "gold"
    if tier == "银牌":
        return "silver"
    if "他常来" in tier:
        return "green"
    if "我常去" in tier:
        return "red"
    return "gray"


def render(res, meta, data=None, conf=None, public=False, lists_dir=None, prev_dir=None, keep_path=None, bundle=None, exclude_ids=(), exclude_handles=()):
    alias = {}
    if public:
        for index, row in enumerate(res, 1):
            alias[row["account"]] = f"账号#{index:02d}"

    def name_cell(row):
        if public:
            return html.escape(alias[row["account"]])
        return profile_link(row["account"], "@" + row["account"])

    counts = Counter(row["tier"] for row in res)
    scored = [row for row in res if row["status"] == "ok"]
    stars = Counter(row["stars"] for row in scored)
    thin = sum(1 for row in res if row["status"] != "ok" and (row.get("raw") or row.get("L_in")))
    star_max = max([stars.get(n, 0) for n in (5, 4, 3, 2, 1)] + [thin, 0])
    star_rows = [bar_row("★" * n, stars.get(n, 0), star_max, "") for n in (5, 4, 3, 2, 1)]
    star_rows.append(bar_row("样本不足", thin, star_max, "gray"))
    tier_max = max([counts.get(tier, 0) for tier in TIERS] or [0])
    tier_rows = [
        bar_row(tier, counts.get(tier, 0), tier_max, tier_color(tier), "#tier-" + tier) for tier in TIERS
    ]
    tier_cards = "".join(
        jump_card("#tier-" + tier, counts.get(tier, 0), tier, empty=not counts.get(tier, 0)) for tier in TIERS
    )
    stat_cards = (
        f'<div class="card stat-card"><div class="num">{meta["n_mutual"]}</div>'
        '<div class="lab">互关</div><div class="tag">统计</div></div>'
    )
    info = meta.get("not_followed_back")
    if info:
        back_count = "—" if not info["ready"] else str(len(info["items"]))
        stat_cards += jump_card("#not-followed-back", back_count, "没回关", empty=(back_count == "0"))
    diff = meta.get("follow_diff")
    if diff:
        stat_cards += jump_card("#follow-diff", follow_count(diff), "关注变化", empty=(follow_count(diff) == "0"))

    def tier_section(tier):
        rows = [row for row in res if row["tier"] == tier]
        if rows:
            body = ["<table><tr><th>账号</th><th>星级</th><th>分数</th><th>数据</th></tr>"]
            for row in rows:
                score = "—" if row.get("score") is None else html.escape(str(row.get("score")))
                body.append(
                    f"<tr><td>{name_cell(row)}</td><td>{stars_txt(row)}</td><td>{score}</td>"
                    f"<td>{html.escape(list_facts(row))}</td></tr>"
                )
            body.append("</table>")
            table = "\n".join(body)
        else:
            table = '<p class="muted">这一层暂时没有人</p>'
        note = ""
        if tier == "沉睡互关":
            note = "<p class=\"muted\">这一层是互关，但这段时间没有公开回复，也没有记到对方的赞。</p>"
        return (
            f'<section class="card tier-block" id="tier-{html.escape(tier)}" data-total="{len(rows)}">'
            f'<div class="block-head"><h2>{html.escape(tier)}（{len(rows)}）</h2>'
            '<a class="back-top" href="#top">回到顶部</a></div>'
            f"{table}{note}</section>"
        )

    warn = "".join(f"<div>⚠ {html.escape(w)}</div>" for w in meta["warnings"])
    title = "粉丝体检 · 互动关系星级（试用版）" + ("· 对外打码版" if public else "")
    sections = "".join(tier_section(tier) for tier in TIERS)
    payload = {}
    if data is not None and conf is not None:
        payload = dashboard_payload(data, conf, meta, public, lists_dir, prev_dir, keep_path, bundle, exclude_ids, exclude_handles)
    engine = dashboard_engine(public)
    controls = (
        '<div class="row">'
        f'<label>开始<input id="start" type="date" value="{html.escape(str(meta["start"]))}"></label>'
        f'<label>结束<input id="end" type="date" value="{html.escape(str(meta["end"]))}"></label>'
        '<button type="button" id="d7" data-mode="7">最近 7 天</button>'
        '<button type="button" id="d30" data-mode="30">最近 30 天</button>'
        '<button type="button" id="dall" data-mode="all">全部</button>'
        f'<label>时区<input id="tz" type="text" list="tz-list" value="{html.escape(str(meta["tz"]))}" autocomplete="off" spellcheck="false"></label>'
        + ("" if public else '<button type="button" id="mask">打码模式</button>')
        + "</div>"
        '<datalist id="tz-list">'
        '<option value="America/Los_Angeles"><option value="America/New_York"><option value="America/Chicago">'
        '<option value="Europe/London"><option value="Europe/Paris"><option value="Asia/Shanghai">'
        '<option value="Asia/Tokyo"><option value="UTC">'
        "</datalist>"
        f'<p class="sub" id="tz-label">当前时区：{html.escape(str(meta["tz"]))}</p>'
        + ("" if public else '<p class="muted" id="mask-note">打码模式只改变这一页上的显示，文件里仍有真实账号名。要外发请用 dashboard_public.html。</p>')
    )
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><style>{dashboard_css()}</style></head><body>
<h1 id="top">{html.escape(title)}</h1>
{controls}
<div class="sub" id="coverage">区间 {meta['start']} ~ {meta['end']}（请求 {meta['days']} 天）{coverage_note(meta)} · 当前时区：{html.escape(meta['tz'])} · 只统计公开回复、引用和点赞 · 分数只是线索，不代表真实关系</div>
{f'<div class="warn">{warn}</div>' if warn else ''}
<div id="out">
<div class="grid tier-cards">{tier_cards}</div>
<div class="grid stat-cards">{stat_cards}</div>
<div class="panels">
<div class="card"><h2>星级分布</h2>{''.join(star_rows)}
<p class="muted">样本不足 = 少于 3 条或只在 1 天里，不打星。</p></div>
<div class="card"><h2>分层人数</h2>{''.join(tier_rows)}</div>
</div>
<p class="muted">回访率 = 对方回复我的条数 ÷ 我发出的条数（都含问候）。我没有发出过就写 —，不写 0%。互动是这段时间的说话条数，往返是确认对上的轮数。这些只是展示，不改分数。</p>
{sections}
{not_back_block(info, alias, public)}
{follow_block(diff, alias, public) if diff else ""}
</div>
<footer>fan-audit v0.1 · 试用版 · 权重待验证 · 回访率只是已采集回复的比例，工具不会自动取关或屏蔽。改日期只在这份文件里重算，不联网。</footer>
<script id="fan-audit-engine">
{engine}
</script>
<script type="application/json" id="fan-audit-data">{_json_for_html(payload)}</script>
<script>
{_BOOT_JS}
</script>
</body></html>"""
    if public:
        for banned in ("user_", "https", "x.com", 'target="_blank"'):
            if banned in page:
                raise ValueError("打码看板里还有不该出现的内容")
    return page


def open_dashboard(path):
    """用系统浏览器打开看板。file URI 会转义中文和空格；打不开也不让整次分析失败。"""
    import webbrowser
    from pathlib import Path
    uri = Path(os.path.abspath(path)).resolve().as_uri()
    try:
        opened = bool(webbrowser.open(uri))
    except OSError:
        opened = False
    if not opened:
        print("浏览器没有打开，请手动打开看板")
    return 0


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
    ap.add_argument("--prev-lists", help="上一份关系表目录。写了才在看板里加「关注变化」，不写则和以前一样")
    ap.add_argument("--auto-prev", action="store_true",
                    help="在名单目录里自动找上一份导出并对比。文件没变时沿用上次对比，不把它说成没有变化")
    ap.add_argument("--keep-list", help="故意关注的账号，一行一个用户名或用户 ID，这些人不进没回关名单")
    ap.add_argument("--exclude", help="本地排除名单。一行一个用户名或数字 ID，也认 @、逗号和 # 注释。不写则读取数据目录里的排除名单.txt；没有这个文件时与现在一样。只从结果里拿掉，不会连接 X")
    ap.add_argument("--out", help="输出目录；每日模式默认在数据根目录的 _分析结果/截止日期/")
    ap.add_argument("--overwrite", action="store_true",
                    help="覆盖 --out 里本工具上次生成的结果；目录里有其他文件则停止，不删除")
    ap.add_argument("--config", default=rs.CONFIG_PATH)
    ap.add_argument("--end", help="截止日 YYYY-MM-DD，默认取 config（auto=数据里最晚一天）")
    period = ap.add_mutually_exclusive_group()
    period.add_argument("--days", type=int, help="区间天数，默认取 config")
    period.add_argument("--all-days", action="store_true", help="按本地时区从最早互动到最晚互动")
    ap.add_argument("--me", help="你自己的用户名（自己回自己的串推会被排除），也可以写进 config.json 的 me")
    ap.add_argument("--tz", help="IANA 时区，例如 Asia/Shanghai。不写则用 config.json 的 timezone，再没有就用本机时区")
    ap.add_argument("--open", action="store_true", help="生成后用系统浏览器打开 dashboard.html")
    a = ap.parse_args(argv)
    if a.auto_prev and a.prev_lists:
        ap.error("--auto-prev 不与 --prev-lists 同用")
    if a.prev_lists and not os.path.isdir(os.path.expanduser(a.prev_lists)):
        ap.error("上一份关系表目录不存在，或不是目录")
    root = a.data_root or (os.environ.get("FAN_AUDIT_DATA_ROOT") if not a.data else None)
    if a.data_root and a.data:
        ap.error("--data 与 --data-root 不同用；关系表请使用 --lists")
    if a.lists and not root:
        ap.error("--lists 只用于 --data-root")
    if a.auto_prev and root and not a.lists:
        ap.error("自动对比需要名单目录：每日模式用 --lists，单目录模式用 --data")
    if a.days is not None and a.days < 1:
        ap.error("--days 必须大于 0")
    if a.all_days and a.end:
        ap.error("--all-days 不与 --end 同用")
    conf, cfg = rs.load_config(a.config)
    if a.me:
        conf["me"] = a.me
    try:
        tz_name = rs.resolve_timezone_name(a.tz, (conf.get("window") or {}).get("timezone"))
        rs.zone(tz_name)
    except ValueError as exc:
        ap.error(str(exc))
    window = dict(conf.get("window") or {})
    window["timezone"] = tz_name
    conf["window"] = window
    try:
        exclude_ids, exclude_handles, exclude_n, exclude_used = find_exclude(a.exclude, root or (a.data or "data"))
    except ValueError as exc:
        ap.error(str(exc))
    list_scan = None
    if root:
        try:
            if a.out:
                check_output(a.out, HERE, root, a.overwrite)
            data = load_daily_root(root, a.lists)
            if a.auto_prev:
                list_scan = follow_diff.scan_lists(a.lists)
                follow_diff.apply_latest(data, list_scan)
            # 空文件或只有点赞时，默认截止日期仍有确定来源。
            daily_conf = dict(conf, window=dict(conf.get("window", {})))
            if not any(r.get("ts") for r in data["rows"]) and daily_conf["window"].get("end", "auto") == "auto":
                daily_conf["window"]["end"] = data["coverage"]["read_days"][-1]
            if exclude_used:
                exclude_ids, exclude_handles = apply_exclude(data, exclude_ids, exclude_handles)
            try:
                res, meta = analyze(data, daily_conf, cfg, a.end, a.days, a.all_days, hide=exclude_handles)
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
        if a.auto_prev:
            try:
                list_scan = follow_diff.scan_lists(a.data or "data")
                follow_diff.apply_latest(data, list_scan)
            except ValueError as exc:
                ap.error(str(exc))
        if exclude_used:
            exclude_ids, exclude_handles = apply_exclude(data, exclude_ids, exclude_handles)
        res, meta = analyze(data, conf, cfg, a.end, a.days, a.all_days, hide=exclude_handles)
        a.out = a.out or "output"
    lists_dir = a.lists if root else (a.data or "data")
    if root and not a.lists:
        lists_dir = None
    snap_path = os.path.join(a.out, follow_diff.SNAPSHOT_NAME)
    stored_snap = follow_diff.read_snapshot(snap_path)
    list_bundle = None
    if a.auto_prev:
        resolved = follow_diff.resolve_scanned(list_scan, stored_snap)
        if resolved["diff"]:
            meta["follow_diff"] = resolved["diff"]
        new_snap = resolved["snapshot"]
        list_bundle = resolved["bundle"]
    elif a.prev_lists:
        try:
            meta["follow_diff"] = follow_diff.compare_dirs(a.prev_lists, lists_dir)
        except ValueError as exc:
            ap.error(str(exc))
        new_snap = stored_snap or follow_diff.empty_snapshot()
    else:
        new_snap = stored_snap or follow_diff.empty_snapshot()
    try:
        if a.auto_prev:
            meta["not_followed_back"] = nfb.build(lists_dir, res, a.keep_list, indexes=list_scan["latest_pair"])
        else:
            meta["not_followed_back"] = nfb.build(lists_dir, res, a.keep_list)
        nfb.ensure_writable(a.out)
        if exclude_used:
            if meta.get("follow_diff"):
                meta["follow_diff"] = filter_follow_diff(meta["follow_diff"], exclude_ids, exclude_handles)
            meta["not_followed_back"] = filter_not_back(meta["not_followed_back"], exclude_ids, exclude_handles)
    except ValueError as exc:
        ap.error(str(exc))
    if root and a.overwrite:
        try:
            clear_own_outputs(a.out)
        except (ValueError, OSError) as exc:
            ap.error(str(exc) if isinstance(exc, ValueError) else "输出目录无法更新")
    os.makedirs(a.out, exist_ok=True)
    write_csv(res, os.path.join(a.out, "accounts.csv"))
    try:
        private_html = render(res, meta, data, conf, public=False, lists_dir=lists_dir,
                              prev_dir=a.prev_lists, keep_path=a.keep_list, bundle=list_bundle,
                              exclude_ids=exclude_ids, exclude_handles=exclude_handles)
        public_html = render(res, meta, data, conf, public=True, lists_dir=lists_dir,
                             prev_dir=a.prev_lists, keep_path=a.keep_list, bundle=list_bundle,
                             exclude_ids=exclude_ids, exclude_handles=exclude_handles)
    except ValueError as exc:
        ap.error(str(exc))
    with open(os.path.join(a.out, "dashboard.html"), "w", encoding="utf-8") as f:
        f.write(private_html)
    with open(os.path.join(a.out, "dashboard_public.html"), "w", encoding="utf-8") as f:
        f.write(public_html)
    try:
        nfb.write_private(a.out, meta["not_followed_back"])
        follow_diff.write_json_file(snap_path, new_snap)
        follow_diff.write_json_file(os.path.join(a.out, follow_diff.SUMMARY_NAME),
                                    follow_diff.summary_payload(meta.get("follow_diff")))
    except ValueError as exc:
        ap.error(str(exc))
    if root:
        coverage = coverage_lines(data, meta, conf.get("me", ""), list(conf.get("exclude_accounts") or []) + list(exclude_handles))
        write_roster(Path(a.out) / "名单.md", res, meta, data, coverage, stars_txt)
        for line in coverage:
            print(line)
    for w in meta["warnings"]:
        print("⚠", w)
    if meta.get("follow_diff"):
        print(follow_diff.summary_line(meta["follow_diff"]))
        note = (meta["follow_diff"].get("auto") or {}).get("note") or ""
        if note:
            print(note)
    if a.auto_prev or a.prev_lists:
        print(os.path.join(a.out, follow_diff.SUMMARY_NAME))
    print(nfb.summary_line(meta["not_followed_back"]))
    if exclude_used and exclude_n:
        print(f"已排除 {exclude_n} 人")
    c = Counter(x["tier"] for x in res)
    extra = ""
    if meta.get("covered_days") is not None:
        extra = f"；计分覆盖 {meta['scoring_days']} 天，无数据 {len(meta.get('uncovered_days') or [])} 天"
    print(f"区间 {meta['start']} ~ {meta['end']}（{meta['tz']}）{extra}，{len(res)} 个账号：" + "，".join(f"{t} {c.get(t, 0)}" for t in TIERS))
    if root:
        print("已在仓库外写出 accounts.csv、dashboard.html、dashboard_public.html、名单.md、没回关.md、没回关.csv、lists_snapshot.json、follow_summary.json（私有名单不在终端展示）")
    else:
        print(f"看板：{os.path.join(a.out, 'dashboard.html')}（含账号名，只给自己看）")
        print(f"对外打码版：{os.path.join(a.out, 'dashboard_public.html')}；明细：{os.path.join(a.out, 'accounts.csv')}")
        print(f"没回关名单：{os.path.join(a.out, nfb.MD_NAME)}（含账号名，只给自己看）")
    if a.open:
        open_dashboard(os.path.join(a.out, "dashboard.html"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
