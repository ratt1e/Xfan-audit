// ==UserScript==
// @name         fan-audit 粉丝体检
// @namespace    https://github.com/ratt1e/Xfan-audit
// @version      0.3.1
// @description  在 X 上边逛边记下公开回复和关注名单，也能导入导出的 JSON。默认只读你浏览过的内容。可选自动读取名单默认关闭，可选滚动或快速请求。
// @author       ranger_escape
// @match        *://x.com/*
// @match        *://twitter.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addElement
// @updateURL    https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js
// @downloadURL  https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js
// @license      MIT
// @noframes
// ==/UserScript==
/*
 * fan-audit userscript
 * Copyright (c) 2026 ratt1e
 * Released under the MIT License. See the repository LICENSE file.
 *
 * The XMLHttpRequest / fetch hook and the GraphQL timeline walk are adapted from
 * twitter-web-exporter, Copyright (c) 2023 prin
 * https://github.com/prinsss/twitter-web-exporter
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Scoring is copied at build time from engine/fan_audit_engine.js.
 * That file is the only source of the formula.
 */
(function () {
"use strict";
var root = {};
/* FAN_ENGINE_START */
(function (root) {
  var CONFIG = {
    window: {days: 30, timezone: ""},
    weights: {persistence: 0.40, bidirectional: 0.35, rounds: 0.25},
    persistence: {alpha: 0.30, greet_day: 0.2, greet_day_cap: 1.0},
    greeting_cap: {share: 0.8, max_score: 39.9},
    likes: {points_each: 0.5, cap: 5.0, time_mode: "strict"},
    insufficient: {min_raw: 3, min_days: 2},
    stars: {5: 80, 4: 60, 3: 40, 2: 20},
    tiers: {
      gold: {min_score: 55, min_rounds: 3, min_each_side: 3, max_greet_share: 0.5, min_sub_days: 2, min_their_replies: 1},
      silver: {min_score: 40, min_rounds: 2, min_their_replies: 1, min_confirmed_rounds: 1},
      one_way: {min_from_one_side: 3, max_from_other_side: 1},
      priority_bonus: {mutual: 5, verified: 5, followers_log10_max: 5}
    },
    greetings: {max_core_len: 15, words: ["早安", "早上好", "午安", "晚安", "互关", "回关", "互粉", "浇水", "浇朋友", "浇浇", "打卡", "新朋友", "gm", "gn", "follow back", "^来了", "^你好", "来咯", "来啦", "串门", "互一互", "互动互动", "早早早", "出摊"]},
    exclude_accounts: ["grok"]
  };
  var TIERS = ["金牌", "银牌", "单向·他常来我少回", "单向·我常去他没回", "沉睡互关", "样本不足", "其他有分", "零互动"];
  var TALK = {reply: 1, quote: 1, mention: 1};

  function norm(h) {
    return String(h || "").trim().replace(/^@/, "").trim().toLowerCase();
  }
  function truthy(v) {
    if (v === true) return true;
    return ["1", "true", "yes", "y", "是", "✔"].indexOf(String(v || "").trim().toLowerCase()) >= 0;
  }
  function pyRound(value, digits) {
    var m = Math.pow(10, digits);
    var shifted = value * m;
    var sign = shifted < 0 ? -1 : 1;
    var abs = Math.abs(shifted);
    var floor = Math.floor(abs + 1e-10);
    var frac = abs - floor;
    var rounded = Math.abs(frac - 0.5) < 1e-8 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(abs);
    return sign * rounded / m;
  }
  function parseUtc(s) {
    if (!s) return null;
    var t = String(s).trim();
    if (!t) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T00:00:00Z";
    else if (!/[zZ]$/.test(t) && !/[+-]\d{2}:?\d{2}$/.test(t)) t += "Z";
    var d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  function defaultTimeZone() {
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone) return zone;
    } catch (err) {}
    return "UTC";
  }
  function resolveZone(options) {
    var configured = CONFIG.window && CONFIG.window.timezone ? String(CONFIG.window.timezone).trim() : "";
    var picked = options && options.tz ? String(options.tz).trim() : "";
    var tz = picked || configured || defaultTimeZone();
    try {
      new Intl.DateTimeFormat("en-US", {timeZone: tz}).format(new Date());
    } catch (err) {
      throw new Error("时区无效，请填 IANA 名称，例如 Asia/Shanghai");
    }
    return tz;
  }
  function localDay(date, tz) {
    var parts = new Intl.DateTimeFormat("en-US", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(date);
    function get(type) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
      return "";
    }
    return get("year") + "-" + get("month") + "-" + get("day");
  }
  function dayNum(ymd) {
    var p = ymd.split("-");
    return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
  }
  function addDays(ymd, n) {
    var t = new Date((dayNum(ymd) + n) * 86400000);
    var m = String(t.getUTCMonth() + 1);
    var d = String(t.getUTCDate());
    if (m.length < 2) m = "0" + m;
    if (d.length < 2) d = "0" + d;
    return t.getUTCFullYear() + "-" + m + "-" + d;
  }
  function stripLinks(text) {
    var scheme = "http";
    return String(text || "").replace(new RegExp(scheme + "s?:\\/\\/\\S+", "g"), "").replace(/@\w+/g, "");
  }
  function coreOf(text) {
    var s = stripLinks(text).trim();
    var out = "";
    for (var i = 0; i < s.length; i++) if (/\p{L}|\p{N}/u.test(s.charAt(i))) out += s.charAt(i);
    return out;
  }
  function isGreeting(text, words, maxLen) {
    var core = coreOf(text);
    if (!core) return true;
    if (core.length > maxLen) return false;
    var low = stripLinks(text).trim().toLowerCase();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var prefix = w.charAt(0) === "^";
      w = w.replace(/^\^/, "").toLowerCase();
      if (/^[a-z0-9 ]+$/.test(w)) {
        var pat = "\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b";
        if (prefix) pat = "^" + pat;
        if (new RegExp(pat).test(low)) return true;
      } else if (prefix ? low.indexOf(w) === 0 : low.indexOf(w) >= 0) return true;
    }
    return false;
  }
  function parseCsv(text) {
    text = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var rows = [], row = [], field = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (q) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      if (rows[r].every(function (x) { return x === ""; })) continue;
      var obj = {};
      for (var c = 0; c < head.length; c++) obj[head[c]] = rows[r][c] == null ? "" : rows[r][c];
      out.push(obj);
    }
    return out;
  }
  function prepare(rows, tz, words, maxLen) {
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var key = (TALK[r.type] && r.tweet_id) ? ("tw:" + r.tweet_id) : r.id;
      if (seen[key]) continue;
      seen[key] = 1;
      r = Object.assign({}, r);
      var dt = parseUtc(r.ts), post = parseUtc(r.post_created_at), obs = parseUtc(r.first_observed_at);
      r.day = dt ? localDay(dt, tz) : "";
      r.postDay = post ? localDay(post, tz) : "";
      r.obsDay = obs ? localDay(obs, tz) : "";
      if (TALK[r.type]) {
        if (r.is_greeting === "true" || r.is_greeting === "false") r.greet = r.is_greeting === "true";
        else r.greet = isGreeting(r.text, words, maxLen);
      }
      out.push(r);
    }
    return out;
  }
  function likeInRange(r, s, e, mode) {
    if (mode === "strict") return !!(r.postDay && r.obsDay && r.postDay >= s && r.obsDay <= e);
    return !!(r.obsDay && s <= r.obsDay && r.obsDay <= e && r.observed_baseline !== "true");
  }
  function windowScale(s, e, observed) {
    var span = dayNum(e) - dayNum(s) + 1;
    function calendarWeek(day) { return Math.floor((dayNum(day) - dayNum(s)) / 7); }
    if (!observed) return {D: span, weekOf: calendarWeek, K: Math.ceil(span / 7)};
    var covered = [];
    for (var i = 0; i < span; i++) {
      var day = addDays(s, i);
      if (observed[day]) covered.push(day);
    }
    if (covered.length === 0 || covered.length === span) return {D: span, weekOf: calendarWeek, K: Math.ceil(span / 7)};
    var index = {};
    covered.forEach(function (day, n) { index[day] = n; });
    return {D: covered.length, weekOf: function (day) { return day in index ? Math.floor(index[day] / 7) : calendarWeek(day); }, K: Math.ceil(covered.length / 7)};
  }
  function score(rows, s, e, likeMode, observed) {
    var obs = null;
    if (observed) {
      obs = Object.assign({}, observed);
      rows.forEach(function (r) { if (r.day && s <= r.day && r.day <= e) obs[r.day] = 1; });
    }
    var scale = windowScale(s, e, obs);
    var talk = rows.filter(function (r) { return TALK[r.type] && r.day && s <= r.day && r.day <= e; });
    var likesAll = rows.filter(function (r) { return r.type === "like"; });
    var likes = likesAll.filter(function (r) { return likeInRange(r, s, e, likeMode); });
    var sub = talk.filter(function (r) { return !r.greet; });
    var greet = talk.filter(function (r) { return r.greet; });
    function count(list, dir) { return list.filter(function (r) { return r.direction === dir; }).length; }
    function daysOf(list) {
      var set = {};
      list.forEach(function (r) { set[r.day] = 1; });
      return Object.keys(set);
    }
    var res = {
      raw: talk.length, sub: sub.length, greet: greet.length,
      active_days: daysOf(talk).length, sub_days: daysOf(sub).length,
      O: count(sub, "out"), I: count(sub, "in"), O_raw: count(talk, "out"), I_raw: count(talk, "in"),
      L_in: count(likes, "in"), L_out: count(likes, "out"), likes_unscored: likesAll.length - likes.length
    };
    var byTid = {};
    talk.forEach(function (r) { byTid[r.tweet_id] = r; });
    var rounds = 0, unconfirmed = 0, branch = 0, convs = {};
    sub.forEach(function (r) {
      convs[r.conversation_id || r.tweet_id] = 1;
      if (r.type !== "reply") return;
      var p = r.in_reply_to_status_id;
      if (p && byTid[p]) {
        var par = byTid[p];
        if (par.direction !== r.direction && !par.greet) rounds += 1;
      } else if (r.parent_kind === "root") {
        return;
      } else if (r.parent_kind === "other") branch += 1;
      else unconfirmed += 1;
    });
    var T = Object.keys(convs).length;
    res.T = T; res.rounds = rounds; res.unconfirmed = unconfirmed; res.branch = branch;
    var cfg = CONFIG;
    if (talk.length < cfg.insufficient.min_raw || res.active_days < cfg.insufficient.min_days) {
      res.status = "样本不足";
      return res;
    }
    var subDays = {}, greetOnly = {};
    sub.forEach(function (r) { subDays[r.day] = 1; });
    greet.forEach(function (r) { if (!subDays[r.day]) greetOnly[r.day] = 1; });
    var pDay = Math.min(1, (Object.keys(subDays).length + Math.min(cfg.persistence.greet_day_cap, cfg.persistence.greet_day * Object.keys(greetOnly).length)) / (cfg.persistence.alpha * scale.D));
    var weeks = {};
    sub.forEach(function (r) { weeks[scale.weekOf(r.day)] = 1; });
    var P = 0.5 * pDay + 0.5 * (Object.keys(weeks).length / scale.K);
    var B = res.O >= 1 && res.I >= 1 ? Math.min(res.O, res.I) / Math.max(res.O, res.I) : 0;
    var R = T ? Math.min(1, rounds / Math.max(2 * T, 4)) : 0;
    var base = 100 * (cfg.weights.persistence * P + cfg.weights.bidirectional * B + cfg.weights.rounds * R);
    var bonus = Math.min(cfg.likes.cap, cfg.likes.points_each * (res.L_in + res.L_out), base);
    var S = Math.min(100, base + bonus);
    var share = greet.length / talk.length;
    var capped = share >= cfg.greeting_cap.share;
    if (capped) S = Math.min(S, cfg.greeting_cap.max_score);
    var stars = 1, table = cfg.stars;
    if (S >= table[5]) stars = 5; else if (S >= table[4]) stars = 4; else if (S >= table[3]) stars = 3; else if (S >= table[2]) stars = 2;
    res.status = "ok";
    res.greet_share = pyRound(share, 2);
    res.P = pyRound(P, 3); res.B = pyRound(B, 3); res.R = pyRound(R, 3);
    res.base = pyRound(base, 1); res.bonus = pyRound(bonus, 1); res.score = pyRound(S, 1);
    res.stars = stars; res.greet_cap = capped;
    return res;
  }
  var ABSENCE_TIERS = {"沉睡互关": 1, "零互动": 1, "单向·他常来我少回": 1, "单向·我常去他没回": 1};
  var INTERACTION_THIN = "互动数据还不够，先去主页回复页和「别人回我」搜索页滑几屏";
  // 互动天数只数回复（出=我发出的，入=别人回我）。关注/粉丝名单不产生这些行，所以不算覆盖。
  // 门槛：两边都至少 1 天，并且合计至少 2 个不同日期（与样本不足的最少天数同一量级）。
  // 只有一边，或两边挤在同一天，都不能把没采到的日子当成零互动。
  function interactionCoverage(rows, start, end) {
    var daysIn = {}, daysOut = {}, talkDays = {};
    rows.forEach(function (r) {
      if (!TALK[r.type]) return;
      var day = r.day;
      if (!day || day < start || day > end) return;
      if (r.direction === "in") daysIn[day] = 1;
      else if (r.direction === "out") daysOut[day] = 1;
      else return;
      talkDays[day] = 1;
    });
    var inboundDays = Object.keys(daysIn).length;
    var outboundDays = Object.keys(daysOut).length;
    var days = Object.keys(talkDays).length;
    return {
      inboundDays: inboundDays,
      outboundDays: outboundDays,
      talkDays: days,
      interactionReady: inboundDays >= 1 && outboundDays >= 1 && days >= 2
    };
  }
  function classify(x) {
    var g = CONFIG.tiers.gold, s = CONFIG.tiers.silver, o = CONFIG.tiers.one_way;
    var their = x.I_raw || 0, rounds = x.rounds || 0;
    if (x.status === "ok" && their >= (g.min_their_replies || 1) && rounds >= (s.min_confirmed_rounds || 1)) {
      if (x.score >= g.min_score && rounds >= g.min_rounds && x.O >= g.min_each_side && x.I >= g.min_each_side && (x.greet_share == null ? 1 : x.greet_share) < g.max_greet_share && x.sub_days >= g.min_sub_days) return "金牌";
      if (x.score >= s.min_score || rounds >= s.min_rounds) return "银牌";
    }
    if (their >= o.min_from_one_side && (x.O_raw || 0) <= o.max_from_other_side) return "单向·他常来我少回";
    if ((x.O_raw || 0) >= o.min_from_one_side && their === 0) return "单向·我常去他没回";
    if (x.mutual && (x.raw || 0) === 0 && (x.L_in || 0) === 0) return "沉睡互关";
    if (x.status === "样本不足" && ((x.raw || 0) || (x.L_in || 0))) return "样本不足";
    if (x.status === "ok") return "其他有分";
    return "零互动";
  }
  function action(x) {
    var parts = [], t = x.tier;
    if (t === "金牌") {
      parts.push("重点维护：他发帖时优先接他的话题，挑一条好帖引用并加上你的观点");
      parts.push("聊得来可以试着邀请互推或一起做一条内容（对方意愿待核实）");
    } else if (t === "银牌") {
      if (x.I > x.O) parts.push("他回你比你回他多，多接他的话");
      else if (x.O > x.I + 1) parts.push("你去得多、他回得少，挑他主页的实质话题再聊");
      parts.push(x.rounds >= 2 ? ("已经有 " + x.rounds + " 轮真往返，再多聊几天就可能升金牌") : "下次他回你时再接一句，把单句评论聊成对话");
      if ((x.greet || 0) >= 2) parts.push("少一点问候，多一点具体内容");
    } else if (t === "单向·他常来我少回") parts.push("回他一两句实质内容，这是成本最低的升级");
    else if (t === "单向·我常去他没回") parts.push("先别再大量串门；看看是不是没采到他的回复");
    else if (t === "沉睡互关") parts.push("不急着取关（零公开互动≠没看过）；挑简介方向接近的主动聊一次");
    if (t === "金牌" || t === "银牌") {
      if (x.verified) parts.push("蓝V：他的曝光算进 OCR 认证曝光");
      if (!x.mutual && !x.i_follow) parts.push("你还没关注他，可以考虑回关");
    }
    return parts.join("；");
  }
  function analyze(data, options) {
    options = options || {};
    var tz = resolveZone(options);
    var words = CONFIG.greetings.words, maxLen = CONFIG.greetings.max_core_len;
    var me = norm(options.me || "");
    var excl = {"grok": 1};
    CONFIG.exclude_accounts.forEach(function (a) { if (norm(a)) excl[norm(a)] = 1; });
    if (me) excl[me] = 1;
    var rows = (data.rows || []).filter(function (r) { return !excl[norm(r.account)]; });
    rows.forEach(function (r) { r.account = norm(r.account); });
    var prep = prepare(rows, tz, words, maxLen);
    var dates = [];
    prep.forEach(function (r) { ["day", "postDay", "obsDay"].forEach(function (k) { if (r[k]) dates.push(r[k]); }); });
    var end = options.end && options.end !== "auto" ? options.end : (dates.length ? dates.slice().sort().pop() : localDay(new Date(), tz));
    var days = options.days || CONFIG.window.days;
    var start = addDays(end, 1 - days);
    if (options.allDays) {
      if (dates.length) { dates.sort(); start = dates[0]; end = dates[dates.length - 1]; }
      days = dayNum(end) - dayNum(start) + 1;
    }
    var observed = null;
    if (options.gapsAreEmpty) {
      observed = {};
      prep.forEach(function (r) {
        if (r.day) observed[r.day] = 1;
        if (r.obsDay) observed[r.obsDay] = 1;
      });
      var readDays = (data.coverage && data.coverage.read_days) || [];
      readDays.forEach(function (day) { if (day) observed[day] = 1; });
    }
    var by = {};
    prep.forEach(function (r) { (by[r.account] = by[r.account] || []).push(r); });
    var accounts = {};
    Object.keys(by).forEach(function (a) { accounts[a] = 1; });
    Object.keys(data.following || {}).forEach(function (a) { if (!excl[a]) accounts[a] = 1; });
    Object.keys(data.followers || {}).forEach(function (a) { if (!excl[a]) accounts[a] = 1; });
    var pb = CONFIG.tiers.priority_bonus;
    var talk = interactionCoverage(prep, start, end);
    var res = Object.keys(accounts).sort().map(function (a) {
      var x = score(by[a] || [], start, end, CONFIG.likes.time_mode, observed);
      x.account = a;
      x.i_follow = !!(data.following || {})[a];
      x.follows_me = !!(data.followers || {})[a];
      x.mutual = x.i_follow && x.follows_me;
      var p = (data.profiles || {})[a] || {};
      var f = (data.followers || {})[a] || (data.following || {})[a] || {};
      x.verified = truthy(p.verified || f.verified || f.is_blue_verified);
      var count = parseInt(p.followers_count || f.followers_count || 0, 10);
      x.followers_count = isNaN(count) || !count ? null : count;
      x.tier = classify(x);
      if (!talk.interactionReady && ABSENCE_TIERS[x.tier]) {
        x.tier = "";
        x.action = "";
      } else x.action = action(x);
      var bonus = pb.mutual * (x.mutual ? 1 : 0) + pb.verified * (x.verified ? 1 : 0) + pb.followers_log10_max * Math.min(1, Math.log10((x.followers_count || 0) + 1) / 4);
      x.priority = pyRound((x.score || 0) + bonus, 1);
      return x;
    });
    res.sort(function (a, b) {
      var d = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier);
      if (d) return d;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.account < b.account ? -1 : 1;
    });
    var span = [];
    for (var i = 0; i <= dayNum(end) - dayNum(start); i++) span.push(addDays(start, i));
    var covered = observed ? span.filter(function (d) { return observed[d]; }) : span.slice();
    return {rows: res, meta: {start: start, end: end, days: days, tz: tz, covered: covered.length, uncovered: span.length - covered.length, gapsAreEmpty: !!options.gapsAreEmpty, inboundDays: talk.inboundDays, outboundDays: talk.outboundDays, talkDays: talk.talkDays, interactionReady: talk.interactionReady, interactionNote: talk.interactionReady ? "" : INTERACTION_THIN}};
  }
  function usersFrom(records) {
    var map = {};
    records.forEach(function (r) {
      var h = norm(r.screen_name || r.handle);
      if (!h || map[h]) return;
      map[h] = {handle: h, verified: r.verified, is_blue_verified: r.is_blue_verified, followers_count: r.followers_count};
    });
    return map;
  }
  function repliesFromTweets(records, owner) {
    owner = norm(owner);
    var author = {}, seen = {}, recs = [];
    records.forEach(function (t) {
      var tid = String(t.id || t.rest_id || "").trim();
      if (tid && seen[tid]) return;
      if (tid) seen[tid] = 1;
      recs.push(t);
      author[tid] = norm(t.screen_name);
    });
    var rows = [];
    recs.forEach(function (t) {
      var tid = String(t.id || t.rest_id || "");
      var h = norm(t.screen_name);
      var parent = String(t.in_reply_to || t.in_reply_to_status_id_str || "").trim();
      if (["none", "null", "n/a"].indexOf(parent.toLowerCase()) >= 0) parent = "";
      if (!parent) return;
      var target = norm(t.in_reply_to_screen_name) || author[parent] || "";
      var direction = "", acc = "";
      if (h === owner && target && target !== owner) { direction = "out"; acc = target; }
      else if (h !== owner && target === owner) { direction = "in"; acc = h; }
      else return;
      rows.push({id: "tw:" + tid, tweet_id: tid, ts: t.created_at || "", account: acc, direction: direction, type: "reply", text: t.full_text || t.text || "", in_reply_to_status_id: parent, conversation_id: t.conversation_id || t.conversation_id_str || "", parent_kind: ""});
    });
    return rows;
  }
  function rowsFromReplies(records) {
    var rows = [];
    records.forEach(function (r) {
      var direction = String(r.direction || "").trim().toLowerCase();
      if (direction === "我→他") direction = "out";
      if (direction === "他→我") direction = "in";
      if (direction !== "in" && direction !== "out") return;
      rows.push({id: "tw:" + r.tweet_id, tweet_id: r.tweet_id, ts: r.created_at || r.ts || "", account: norm(r.account), direction: direction, type: (r.type || "reply").trim() || "reply", text: r.text || "", in_reply_to_status_id: r.in_reply_to_status_id || "", conversation_id: r.conversation_id || "", parent_kind: r.parent_kind || ""});
    });
    return rows;
  }
  function rowsFromInteractions(records) {
    return records.map(function (r) {
      return Object.assign({}, r, {account: norm(r.account)});
    });
  }
  function rowsFromLikes(records) {
    return records.map(function (r) {
      var a = norm(r.account);
      return {id: "like:in:" + a + ":" + r.post_id, tweet_id: "", ts: "", account: a, direction: (r.direction || "in").trim() || "in", type: "like", post_id: r.post_id, post_created_at: r.post_created_at || "", first_observed_at: r.first_observed_at || "", observed_baseline: r.observed_baseline || ""};
    });
  }
  function inferOwner(records) {
    var counts = {};
    records.forEach(function (t) {
      var parent = String(t.in_reply_to || t.in_reply_to_status_id_str || "").trim();
      if (!parent || ["none", "null", "n/a"].indexOf(parent.toLowerCase()) >= 0) {
        var h = norm(t.screen_name);
        if (h) counts[h] = (counts[h] || 0) + 1;
      }
    });
    var best = "", n = 0, tie = false;
    Object.keys(counts).forEach(function (h) {
      if (counts[h] > n) { best = h; n = counts[h]; tie = false; }
      else if (counts[h] === n) tie = true;
    });
    return tie ? "" : best;
  }
  function parseRecords(text) {
    var body = String(text || "").replace(/^\uFEFF/, "");
    var trimmed = body.trim();
    var json = trimmed.charAt(0) === "[" || trimmed.charAt(0) === "{";
    var records = json ? JSON.parse(trimmed) : parseCsv(body);
    if (json && records && records.data) records = records.data;
    if (!Array.isArray(records)) records = [records];
    return {json: json, records: records};
  }
  function markedOld(base, low) {
    if (base.indexOf("旧") >= 0) return true;
    return /(^|[^a-z])(old|prev)([^a-z]|$)/.test(low);
  }
  function nameKind(name) {
    var base = String(name || "").replace(/\.[^.]+$/, "").replace(/[-_ ]\d{6,}$/, "");
    var low = base.toLowerCase();
    if (base.indexOf("保留") >= 0) return "keep";
    if (/(^|[^a-z])keep([^a-z]|$)/.test(low) && low.indexOf("following") < 0 && low.indexOf("follower") < 0) return "keep";
    var oldMark = markedOld(base, low);
    if (base.indexOf("用户推文") >= 0 || low.indexOf("usertweets") >= 0 || low.indexOf("tweets") >= 0) return "tweets";
    if (base.indexOf("正在关注") >= 0 || low.indexOf("following") >= 0) return oldMark ? "prev-following" : "following";
    if (base.indexOf("关注者") >= 0 || base.indexOf("粉丝") >= 0 || low.indexOf("followers") >= 0) return oldMark ? "prev-followers" : "followers";
    return "";
  }
  function contentKind(records) {
    var tweet = records.some(function (r) {
      if (!r) return false;
      var body = r.full_text != null ? r.full_text : null;
      if (body == null && r.text != null && r.screen_name) body = r.text;
      return body != null && (r.created_at || r.ts);
    });
    if (tweet) return "tweets";
    var user = records.some(function (r) { return r && (r.screen_name || r.handle) && r.full_text == null; });
    if (user) return "ask-users";
    return "";
  }
  function fileKind(name, text) {
    var byName = nameKind(name);
    if (byName) return byName;
    var low = String(name || "").toLowerCase();
    if (low.indexOf("interaction") >= 0) return "interactions";
    if (low.indexOf("repl") >= 0) return "replies";
    if (low.indexOf("like") >= 0) return "likes";
    if (low.indexOf("profile") >= 0) return "profiles";
    var parsed;
    try { parsed = parseRecords(text); } catch (err) { return "bad"; }
    if (parsed.json) return contentKind(parsed.records) || "unknown";
    return "unknown";
  }
  function mergeUsers(target, records) {
    var add = usersFrom(records);
    Object.keys(add).forEach(function (h) { if (!target[h]) target[h] = add[h]; });
  }
  function accountId(record) {
    var keys = ["user" + "_id", "id_str", "rest_id", "id"];
    for (var i = 0; i < keys.length; i++) {
      if (record[keys[i]] == null || record[keys[i]] === "") continue;
      var text = String(record[keys[i]]).trim();
      var low = text.toLowerCase();
      if (!text || low === "none" || low === "null" || low === "n/a" || low === "undefined") continue;
      return text;
    }
    return "";
  }
  function accountsFrom(records) {
    var out = [];
    (records || []).forEach(function (record) {
      if (!record) return;
      var handle = norm(record.screen_name || record.handle || record.username);
      var id = accountId(record);
      if (!handle && !id) return;
      out.push({id: id, handle: handle, name: String(record.name || "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim()});
    });
    return out;
  }
  function dedupeRows(rows) {
    var seen = {}, out = [];
    rows.forEach(function (r) {
      var key = r.id || (r.tweet_id ? "tw:" + r.tweet_id : "");
      if (key && seen[key]) return;
      if (key) seen[key] = 1;
      out.push(r);
    });
    return out;
  }
  function parseKeepText(text) {
    var ids = [], handles = [];
    var headers = {handle: 1, id: 1, id_str: 1, rest_id: 1, screen_name: 1, username: 1, "账号": 1};
    headers["user" + "_id"] = 1;
    String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).forEach(function (line) {
      var token = line.trim();
      if (!token || token.charAt(0) === "#") return;
      token = token.replace(/^,+|,+$/g, "").trim();
      if (token.charAt(0) === '"' && token.charAt(token.length - 1) === '"') token = token.slice(1, -1).trim();
      if (token.charAt(0) === "'" && token.charAt(token.length - 1) === "'") token = token.slice(1, -1).trim();
      if (token.charAt(0) === "@") token = token.slice(1).trim();
      if (!token || headers[token.toLowerCase()]) return;
      if (/^\d+$/.test(token)) ids.push(token);
      else handles.push(norm(token));
    });
    return {ids: ids, handles: handles};
  }
  function loadTexts(parts) {
    var data = {rows: [], following: {}, followers: {}, profiles: {}, warnings: [], needsChoice: [], owner: "",
      followerAccounts: [], followingAccounts: [], prevFollowerAccounts: [], prevFollowingAccounts: [],
      sawFollowers: false, sawFollowing: false, sawPrevFollowers: false, sawPrevFollowing: false,
      keepIds: {}, keepHandles: {}};
    parts.forEach(function (part, idx) {
      var name = part.name || "";
      var kind = part.kind || fileKind(name, part.text || "");
      if (kind === "keep") {
        var kept = parseKeepText(part.text || "");
        kept.ids.forEach(function (id) { data.keepIds[id] = 1; });
        kept.handles.forEach(function (h) { data.keepHandles[h] = 1; });
        return;
      }
      if (kind === "ask-users") { data.needsChoice.push({index: idx, name: name}); return; }
      if (kind === "unknown" || kind === "bad") { data.warnings.push("有一份文件认不出来，已跳过"); return; }
      var parsed;
      try { parsed = parseRecords(part.text || ""); } catch (err) {
        data.warnings.push("有一份文件读不了，已跳过");
        return;
      }
      var records = parsed.records;
      if (kind === "tweets") {
        var owner = norm(part.owner || "") || inferOwner(records);
        if (!owner) data.warnings.push("有一份推文没能判断你的用户名，请在页面上填写");
        else {
          data.owner = data.owner || owner;
          data.rows = data.rows.concat(repliesFromTweets(records, owner));
        }
      } else if (kind === "followers") {
        data.sawFollowers = true;
        data.followerAccounts = data.followerAccounts.concat(accountsFrom(records));
        mergeUsers(data.followers, records);
      } else if (kind === "following") {
        data.sawFollowing = true;
        data.followingAccounts = data.followingAccounts.concat(accountsFrom(records));
        mergeUsers(data.following, records);
      } else if (kind === "prev-followers") {
        data.sawPrevFollowers = true;
        data.prevFollowerAccounts = data.prevFollowerAccounts.concat(accountsFrom(records));
      } else if (kind === "prev-following") {
        data.sawPrevFollowing = true;
        data.prevFollowingAccounts = data.prevFollowingAccounts.concat(accountsFrom(records));
      }
      else if (kind === "interactions") data.rows = data.rows.concat(rowsFromInteractions(records));
      else if (kind === "replies") data.rows = data.rows.concat(rowsFromReplies(records));
      else if (kind === "likes") data.rows = data.rows.concat(rowsFromLikes(records));
      else if (kind === "profiles") records.forEach(function (r) {
        var h = norm(r.handle);
        if (h && !data.profiles[h]) data.profiles[h] = r;
      });
      else data.warnings.push("有一份文件认不出来，已跳过");
    });
    data.rows = dedupeRows(data.rows);
    return data;
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c];
    });
  }
  function starsText(x) {
    if (!x || x.status !== "ok") return "样本不足";
    var n = x.stars || 0;
    return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n);
  }
  function jumpPlan(count) {
    return {scroll: true, message: count ? "" : "这一层暂时没有人"};
  }
  function profileAnchor(handle, text) {
    if (!handle) return escHtml(text);
    var href = "https:" + "//x.com/" + handle;
    return '<a href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(text) + "</a>";
  }
  // 回访率只用于名单展示，不进入 score()，也不改变星级门槛。
  // 分子 I_raw：对方回复我的条数，含问候。score() 里是 count(talk, "in")。
  // 分母 O_raw：我发给对方的条数，含问候。score() 里是 count(talk, "out")。
  // 百分比 = round(100 * I_raw / O_raw)。O_raw 不是正数时没有分母，显示「—」，不用 0% 充数。
  // I_raw 缺失而分母有效时，分子按 0，可以显示 0%。对方回得更多时可以超过 100%，不封顶。
  function revisitText(row) {
    if (!row || row.O_raw == null || row.O_raw === "") return "—";
    var denom = Number(row.O_raw);
    if (!isFinite(denom) || denom <= 0) return "—";
    var numer = row.I_raw == null || row.I_raw === "" ? 0 : Number(row.I_raw);
    if (!isFinite(numer) || numer < 0) return "—";
    return Math.round((100 * numer) / denom) + "%";
  }
  function countText(value) {
    if (value == null || value === "") return "—";
    var n = Number(value);
    if (!isFinite(n) || n < 0) return "—";
    return String(Math.round(n));
  }
  // 互动用 raw（这段时间的说话条数，不含点赞）。往返用已确认的 rounds；另有未确认的父帖时把条数写出来，不算建议。
  function listFacts(row) {
    var rounds = countText(row && row.rounds);
    var extra = "";
    if (row && row.unconfirmed != null && row.unconfirmed !== "" && Number(row.unconfirmed) > 0) {
      extra = "，未确认 " + Math.round(Number(row.unconfirmed));
    }
    return "回访 " + revisitText(row) + " · 互动 " + countText(row && row.raw) + " · 往返 " + rounds + extra;
  }
  function boardHtml(rows, options) {
    options = options || {};
    var open = options.open || {};
    var alias = {};
    rows.forEach(function (x, i) {
      var s = String(i + 1);
      alias[x.account] = "账号#" + (s.length < 2 ? "0" + s : s);
    });
    function nameCell(account) {
      if (options.masked) return escHtml(alias[account]);
      return profileAnchor(account, "@" + account);
    }
    var count = {};
    TIERS.forEach(function (t) { count[t] = 0; });
    rows.forEach(function (x) { count[x.tier] = (count[x.tier] || 0) + 1; });
    var mutual = rows.filter(function (x) { return x.mutual; }).length;
    function statCards() {
      var html = '<div class="grid stat-cards"><div class="card stat-card"><div class="num">' + mutual + '</div><div class="lab">互关</div><div class="tag">统计</div></div>';
      (options.extras || []).forEach(function (item) {
        html += '<button type="button" class="card tier-card" data-jump-id="' + escHtml(item.id) + '" data-count="' + escHtml(item.count) + '"><div class="num">' + escHtml(item.count) + '</div><div class="lab">' + escHtml(item.label) + "</div></button>";
      });
      return html + "</div>";
    }
    if (options.interactionReady === false) {
      var note = options.interactionNote || INTERACTION_THIN;
      var why = "分层门槛：至少 1 天有你发出的回复，并且至少 1 天有别人回复你，两边合计不少于 2 个不同日期。只采到关注或粉丝名单时，这些天是无数据，不会把互关记成沉睡互关、零互动或单向。";
      return '<div class="warn" id="interaction-thin">' + escHtml(note) + '</div><p class="muted">' + escHtml(why) + "</p>" + statCards();
    }
    var cards = '<div class="grid tier-cards">';
    TIERS.forEach(function (t) {
      var n = count[t] || 0;
      cards += '<button type="button" class="card tier-card' + (n ? "" : " empty") + '" data-jump="' + escHtml(t) + '" data-count="' + n + '"><div class="num">' + n + "</div><div class=\"lab\">" + escHtml(t) + "</div></button>";
    });
    cards += "</div>" + statCards();
    cards += '<p id="jump-note" class="muted"></p>';
    function bars(items, jump) {
      var max = 0;
      items.forEach(function (it) { if (it[1] > max) max = it[1]; });
      return items.map(function (it) {
        var w = max ? Math.round(220 * it[1] / max) : 0;
        var openTag = jump ? '<button type="button" class="bar" data-jump="' + escHtml(it[0]) + '" data-count="' + it[1] + '">' : '<div class="bar">';
        var closeTag = jump ? "</button>" : "</div>";
        return openTag + '<span class="k">' + escHtml(it[0]) + '</span><span class="b ' + (it[2] || "") + '" style="width:' + w + 'px"></span><b>' + it[1] + "</b>" + closeTag;
      }).join("");
    }
    var starCount = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0};
    var thin = 0;
    rows.forEach(function (x) {
      if (x.status === "ok") starCount[x.stars] = (starCount[x.stars] || 0) + 1;
      else if (x.raw || x.L_in) thin += 1;
    });
    var panels = '<div class="panels"><div class="card"><h2>星级分布</h2>' + bars([["★★★★★", starCount[5] || 0, ""], ["★★★★", starCount[4] || 0, ""], ["★★★", starCount[3] || 0, ""], ["★★", starCount[2] || 0, ""], ["★", starCount[1] || 0, ""], ["样本不足", thin, "gray"]]) +
      '</div><div class="card"><h2>分层人数</h2>' + bars(TIERS.map(function (t) {
        var c = t === "金牌" ? "gold" : t === "银牌" ? "silver" : t.indexOf("他常来") >= 0 ? "green" : t.indexOf("我常去") >= 0 ? "red" : "gray";
        return [t, count[t] || 0, c];
      }), true) + "</div></div>";
    var blocks = TIERS.map(function (t) {
      var xs = rows.filter(function (x) { return x.tier === t; });
      var shown = options.showAll || open[t] ? xs : xs.slice(0, 20);
      var body = '<p class="muted">这一层暂时没有人</p>';
      if (xs.length) {
        body = "<table><tr><th>账号</th><th>星级</th><th>分数</th><th>数据</th></tr>";
        shown.forEach(function (x) {
          body += "<tr><td>" + nameCell(x.account) + "</td><td>" + starsText(x) + "</td><td>" + (x.score == null ? "—" : escHtml(x.score)) + "</td><td>" + escHtml(listFacts(x)) + "</td></tr>";
        });
        body += "</table>";
        if (!options.showAll && xs.length > 20 && !open[t]) body += '<button type="button" data-expand="' + escHtml(t) + '">展开全部</button>';
      }
      return '<section class="card tier-block" id="tier-' + t + '" data-total="' + xs.length + '" data-shown="' + shown.length + '"><div class="block-head"><h2>' + escHtml(t) + "（" + xs.length + '）</h2><a class="back-top" href="#top">回到顶部</a></div>' + body + "</section>";
    }).join("");
    var factNote = '<p class="muted">回访率 = 对方回复我的条数 ÷ 我发出的条数（都含问候）。我没有发出过就写 —，不写 0%。互动是这段时间的说话条数，往返是确认对上的轮数。这些只是展示，不改分数。</p>';
    return cards + panels + factNote + blocks;
  }
  function indexAccounts(records) {
    var items = [], byId = {}, byHandle = {};
    (records || []).forEach(function (record) {
      var uid = record.id || "";
      var handle = record.handle || "";
      if (!uid && !handle) return;
      if (uid && byId[uid]) return;
      if (!uid && byHandle[handle]) return;
      if (uid && handle && byHandle[handle] && !byHandle[handle].id) {
        byHandle[handle].id = uid;
        byId[uid] = byHandle[handle];
        return;
      }
      var item = {id: uid, handle: handle, name: record.name || ""};
      if (uid && handle && byHandle[handle] && byHandle[handle].id && byHandle[handle].id !== uid) {
        items.push(item);
        byId[uid] = item;
        return;
      }
      items.push(item);
      if (uid) byId[uid] = item;
      if (handle && !byHandle[handle]) byHandle[handle] = item;
    });
    return {items: items, byId: byId, byHandle: byHandle};
  }
  function findMatch(item, other) {
    if (item.id && other.byId[item.id]) return other.byId[item.id];
    if (!item.handle || !other.byHandle[item.handle]) return null;
    var cand = other.byHandle[item.handle];
    if (item.id && cand.id && item.id !== cand.id) return null;
    return cand;
  }
  function onlyIn(left, right) {
    return left.items.filter(function (item) { return !findMatch(item, right); }).sort(function (a, b) {
      if (a.handle !== b.handle) return a.handle < b.handle ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });
  }
  function collisionMap(groups) {
    var seen = {}, bad = {};
    groups.forEach(function (items) {
      (items || []).forEach(function (item) {
        if (!item.handle || !item.id) return;
        if (seen[item.handle] && seen[item.handle] !== item.id) bad[item.handle] = 1;
        else seen[item.handle] = item.id;
      });
    });
    return bad;
  }
  function followDiff(data) {
    if (data && data.followAuto && data.followAuto.waiting) {
      var waitingNote = data.followAuto.note || "";
      return {
        unfollowed_me: null, new_followers: null, i_unfollowed: null, i_followed: null,
        notes: waitingNote ? [waitingNote] : [], collisions: {}, ready: false
      };
    }
    if (!data || (!data.sawPrevFollowers && !data.sawPrevFollowing)) return null;
    var notes = [];
    var unfollowed = null, fresh = null, dropped = null, added = null;
    if (data.sawPrevFollowers && data.sawFollowers) {
      var oldFer = indexAccounts(data.prevFollowerAccounts || []);
      var newFer = indexAccounts(data.followerAccounts || []);
      unfollowed = onlyIn(oldFer, newFer);
      fresh = onlyIn(newFer, oldFer);
    } else notes.push("没有同时找到旧的和新的关注者，取关我的和新粉丝先不算");
    if (data.sawPrevFollowing && data.sawFollowing) {
      var oldFol = indexAccounts(data.prevFollowingAccounts || []);
      var newFol = indexAccounts(data.followingAccounts || []);
      dropped = onlyIn(oldFol, newFol);
      added = onlyIn(newFol, oldFol);
    } else notes.push("没有同时找到旧的和新的正在关注，我取关的和我新关注的先不算");
    if (data.followAuto && data.followAuto.note) notes.unshift(data.followAuto.note);
    return {
      unfollowed_me: unfollowed, new_followers: fresh, i_unfollowed: dropped, i_followed: added,
      notes: notes, collisions: collisionMap([unfollowed, fresh, dropped, added]),
      ready: unfollowed !== null || dropped !== null
    };
  }
  function aliasText(n) {
    var s = String(n);
    return "账号#" + (s.length < 2 ? "0" + s : s);
  }
  function followDiffHtml(diff, options) {
    if (!diff) return "";
    options = options || {};
    var known = {};
    (options.rows || []).forEach(function (row, i) { known[row.account] = aliasText(i + 1); });
    var next = (options.rows || []).length + 1;
    var assigned = {};
    var collisions = diff.collisions || {};
    function label(item) {
      var key = item.handle || item.id;
      if (item.handle && item.id && collisions[item.handle]) key = item.handle + "#" + item.id;
      if (options.masked) {
        var shown = known[key];
        if (!shown) {
          if (!assigned[key]) { assigned[key] = aliasText(next); next += 1; }
          shown = assigned[key];
        }
        return escHtml(shown);
      }
      var text = item.handle ? "@" + item.handle : (item.id || "");
      if (item.handle && item.id && collisions[item.handle]) text = "@" + item.handle + "（id " + item.id + "）";
      if (!item.handle) return escHtml(text);
      return profileAnchor(item.handle, text);
    }
    var order = [["unfollowed_me", "取关我的"], ["new_followers", "新粉丝"], ["i_unfollowed", "我取关的"], ["i_followed", "我新关注的"]];
    var notes = (diff.notes || []).map(function (note) { return '<p class="muted">' + escHtml(note) + "</p>"; }).join("");
    var cards = [], lists = [];
    order.forEach(function (pair) {
      var items = diff[pair[0]];
      var count = items == null ? "—" : String(items.length);
      cards.push('<div class="card"><div class="num">' + count + '</div><div class="lab">' + escHtml(pair[1]) + "</div></div>");
      var heading, body;
      if (items == null) { heading = pair[1]; body = '<p class="muted">先不算</p>'; }
      else if (!items.length) { heading = pair[1] + "（0）"; body = '<p class="muted">（暂时没有）</p>'; }
      else {
        heading = pair[1] + "（" + items.length + "）";
        body = "<p>" + items.slice(0, 60).map(label).join("、") + (items.length > 60 ? "…" : "") + "</p>";
      }
      lists.push("<p><b>" + escHtml(heading) + "</b></p>" + body);
    });
    return '<section class="card" id="follow-diff" style="margin-bottom:16px"><h2>关注变化</h2><p class="muted">和上一份名单比。有用户 ID 时按 ID 对齐，没有就用用户名。只读，不会关注或取关。</p>'
      + notes + '<div class="grid">' + cards.join("") + "</div>" + lists.join("") + "</section>";
  }
  function interactionCount(row) {
    if (!row) return 0;
    return (row.raw || 0) + (row.L_in || 0) + (row.L_out || 0);
  }
  function notFollowedBack(data, rows) {
    if (!data || (!data.sawFollowing && !data.sawFollowers)) {
      if (data && data.notBackAlways) return {ready: false, items: null, note: "没有同时找到正在关注和关注者，没回关先不算。"};
      return null;
    }
    if (!data.sawFollowing || !data.sawFollowers) {
      return {ready: false, items: null, note: "没有同时找到正在关注和关注者，没回关先不算。"};
    }
    var byHandle = {};
    (rows || []).forEach(function (row) { if (row && row.account) byHandle[row.account] = row; });
    var keepIds = data.keepIds || {};
    var keepHandles = data.keepHandles || {};
    var items = onlyIn(indexAccounts(data.followingAccounts), indexAccounts(data.followerAccounts)).filter(function (person) {
      if (person.id && keepIds[person.id]) return false;
      if (person.handle && keepHandles[person.handle]) return false;
      return true;
    }).map(function (person) {
      var row = byHandle[person.handle];
      var score = null, tier = "";
      if (row) {
        if (row.status === "ok") score = row.score;
        tier = row.tier || "";
      }
      return {id: person.id, handle: person.handle, interactions: interactionCount(row), score: score, tier: tier};
    });
    items.sort(function (a, b) {
      function key(item) {
        return [item.interactions === 0 ? 0 : 1, item.score == null ? 0 : 1, item.score == null ? 0 : item.score, item.handle || "", item.id || ""];
      }
      var ka = key(a), kb = key(b);
      for (var i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
    return {ready: true, items: items, note: ""};
  }
  function scoreText(item) {
    if (item.score == null) return "—";
    if (typeof item.score === "number" && Math.abs(item.score - Math.round(item.score)) < 1e-9) return String(Math.round(item.score));
    return String(item.score);
  }
  function notFollowedBackHtml(info, options) {
    if (!info) return "";
    options = options || {};
    var known = {};
    (options.rows || []).forEach(function (row, i) { known[row.account] = aliasText(i + 1); });
    var next = (options.rows || []).length + 1;
    var assigned = {};
    var items = info.items || [];
    var seen = {}, collisions = {};
    items.forEach(function (item) {
      if (!item.handle || !item.id) return;
      if (seen[item.handle] && seen[item.handle] !== item.id) collisions[item.handle] = 1;
      else seen[item.handle] = item.id;
    });
    function label(item) {
      var key = item.handle || item.id;
      if (item.handle && item.id && collisions[item.handle]) key = item.handle + "#" + item.id;
      if (options.masked) {
        if (known[key]) return escHtml(known[key]);
        if (!assigned[key]) { assigned[key] = aliasText(next); next += 1; }
        return escHtml(assigned[key]);
      }
      if (!item.handle) return escHtml(item.id || "");
      var text = "@" + item.handle;
      if (collisions[item.handle] && item.id) text += "（id " + item.id + "）";
      return profileAnchor(item.handle, text);
    }
    var count = info.ready ? String(items.length) : "—";
    var body;
    if (!info.ready) body = '<p class="muted">' + escHtml(info.note || "") + "</p>";
    else if (!items.length) body = '<p class="muted">（暂时没有）</p>';
    else {
      body = "<table><tr><th>账号</th><th>互动</th><th>分数</th><th>分层</th></tr>";
      items.forEach(function (item) {
        body += "<tr><td>" + label(item) + "</td><td>" + item.interactions + "</td><td>" + escHtml(scoreText(item)) + "</td><td>" + escHtml(item.tier || "—") + "</td></tr>";
      });
      body += "</table>";
    }
    return '<section class="card" id="not-followed-back" style="margin-bottom:16px"><h2>没回关</h2>'
      + '<p class="muted">我关注了、对方没有回关。零互动的排在前面，然后按分数从低到高。</p>'
      + '<p class="muted">工具不会自动取关或屏蔽。要取关请手动、慢慢来。</p>'
      + '<div class="grid"><div class="card"><div class="num">' + count + '</div><div class="lab">没回关</div></div></div>'
      + body + "</section>";
  }
  function applyConfig(cfg) {
    if (!cfg) return;
    ["window", "weights", "persistence", "greeting_cap", "likes", "insufficient", "stars", "tiers", "greetings", "exclude_accounts"].forEach(function (key) {
      if (cfg[key] != null) CONFIG[key] = cfg[key];
    });
  }
  function renderReport(data, options) {
    options = options || {};
    applyConfig(options.config);
    var opt = {me: options.me || "", gapsAreEmpty: options.gapsAreEmpty !== false};
    if (options.tz) opt.tz = options.tz;
    if (options.allDays) opt.allDays = true;
    else {
      if (options.end) opt.end = options.end;
      if (options.days) opt.days = options.days;
    }
    var result = analyze(data, opt);
    var rows = result.rows;
    var back = notFollowedBack(data, rows);
    var diff = followDiff(data);
    var extras = [];
    if (back) extras.push({id: "not-followed-back", count: back.ready ? String(back.items.length) : "—", label: "没回关"});
    if (diff) {
      var changeKeys = ["unfollowed_me", "new_followers", "i_unfollowed", "i_followed"];
      var changeSeen = false, changeTotal = 0;
      changeKeys.forEach(function (key) {
        if (diff[key] != null) { changeSeen = true; changeTotal += diff[key].length; }
      });
      extras.push({id: "follow-diff", count: changeSeen ? String(changeTotal) : "—", label: "关注变化"});
    }
    var html = boardHtml(rows, {masked: !!options.masked, open: options.open || {}, extras: extras, showAll: !!options.showAll, interactionReady: result.meta.interactionReady !== false, interactionNote: result.meta.interactionNote || ""});
    if (back) html += notFollowedBackHtml(back, {masked: !!options.masked, rows: rows});
    if (diff) html += followDiffHtml(diff, {masked: !!options.masked, rows: rows});
    return {html: html, rows: rows, meta: result.meta, back: back, diff: diff};
  }
  root.FanAudit = {CONFIG: CONFIG, TIERS: TIERS, defaultTimeZone: defaultTimeZone, analyze: analyze, loadTexts: loadTexts, parseCsv: parseCsv, fileKind: fileKind, nameKind: nameKind, inferOwner: inferOwner, repliesFromTweets: repliesFromTweets, boardHtml: boardHtml, revisitText: revisitText, listFacts: listFacts, jumpPlan: jumpPlan, followDiff: followDiff, followDiffHtml: followDiffHtml, notFollowedBack: notFollowedBack, notFollowedBackHtml: notFollowedBackHtml, renderReport: renderReport};
})(root);
/* FAN_ENGINE_END */
var FanAudit = root.FanAudit;
/*
 * 被动解析 X 页面已经收到的 GraphQL 响应。
 *
 * 钩子装法和时间线拆法参考 twitter-web-exporter（MIT）
 * https://github.com/prinsss/twitter-web-exporter
 * Copyright (c) 2023 prin
 * 见 userscript/fan-audit.user.js 开头的许可全文。
 * 对照过的上游文件：src/core/extensions/manager.ts、src/utils/api.ts、
 * src/modules/user-tweets/api.ts、followers/api.ts、following/api.ts、
 * search-timeline/api.ts、tweet-detail/api.ts（2026-10 的 main）。
 * 这里只留下打分要用的短字段，不保存原始响应。
 */

var RETENTION_DAYS = 90;
var RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
var EMPTY_GUIDE = "刚安装还没有数据？依次打开你的关注列表、粉丝列表和主页回复页，手动往下滑几屏，脚本会记下。";
var TEXT_LIMIT = 30;
var SNAPSHOT_WAITING = "下次完整采集后自动对比";
// 自动读取默认关闭，刷新后也不恢复。这些数只约束「用户勾选并点了开始」之后的那一次。
var AUTO_READ_GAP_MIN_MS = 1000;
var AUTO_READ_GAP_MAX_MS = 2000;
var AUTO_READ_MAX_SCREENS = 220;
var AUTO_READ_MAX_MS = 12 * 60 * 1000;
var AUTO_READ_STALL_MS = 45000;
var AUTO_READ_STALL_SCREENS = 4;
var AUTO_READ_STALL_FLOOR_MS = 12000;
// 到底或页面不再滚动之后，还要连续这么多次看不到加载，才停。
var AUTO_READ_DRY_LIMIT = 5;
// 已记人数完全不增加时，满 30 屏或满 1 分钟就停。画面还在换也不再无限滚。
var AUTO_READ_FLAT_SCREENS = 30;
var AUTO_READ_FLAT_MS = 60 * 1000;
var FAST_READ_PAGE_SIZE = 100;
var FAST_READ_MAX_PAGES = 120;
var FAST_READ_REMAINING_FLOOR = 2;
var AUTO_READ_RISK = "自动读取默认关闭。两种方式都只读你自己的关注和粉丝名单，不会关注、取关、点赞、转发、回复、私信或拉黑，也不会读别人的名单。\n\n滚动：脚本代替你在当前页面往下翻，让页面自己加载。这已经不属于「只读你浏览过的内容」。\n\n快速：脚本自己连续请求 X 的关注和粉丝列表接口，用游标一页一页往下读。这是自动化抓取，风险比滚动更高，可能被限流、临时限制甚至封号。X 没有公布具体阈值，不能保证安全，后果自负。不想冒险就关掉，继续用手动滑动。";
var AUTO_READ_ACK = "我已阅读上面的提示。我知道快速模式会由脚本自己连续请求列表接口，可能被限流、临时限制甚至封号，后果自己承担。";

var OPS = {
  UserRepliesTimeline: "replies",
  UserTweetsAndReplies: "replies",
  UserOriginalsTimeline: "originals",
  UserTweets: "originals",
  SearchTimeline: "search",
  Followers: "followers",
  BlueVerifiedFollowers: "blue-followers",
  Following: "following",
  TweetDetail: "detail",
  ModeratedTimeline: "detail",
  NotificationsTimeline: "notifications",
  UserByScreenName: "counts",
  UserByRestId: "counts"
};

var POST_FIELDS = ["id", "uid", "handle", "name", "verified", "replyTo", "replyToHandle", "conv", "ts", "text", "src", "seen"];

function emptyStore() {
  return {
    v: 1,
    prefs: {masked: false, tz: "", mode: "30", owner: ""},
    posts: {},
    following: {},
    followers: {},
    totals: {followers: 0, following: 0, blue: 0},
    snapshots: [],
    keepEntries: [],
    keepIds: {},
    keepHandles: {},
    extraRows: [],
    meta: {sawFollowing: false, sawFollowers: false, sawBlueFollowers: false, sawNotifications: false, sawExport: false}
  };
}

function norm(value) {
  return String(value || "").trim().replace(/^@/, "").trim().toLowerCase();
}

function operationName(url) {
  var text = String(url || "");
  var match = text.match(/\/graphql\/[^/?#]+\/([A-Za-z0-9_]+)/);
  if (match) return match[1];
  if (/\/notifications\/all\.json(?:\?|#|$)/.test(text)) return "NotificationsAll";
  if (/\/notifications\/mentions\.json(?:\?|#|$)/.test(text)) return "NotificationsMentions";
  if (/\/notifications\/verified\.json(?:\?|#|$)/.test(text)) return "NotificationsVerified";
  return "";
}

function classifyUrl(url) {
  var op = operationName(url);
  if (OPS[op]) return OPS[op];
  if (/^Notifications[A-Za-z0-9]*Timeline$/.test(op)) return "notifications";
  if (op === "NotificationsAll" || op === "NotificationsMentions" || op === "NotificationsVerified") return "notifications";
  return "";
}

function listKindFromPath(pathname, owner) {
  var me = norm(owner);
  if (!me) return "";
  var match = String(pathname || "").match(/^\/([A-Za-z0-9_]{1,15})\/(followers|verified_followers|following)\/?$/);
  if (!match || norm(match[1]) !== me) return "";
  if (match[2] === "following") return "following";
  if (match[2] === "verified_followers") return "blue-followers";
  return "followers";
}

function badgeText(label, count, base) {
  if (!label) return "";
  var n = count | 0;
  var extra = base != null && n > base ? " +" + (n - base) : "";
  return " " + label + " " + n + extra;
}

function pageContext(pathname, search, owner) {
  var path = String(pathname || "");
  var query = "";
  var raw = String(search || "");
  var found = raw.match(/(?:^|[?&])q=([^&]*)/);
  if (found) {
    try { query = decodeURIComponent(found[1].replace(/\+/g, " ")); } catch (err) { query = found[1]; }
  }
  if (/^\/notifications(?:\/mentions)?\/?$/.test(path)) return {kind: "notifications", label: "通知"};
  if ((path === "/search" || path.indexOf("/search/") === 0) && queryMentionsTo(query, owner)) return {kind: "inbound", label: "别人回我"};
  var list = listKindFromPath(path, owner);
  if (list === "following") return {kind: "following", label: "关注"};
  if (list === "followers" || list === "blue-followers") return {kind: "followers", label: "粉丝"};
  if (timelineKindFromPath(path, owner) === "replies") return {kind: "replies", label: "主页回复"};
  return {kind: "", label: ""};
}

function timelineKindFromPath(pathname, owner) {
  var me = norm(owner);
  if (!me) return "";
  var match = String(pathname || "").match(/^\/([A-Za-z0-9_]{1,15})(\/with_replies)?\/?$/);
  if (!match || norm(match[1]) !== me) return "";
  return match[2] ? "replies" : "originals";
}

function userFromVisible(hrefs, nameText, verified) {
  var handle = "";
  var text = String(nameText || "");
  var at = text.match(/@([A-Za-z0-9_]{1,15})/);
  if (at) handle = at[1];
  var list = hrefs || [];
  for (var i = 0; i < list.length && !handle; i++) {
    var match = String(list[i] || "").match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (match) handle = match[1];
  }
  handle = norm(handle);
  if (!handle) return null;
  var name = "";
  var parts = text.split(/@/);
  if (parts.length) name = parts[0].replace(/\s+/g, " ").trim().slice(0, 40);
  return {id: "", handle: handle, name: name, verified: !!verified, followers: 0};
}

var SKIP_OK = {
  "不在采集名单": 1,
  "响应不是 JSON": 1,
  "不是你的关注或粉丝列表": 1,
  "不是你的主页时间线": 1,
  "还不知道你的用户名": 1,
  "搜索不是 to:你的用户名": 1
};

function safeOp(value) {
  var text = String(value || "");
  return /^[A-Z][A-Za-z0-9]{1,60}$/.test(text) ? text : "";
}

function safeCode(value) {
  var text = String(value || "").toLowerCase().replace(/_/g, "-");
  return /^[a-z0-9-]{1,24}$/.test(text) ? text : "unknown";
}

function diagnosticsCopy(state) {
  state = state || {};
  var matched = [];
  Object.keys(state.matched || {}).sort().forEach(function (key) {
    var op = safeOp(key);
    if (!op) return;
    matched.push(op + "=" + (state.matched[key] | 0));
  });
  var unmatched = [];
  (state.unmatched || []).forEach(function (key) {
    var op = safeOp(key);
    if (op && unmatched.indexOf(op) < 0) unmatched.push(op);
  });
  var skips = [];
  var byOp = state.skipsByOp || {};
  var opKeys = Object.keys(byOp);
  if (opKeys.length) {
    opKeys.sort().forEach(function (rawOp) {
      var op = safeOp(rawOp) || "other";
      var reasons = byOp[rawOp] || {};
      Object.keys(reasons).sort().forEach(function (reason) {
        var label = SKIP_OK[reason] ? reason : "other";
        skips.push(op + ":" + label + "=" + (reasons[reason] | 0));
      });
    });
  } else {
    Object.keys(state.skips || {}).sort().forEach(function (key) {
      var label = SKIP_OK[key] ? key : "other";
      var count = state.skips[key] | 0;
      var found = false;
      for (var i = 0; i < skips.length; i++) {
        if (skips[i].label === label) { skips[i].count += count; found = true; }
      }
      if (!found) skips.push({label: label, count: count});
    });
    skips = skips.map(function (item) { return item.label + "=" + item.count; });
  }
  return [
    "fan-audit diagnostics",
    "hook=" + safeCode(state.hook),
    "world=" + safeCode(state.world),
    "sameRealm=" + (state.sameRealm ? "yes" : "no"),
    "pageApp=" + (state.pageApp ? "yes" : "no"),
    "graphqlSeen=" + (state.graphqlSeen | 0),
    "matched=" + (matched.join(",") || "none"),
    "unmatched=" + (unmatched.join(",") || "none"),
    "domAccepted=" + (state.domAccepted | 0),
    "ownerDetected=" + (state.ownerDetected ? "yes" : "no"),
    "storedPosts=" + (state.storedPosts | 0),
    "storedFollowing=" + (state.storedFollowing | 0),
    "storedFollowers=" + (state.storedFollowers | 0),
    "skips=" + (skips.join(",") || "none")
  ].join("\n");
}

function sameRealm(page) {
  try {
    if (!page) return false;
    if (typeof window !== "undefined" && page === window) return true;
    if (typeof XMLHttpRequest === "function" && page.XMLHttpRequest === XMLHttpRequest) return true;
  } catch (err) {}
  return false;
}

function coreLen(text) {
  var source = String(text || "").replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "");
  var count = 0;
  var chars = Array.from(source);
  for (var i = 0; i < chars.length; i++) {
    if (/\p{L}|\p{N}/u.test(chars[i])) count += 1;
  }
  return count;
}

function snippet(text, limit) {
  var chars = Array.from(String(text || "").replace(/\s+/g, " ").trim());
  var max = limit || TEXT_LIMIT;
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
}

// 问候判断看「去掉标点后的字数」和词表。只存 30 字时，长文如果开头像问候，会被误判。
// 全文已经超过问候长度上限时，补两个字，让打分引擎仍把它当成非问候。
function textForStore(full) {
  var short = snippet(full, TEXT_LIMIT);
  var fullCore = coreLen(full);
  var shortCore = coreLen(short);
  // 引擎把「去标点后不超过 15 字且含问候词」当客套话。截断会让长文只剩开头的「早安」。
  // 全文已经超过 15 字时补足字数，截断后的判断才和全文一致。
  if (fullCore > 15 && shortCore <= 15) short += "补".repeat(16 - shortCore);
  return short;
}

function toIso(raw) {
  if (!raw) return "";
  var parsed = new Date(String(raw).trim());
  if (isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
}

function readUser(user) {
  if (!user || typeof user !== "object") return null;
  if (user.result && typeof user.result === "object" && !user.rest_id && !user.restId && !user.core && !user.legacy) {
    return readUser(user.result);
  }
  if (user.__typename === "UserUnavailable") return null;
  var core = user.core || {};
  var legacy = user.legacy || {};
  var handle = core.screen_name || core.screenName || legacy.screen_name || legacy.screenName || user.screen_name || "";
  var id = String(user.rest_id || user.restId || legacy.id_str || "");
  if (!handle && !id) return null;
  var counts = user.relationship_counts || {};
  var followers = counts.followers;
  if (followers == null) followers = legacy.followers_count;
  var followersNum = typeof followers === "number" ? followers : parseInt(followers || 0, 10);
  if (isNaN(followersNum)) followersNum = 0;
  var verified = user.is_blue_verified === true || !!(user.verification && user.verification.verified === true) || legacy.verified === true;
  return {
    id: id,
    handle: norm(handle),
    name: String(core.name || legacy.name || "").replace(/\s+/g, " ").trim(),
    verified: verified,
    followers: followersNum
  };
}

function readTweet(result) {
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetWithVisibilityResults") return readTweet(result.tweet);
  if (result.__typename === "TweetTombstone" || result.__typename === "TweetUnavailable") return null;
  var legacy = result.legacy || {};
  if (legacy.retweeted_status_result && legacy.retweeted_status_result.result) return null;
  var authorNode = result.core && result.core.user_results && result.core.user_results.result;
  var author = readUser(authorNode) || {id: "", handle: "", name: "", verified: false, followers: 0};
  var id = String(result.rest_id || legacy.id_str || "");
  if (!id) return null;
  var note = result.note_tweet && result.note_tweet.note_tweet_results && result.note_tweet.note_tweet_results.result;
  var full = (note && note.text) || legacy.full_text || "";
  var replyTo = String(legacy.in_reply_to_status_id_str || "");
  if (replyTo === "null" || replyTo === "undefined") replyTo = "";
  return {
    id: id,
    uid: author.id || "",
    handle: author.handle || "",
    name: author.name || "",
    verified: !!author.verified,
    replyTo: replyTo,
    replyToHandle: norm(legacy.in_reply_to_screen_name || ""),
    conv: String(legacy.conversation_id_str || ""),
    ts: toIso(legacy.created_at || ""),
    text: textForStore(full)
  };
}

function notificationIcon(content) {
  if (!content) return "";
  var icon = content.notification_icon || content.notificationIcon || "";
  if (icon && typeof icon === "object") icon = icon.id || "";
  return String(icon || "").toLowerCase();
}

function isNotificationItem(content) {
  var kind = String((content && (content.itemType || content.__typename)) || "");
  return kind.indexOf("Notification") >= 0 || !!notificationIcon(content) || !!(content && content.template);
}

function replyLikeIcon(icon) {
  return icon.indexOf("reply") >= 0 || icon.indexOf("mention") >= 0;
}

function noiseIcon(icon) {
  if (!icon || replyLikeIcon(icon)) return false;
  return /heart|like|favorite|person|follow|retweet|repost|bell/.test(icon);
}

function keepNotification(content) {
  var icon = notificationIcon(content);
  if (noiseIcon(icon)) return false;
  var kind = String(content.itemType || content.__typename || "");
  if (kind.indexOf("Aggregate") >= 0 && !replyLikeIcon(icon)) return false;
  return true;
}

function absorbTweetish(node, tweets, users) {
  if (!node || typeof node !== "object") return;
  if (node.tweet_results || node.tweetResults || node.user_results || node.userResults) fromItemContent(node, tweets, users);
  var wrapped = node.tweet && (node.tweet.result || node.tweet);
  if (wrapped && wrapped !== node) {
    var nested = readTweet(wrapped);
    if (nested) tweets.push(nested);
  }
  if (node.rest_id || node.restId || (node.legacy && node.legacy.full_text)) {
    var direct = readTweet(node);
    if (direct) tweets.push(direct);
  }
}

function fromItemContent(content, tweets, users) {
  if (!content || typeof content !== "object") return;
  if (isNotificationItem(content)) {
    if (!keepNotification(content)) return;
    var template = content.template || {};
    var targets = template.target_objects || template.targetObjects || [];
    for (var t = 0; t < targets.length; t++) absorbTweetish(targets[t], tweets, users);
  }
  if (content.tweet_results) {
    var tweet = readTweet(content.tweet_results.result);
    if (tweet) tweets.push(tweet);
  }
  var userNode = content.user_results || content.userResults;
  if (userNode) {
    var user = readUser(userNode.result || userNode);
    if (user && (user.handle || user.id)) users.push(user);
  }
}

function takeNode(node, tweets, users) {
  if (!node || typeof node !== "object") return;
  var content = node.itemContent || (node.item && node.item.itemContent) || (node.content && node.content.itemContent);
  fromItemContent(content, tweets, users);
  var items = (node.content && node.content.items) || node.items || [];
  for (var i = 0; i < items.length; i++) {
    var entryId = String(items[i].entryId || "");
    if (entryId.indexOf("cursor") >= 0 || entryId.indexOf("showmore") >= 0) continue;
    takeNode(items[i], tweets, users);
  }
}

function dedupeTweets(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (!list[i].id || seen[list[i].id]) continue;
    seen[list[i].id] = 1;
    out.push(list[i]);
  }
  return out;
}

function dedupeUsers(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var key = list[i].id || list[i].handle;
    if (!key || seen[key]) continue;
    seen[key] = 1;
    out.push(list[i]);
  }
  return out;
}

function collect(instructions) {
  var tweets = [];
  var users = [];
  var list = instructions || [];
  for (var i = 0; i < list.length; i++) {
    var ins = list[i];
    if (!ins) continue;
    if (ins.entry && String(ins.entry.entryId || "").indexOf("cursor") < 0) takeNode(ins.entry, tweets, users);
    var entries = ins.entries || [];
    for (var e = 0; e < entries.length; e++) {
      if (String(entries[e].entryId || "").indexOf("cursor") >= 0) continue;
      takeNode(entries[e], tweets, users);
    }
    var modules = ins.moduleItems || [];
    for (var m = 0; m < modules.length; m++) takeNode(modules[m], tweets, users);
  }
  return {tweets: dedupeTweets(tweets), users: dedupeUsers(users)};
}

function readProfile(json) {
  var user = json && json.data && json.data.user && json.data.user.result;
  if (user && user.result && !user.rest_id && !user.restId && !user.core && !user.legacy) user = user.result;
  return readUser(user);
}

function looksLikeInstructions(list) {
  if (!Array.isArray(list) || !list.length) return false;
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item && (item.entries || item.entry || item.moduleItems || item.type)) return true;
  }
  return false;
}

function findInstructions(node, depth) {
  if (!node || depth > 7 || typeof node !== "object") return null;
  if (looksLikeInstructions(node.instructions)) return node.instructions;
  var keys = ["user", "result", "timeline", "timeline_v2", "search_timeline", "search_by_raw_query", "tweet", "timeline_response"];
  for (var i = 0; i < keys.length; i++) {
    if (node[keys[i]] && typeof node[keys[i]] === "object") {
      var found = findInstructions(node[keys[i]], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function readInstructions(json, kind) {
  var data = (json && json.data) || {};
  var specific = [];
  if (kind === "search") {
    var search = data.search_by_raw_query && data.search_by_raw_query.search_timeline && data.search_by_raw_query.search_timeline.timeline;
    specific = (search && search.instructions) || [];
  } else if (kind === "detail") {
    var thread = data.threaded_conversation_with_injections_v2;
    if (thread && thread.instructions) specific = thread.instructions;
    else {
      var moderated = data.tweet && data.tweet.result && data.tweet.result.timeline_response && data.tweet.result.timeline_response.timeline;
      specific = (moderated && moderated.instructions) || [];
    }
  } else if (kind === "notifications") {
    var viewer = (data.viewer_v2 && data.viewer_v2.user_results && data.viewer_v2.user_results.result)
      || (data.viewer && data.viewer.user_results && data.viewer.user_results.result)
      || null;
    var noteTimeline = viewer && (viewer.notification_timeline || viewer.notifications_timeline);
    specific = (noteTimeline && noteTimeline.timeline && noteTimeline.timeline.instructions) || [];
  } else {
    var direct = data.user && data.user.result && data.user.result.timeline && data.user.result.timeline.timeline;
    specific = (direct && direct.instructions) || [];
  }
  if (specific.length) return specific;
  return findInstructions(data, 0) || [];
}

function screenNameFromRequest(url, body) {
  function from(source) {
    if (!source) return "";
    var text = String(source);
    var match = text.match(/(?:[?&])variables=([^&#]+)/);
    var raw = "";
    if (match) {
      try { raw = decodeURIComponent(match[1]); } catch (err) { raw = match[1]; }
    } else if (text.indexOf("screen_name") >= 0 || text.indexOf("screenName") >= 0) raw = text;
    else return "";
    try {
      var obj = JSON.parse(raw);
      if (obj && obj.variables) obj = obj.variables;
      if (obj && (obj.screen_name || obj.screenName)) return norm(obj.screen_name || obj.screenName);
    } catch (err) {}
    var found = raw.match(/"screen_?[Nn]ame"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!found) return "";
    try { return norm(JSON.parse('"' + found[1] + '"')); } catch (err2) { return norm(found[1]); }
  }
  return from(url) || from(body);
}

function queryFromText(text) {
  if (!text) return "";
  var source = String(text);
  var match = source.match(/(?:[?&])variables=([^&#]+)/);
  var raw = "";
  if (match) {
    try { raw = decodeURIComponent(match[1]); } catch (err) { raw = match[1]; }
  } else if (source.indexOf("rawQuery") >= 0) raw = source;
  else return "";
  try {
    var obj = JSON.parse(raw);
    if (obj && obj.variables) obj = obj.variables;
    if (obj && obj.rawQuery) return String(obj.rawQuery);
  } catch (err) {}
  var found = raw.match(/"rawQuery"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!found) return "";
  try { return JSON.parse('"' + found[1] + '"'); } catch (err2) { return found[1]; }
}

function readRawQuery(url, body) {
  return queryFromText(url) || queryFromText(body);
}

function queryMentionsTo(query, owner) {
  var me = norm(owner);
  if (!me) return false;
  var escaped = me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|\\s)to:" + escaped + "(?=\\s|$)", "i").test(String(query || ""));
}

function relatedTweets(tweets, owner) {
  var me = norm(owner);
  if (!me) return [];
  var byId = {};
  for (var i = 0; i < tweets.length; i++) if (tweets[i].id) byId[tweets[i].id] = tweets[i];
  var keep = {};
  function mark(tweet) { if (tweet && tweet.id) keep[tweet.id] = tweet; }
  for (var j = 0; j < tweets.length; j++) {
    var tweet = tweets[j];
    var handle = norm(tweet.handle);
    var target = norm(tweet.replyToHandle) || norm(byId[tweet.replyTo] && byId[tweet.replyTo].handle);
    if (handle === me || target === me) mark(tweet);
  }
  Object.keys(keep).forEach(function (id) {
    var parentId = keep[id].replyTo;
    if (parentId && byId[parentId]) mark(byId[parentId]);
  });
  return Object.keys(keep).map(function (id) { return keep[id]; });
}

function repliesToOwner(tweets, owner) {
  var me = norm(owner);
  if (!me) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < tweets.length; i++) {
    var tweet = tweets[i];
    var handle = norm(tweet.handle);
    var target = norm(tweet.replyToHandle);
    if (!tweet.id || seen[tweet.id] || !tweet.replyTo || !handle || handle === me || target !== me) continue;
    seen[tweet.id] = 1;
    out.push(tweet);
  }
  return out;
}

function parseNotificationsRest(json, owner) {
  var global = json.globalObjects || json.global_objects || {};
  var tweets = global.tweets || {};
  var users = global.users || {};
  var notes = global.notifications || {};
  var posts = [];
  function personOf(id) {
    var user = users[String(id || "")] || {};
    return {
      id: String(id || user.id_str || ""),
      handle: norm(user.screen_name || user.screenName || ""),
      name: String(user.name || ""),
      verified: !!(user.verified || user.is_blue_verified)
    };
  }
  Object.keys(notes).forEach(function (key) {
    var note = notes[key] || {};
    var icon = notificationIcon(note);
    if (!icon && note.icon) icon = notificationIcon({notification_icon: note.icon});
    if (icon !== "reply" && icon !== "mention" && icon !== "reply_to_you") return;
    var template = note.template || {};
    var agg = template.aggregateUserActionsV1 || template.aggregate_user_actions_v1 || template;
    var targets = agg.targetObjects || agg.target_objects || [];
    var fromUsers = agg.fromUsers || agg.from_users || [];
    var author = fromUsers[0] && (fromUsers[0].user || fromUsers[0]);
    var authorId = author && (author.id || author.id_str || author.rest_id);
    var person = personOf(authorId);
    targets.forEach(function (target) {
      var tweetRef = target && (target.tweet || target);
      var tid = tweetRef && (tweetRef.id || tweetRef.id_str || tweetRef.rest_id);
      var raw = tid && tweets[String(tid)];
      if (!raw) return;
      var legacy = raw.legacy || raw;
      var replyTo = String(legacy.in_reply_to_status_id_str || legacy.in_reply_to_status_id || "");
      var replyToHandle = norm(legacy.in_reply_to_screen_name || "");
      if (!replyTo || replyToHandle !== norm(owner)) return;
      var uid = String(raw.user_id_str || raw.user_id || person.id || "");
      var who = person.handle ? person : personOf(uid);
      posts.push({
        id: String(raw.id_str || raw.id || tid),
        uid: uid,
        handle: who.handle,
        name: who.name,
        verified: !!who.verified,
        replyTo: replyTo,
        replyToHandle: replyToHandle,
        conv: String(legacy.conversation_id_str || ""),
        ts: toIso(legacy.created_at || ""),
        text: textForStore(legacy.full_text || legacy.text || ""),
        src: "notifications"
      });
    });
  });
  return posts;
}

function stamp(tweets, src) {
  return tweets.map(function (tweet) {
    return {
      id: tweet.id, uid: tweet.uid, handle: tweet.handle, name: tweet.name, verified: !!tweet.verified,
      replyTo: tweet.replyTo, replyToHandle: tweet.replyToHandle, conv: tweet.conv, ts: tweet.ts,
      text: tweet.text, src: src
    };
  });
}

function timelineOwned(profile, owner, pagePath, url, body) {
  var handle = profile && norm(profile.handle);
  if (handle) return handle === owner;
  if (timelineKindFromPath(pagePath, owner)) return true;
  var requested = screenNameFromRequest(url, body);
  return !!requested && requested === owner;
}

function parseCapture(url, text, options) {
  options = options || {};
  var op = operationName(url);
  function finish(result) {
    result.op = op;
    return result;
  }
  var kind = classifyUrl(url);
  if (!kind) return finish({kind: "", skip: "不在采集名单", posts: [], users: []});
  var json;
  try { json = JSON.parse(text); } catch (err) {
    return finish({kind: kind, skip: "响应不是 JSON", posts: [], users: []});
  }
  if (!json || typeof json !== "object") return finish({kind: kind, skip: "响应不是 JSON", posts: [], users: []});
  if (kind === "counts") return finish({kind: kind, skip: "", posts: [], users: [], counts: readOwnerCounts(json)});
  var owner = norm(options.owner);
  var profile = readProfile(json);
  function attachCounts(result) {
    var counts = readOwnerCounts(json);
    if (counts && owner && counts.handle === owner) result.counts = counts;
    return finish(result);
  }
  var instructions = readInstructions(json, kind);
  var collected = collect(instructions);
  if (kind === "following" || kind === "followers" || kind === "blue-followers") {
    if (!owner) return finish({kind: kind, skip: "还不知道你的用户名", posts: [], users: [], profile: profile});
    var profileHandle = profile && norm(profile.handle);
    if (profileHandle && profileHandle !== owner) {
      return finish({kind: kind, skip: "不是你的关注或粉丝列表", posts: [], users: [], profile: profile});
    }
    if (!profileHandle && options.pageKind !== kind) {
      return finish({kind: kind, skip: "不是你的关注或粉丝列表", posts: [], users: [], profile: profile});
    }
    var users = collected.users.filter(function (user) { return norm(user.handle) !== owner; });
    return attachCounts({kind: kind, skip: "", posts: [], users: users, profile: profile});
  }
  if (kind === "replies" || kind === "originals") {
    if (!owner) return finish({kind: kind, skip: "还不知道你的用户名", posts: [], users: [], profile: profile});
    if (!timelineOwned(profile, owner, options.pagePath, url, options.body)) {
      return finish({kind: kind, skip: "不是你的主页时间线", posts: [], users: [], profile: profile});
    }
    return attachCounts({kind: kind, skip: "", posts: stamp(collected.tweets, kind), users: [], profile: profile});
  }
  if (!owner) return finish({kind: kind, skip: "还不知道你的用户名", posts: [], users: [], profile: profile});
  if (kind === "search") {
    var query = readRawQuery(url, options.body);
    if (query && !queryMentionsTo(query, owner)) {
      return finish({kind: kind, skip: "搜索不是 to:你的用户名", posts: [], users: [], profile: profile, query: query});
    }
    return finish({kind: kind, skip: "", posts: stamp(relatedTweets(collected.tweets, owner), "search"), users: [], profile: profile, query: query});
  }
  if (kind === "notifications") {
    var noted = (json.globalObjects || json.global_objects) ? parseNotificationsRest(json, owner) : stamp(repliesToOwner(collected.tweets, owner), "notifications");
    return finish({kind: kind, skip: "", posts: noted, users: [], profile: profile});
  }
  return finish({kind: kind, skip: "", posts: stamp(relatedTweets(collected.tweets, owner), "detail"), users: [], profile: profile});
}

function compactPost(post, now) {
  return {
    id: String(post.id || ""),
    uid: String(post.uid || ""),
    handle: norm(post.handle),
    name: String(post.name || "").slice(0, 40),
    verified: !!post.verified,
    replyTo: String(post.replyTo || ""),
    replyToHandle: norm(post.replyToHandle),
    conv: String(post.conv || ""),
    ts: String(post.ts || ""),
    text: String(post.text || "").slice(0, TEXT_LIMIT + 16),
    src: String(post.src || ""),
    seen: now
  };
}

function samePost(prev, next) {
  for (var i = 0; i < POST_FIELDS.length; i++) {
    var key = POST_FIELDS[i];
    if (key === "seen") continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

function prune(store, now) {
  ensureStore(store);
  var cutoff = (now || Date.now()) - RETENTION_MS;
  Object.keys(store.posts || {}).forEach(function (id) {
    var post = store.posts[id];
    var stamped = Date.parse(post.ts);
    var when = isNaN(stamped) ? (post.seen || 0) : stamped;
    if (when && when < cutoff) delete store.posts[id];
  });
  ["following", "followers"].forEach(function (bucket) {
    Object.keys(store[bucket] || {}).forEach(function (key) {
      if ((store[bucket][key].seen || 0) < cutoff) delete store[bucket][key];
    });
  });
  pruneSnapshots(store, now || Date.now());
  return store;
}

function applyCapture(store, captured, now) {
  if (!store || !captured || captured.skip || !captured.kind) return false;
  ensureStore(store);
  now = now || Date.now();
  var countsChanged = applyOwnerCounts(store, captured.counts);
  if (captured.kind === "counts") {
    if (maybeSnapshot(store, "followers", now)) countsChanged = true;
    if (maybeSnapshot(store, "following", now)) countsChanged = true;
    prune(store, now);
    return countsChanged;
  }
  var changed = countsChanged;
  (captured.posts || []).forEach(function (post) {
    if (!post.id) return;
    var next = compactPost(post, now);
    var prev = store.posts[post.id];
    if (!prev) {
      store.posts[post.id] = next;
      changed = true;
      return;
    }
    if ((prev.text || "").length > (next.text || "").length) next.text = prev.text;
    if (prev.src) next.src = prev.src;
    next.seen = now;
    if (!samePost(prev, next)) {
      store.posts[post.id] = next;
      changed = true;
    } else prev.seen = now;
  });
  var bucket = "";
  if (captured.kind === "following") bucket = "following";
  if (captured.kind === "followers" || captured.kind === "blue-followers") bucket = "followers";
  if (captured.kind === "notifications" && !store.meta.sawNotifications) { store.meta.sawNotifications = true; changed = true; }
  if (bucket) {
    if (captured.kind === "following" && !store.meta.sawFollowing) { store.meta.sawFollowing = true; changed = true; }
    if (captured.kind === "followers" && !store.meta.sawFollowers) { store.meta.sawFollowers = true; changed = true; }
    if (captured.kind === "blue-followers" && !store.meta.sawBlueFollowers) { store.meta.sawBlueFollowers = true; changed = true; }
    (captured.users || []).forEach(function (user) {
      var id = String(user.id || "");
      var handle = norm(user.handle);
      if (!id && !handle) return;
      var key = id ? "id:" + id : "h:" + handle;
      var existingKey = "";
      var carriedBlue = false;
      if (handle) {
        var keys = Object.keys(store[bucket]);
        for (var i = 0; i < keys.length; i++) {
          if (norm(store[bucket][keys[i]].handle) === handle) { existingKey = keys[i]; break; }
        }
      }
      if (existingKey && existingKey !== key) {
        var previous = store[bucket][existingKey];
        if (previous && previous.fromBlue) carriedBlue = true;
        if (id && existingKey.indexOf("id:") !== 0) {
          delete store[bucket][existingKey];
          if (!user.name) user.name = previous.name;
          if (!user.verified) user.verified = previous.verified;
          if (!user.followers) user.followers = previous.followers;
        } else {
          key = existingKey;
          if (!id) id = previous.id || "";
          if (!user.name) user.name = previous.name;
          if (!user.verified) user.verified = previous.verified;
          if (!user.followers) user.followers = previous.followers;
        }
      }
      var prev = store[bucket][key];
      var next = {
        id: id || (prev && prev.id) || "",
        handle: handle || (prev && prev.handle) || "",
        name: String((user.name || (prev && prev.name) || "")).slice(0, 40),
        verified: !!(user.verified || (prev && prev.verified)),
        followers: user.followers || (prev && prev.followers) || 0,
        seen: now
      };
      if (prev && prev.src === "export") next.src = "export";
      if (bucket === "followers" && (captured.kind === "blue-followers" || (prev && prev.fromBlue) || carriedBlue)) next.fromBlue = true;
      if (!prev || prev.handle !== next.handle || prev.name !== next.name || prev.verified !== next.verified || prev.followers !== next.followers || prev.id !== next.id || !!prev.fromBlue !== !!next.fromBlue) {
        store[bucket][key] = next;
        changed = true;
      } else prev.seen = now;
    });
  }
  prune(store, now);
  return changed;
}

function localDay(ts, tz) {
  var parsed = new Date(ts);
  if (isNaN(parsed.getTime())) return "";
  var zone = tz || "UTC";
  try {
    var parts = new Intl.DateTimeFormat("en-US", {timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(parsed);
    function pick(type) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
      return "";
    }
    var day = pick("year") + "-" + pick("month") + "-" + pick("day");
    if (day.indexOf("-") < 0 || day.length < 10) return "";
    return day;
  } catch (err) {
    if (zone !== "UTC") return localDay(ts, "UTC");
    return "";
  }
}

function coverageReport(store, owner, tz) {
  var me = norm(owner);
  var daysIn = {};
  var daysOut = {};
  var daysBySrc = {replies: {}, originals: {}, search: {}, detail: {}, notifications: {}, export: {}};
  var countIn = 0;
  var countOut = 0;
  var srcCount = {replies: 0, originals: 0, search: 0, detail: 0, notifications: 0, export: 0};
  Object.keys(store.posts || {}).forEach(function (id) {
    var post = store.posts[id];
    var day = localDay(post.ts, tz);
    var src = post.src || "";
    if (srcCount[src] != null) srcCount[src] += 1;
    if (day && daysBySrc[src]) daysBySrc[src][day] = 1;
    var handle = norm(post.handle);
    var target = norm(post.replyToHandle);
    if (!post.replyTo && !target) return;
    if (me && handle && handle !== me && target === me) {
      countIn += 1;
      if (day) daysIn[day] = 1;
    } else if (me && handle === me && target && target !== me) {
      countOut += 1;
      if (day) daysOut[day] = 1;
    }
  });
  var meta = store.meta || {};
  return {
    inbound: countIn,
    inboundDays: Object.keys(daysIn).length,
    outbound: countOut,
    outboundDays: Object.keys(daysOut).length,
    srcCount: srcCount,
    srcDays: {
      replies: Object.keys(daysBySrc.replies).length,
      originals: Object.keys(daysBySrc.originals).length,
      search: Object.keys(daysBySrc.search).length,
      detail: Object.keys(daysBySrc.detail).length,
      notifications: Object.keys(daysBySrc.notifications).length,
      export: Object.keys(daysBySrc.export).length
    },
    following: Object.keys(store.following || {}).length,
    followers: Object.keys(store.followers || {}).length,
    sawFollowing: !!meta.sawFollowing,
    sawFollowers: !!meta.sawFollowers,
    sawBlueFollowers: !!meta.sawBlueFollowers,
    sawNotifications: !!meta.sawNotifications,
    sawExport: !!meta.sawExport,
    blueFollowers: blueFollowerCount(store),
    totals: {
      followers: (store.totals && store.totals.followers) || 0,
      following: (store.totals && store.totals.following) || 0,
      blue: (store.totals && store.totals.blue) || 0
    }
  };
}

function blueFollowerCount(store) {
  var n = 0;
  Object.keys((store && store.followers) || {}).forEach(function (key) {
    if (store.followers[key] && store.followers[key].fromBlue) n += 1;
  });
  return n;
}

function countNum(value) {
  if (typeof value === "number" && isFinite(value)) return value > 0 ? Math.floor(value) : 0;
  var text = String(value == null ? "" : value).replace(/,/g, "").trim();
  if (!/^\d+$/.test(text)) return 0;
  var n = parseInt(text, 10);
  return n > 0 ? n : 0;
}

function readOwnerCounts(json) {
  var user = json && json.data && json.data.user && json.data.user.result;
  if (!user || typeof user !== "object") return null;
  var profile = readUser(user);
  if (!profile || !profile.handle) return null;
  var node = user;
  if (node.result && typeof node.result === "object" && !node.rest_id && !node.restId && !node.core && !node.legacy) node = node.result;
  var legacy = (node && node.legacy) || {};
  var rel = (node && (node.relationship_counts || node.relationshipCounts)) || {};
  var metrics = {};
  function takeMetrics(bag) {
    if (!bag || typeof bag !== "object") return;
    ["followers_count", "following_count", "friends_count", "verified_followers_count"].forEach(function (key) {
      if (metrics[key] == null && bag[key] != null) metrics[key] = bag[key];
    });
    if (bag.verifiedFollowersCount != null && metrics.verified_followers_count == null) metrics.verified_followers_count = bag.verifiedFollowersCount;
  }
  takeMetrics(node.public_metrics);
  takeMetrics(node.publicMetrics);
  takeMetrics(legacy.public_metrics);
  takeMetrics(legacy.publicMetrics);
  var followers = countNum(legacy.followers_count);
  if (!followers) followers = countNum(rel.followers != null ? rel.followers : rel.followers_count);
  if (!followers) followers = countNum(metrics.followers_count);
  if (!followers) followers = profile.followers || 0;
  var following = countNum(legacy.friends_count);
  if (!following) following = countNum(rel.following != null ? rel.following : (rel.friends != null ? rel.friends : rel.following_count));
  if (!following) following = countNum(metrics.following_count != null ? metrics.following_count : metrics.friends_count);
  var blue = countNum(metrics.verified_followers_count);
  if (!blue) blue = countNum(legacy.verified_followers_count);
  if (!blue) blue = countNum(node.verified_followers_count);
  if (!blue) blue = countNum(rel.verified_followers != null ? rel.verified_followers : rel.verified_followers_count);
  return {handle: profile.handle, followers: followers, following: following, blue: blue};
}

function applyOwnerCounts(store, counts) {
  if (!counts) return false;
  ensureStore(store);
  var me = norm(store.prefs && store.prefs.owner);
  if (!me || counts.handle !== me) return false;
  var changed = false;
  if (counts.followers > 0 && store.totals.followers !== counts.followers) {
    store.totals.followers = counts.followers;
    changed = true;
  }
  if (counts.following > 0 && store.totals.following !== counts.following) {
    store.totals.following = counts.following;
    changed = true;
  }
  if (counts.blue > 0 && store.totals.blue !== counts.blue) {
    store.totals.blue = counts.blue;
    changed = true;
  }
  return changed;
}

function ensureStore(store) {
  if (!store.totals) store.totals = {followers: 0, following: 0, blue: 0};
  if (store.totals.blue == null) store.totals.blue = 0;
  if (!store.snapshots) store.snapshots = [];
  if (!store.keepEntries) store.keepEntries = [];
  if (!store.keepIds) store.keepIds = {};
  if (!store.keepHandles) store.keepHandles = {};
  if (!store.extraRows) store.extraRows = [];
  if (!store.meta) store.meta = {};
  return store;
}

function listIsComplete(captured, expected) {
  captured = captured | 0;
  expected = expected | 0;
  if (expected <= 0) return false;
  if (expected <= 20) return captured === expected;
  return captured >= Math.ceil(expected * 0.95);
}

function exportTimeFromName(name, fallback) {
  var base = String(name || "").replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  var match = base.match(/(?:^|[^0-9])(\d{13}|\d{10})$/);
  var fb = fallback || 0;
  if (!match) return fb;
  var n = Number(match[1]);
  if (!isFinite(n)) return fb;
  if (match[1].length === 10) n *= 1000;
  var year = new Date(n).getUTCFullYear();
  if (!year || year < 2010 || year > 2040) return fb;
  return n;
}

function plainCount(text) {
  var raw = String(text || "");
  if (/[kKmM万亿]/.test(raw)) return 0;
  var digits = raw.replace(/,/g, "").match(/\d+/);
  if (!digits) return 0;
  var count = parseInt(digits[0], 10);
  return count > 0 ? count : 0;
}

function headerListCount(href, text, owner) {
  var match = String(href || "").match(/^\/([A-Za-z0-9_]{1,15})\/(followers|following|verified_followers)\/?$/);
  if (!match || norm(match[1]) !== norm(owner)) return null;
  if (match[2] === "verified_followers") return null;
  var count = plainCount(text);
  if (!count) return null;
  return {kind: match[2] === "following" ? "following" : "followers", count: count};
}

function headerVerifiedCount(href, text, owner) {
  var match = String(href || "").match(/^\/([A-Za-z0-9_]{1,15})\/verified_followers\/?$/);
  if (!match || norm(match[1]) !== norm(owner)) return 0;
  return plainCount(text);
}

// 已记 N / 共约 M。M 只用已经读到的公开人数；没有就写总数待核实。接近的口径和名单快照的完整线相同。
function progressText(captured, expected) {
  var n = countNum(captured);
  var total = countNum(expected);
  var text = "已记 " + n + " / " + (total > 0 ? "共约 " + total : "总数待核实");
  if (total > 0 && (n >= total || listIsComplete(n, total))) text += "，差不多了";
  return text;
}

function autoReadGapMs(unit) {
  var u = Number(unit);
  if (!isFinite(u) || u < 0) u = 0;
  if (u >= 1) return AUTO_READ_GAP_MAX_MS;
  return AUTO_READ_GAP_MIN_MS + Math.floor(u * (AUTO_READ_GAP_MAX_MS - AUTO_READ_GAP_MIN_MS + 1));
}

function autoReadPageKind(pathname, owner) {
  var kind = listKindFromPath(pathname, owner);
  if (kind === "following" || kind === "followers" || kind === "blue-followers") return kind;
  return "";
}

function autoReadCount(store, kind) {
  ensureStore(store);
  if (kind === "following") return Object.keys(store.following).length;
  if (kind === "blue-followers") return blueFollowerCount(store);
  if (kind === "followers") return Object.keys(store.followers).length;
  return 0;
}

function parseQuery(query) {
  var out = {};
  String(query || "").split("&").forEach(function (part) {
    if (!part) return;
    var eq = part.indexOf("=");
    var rawKey = eq >= 0 ? part.slice(0, eq) : part;
    var rawVal = eq >= 0 ? part.slice(eq + 1) : "";
    var key = "";
    var val = "";
    try { key = decodeURIComponent(rawKey.replace(/\+/g, " ")); } catch (err) { key = rawKey; }
    try { val = decodeURIComponent(rawVal.replace(/\+/g, " ")); } catch (err) { val = rawVal; }
    if (key) out[key] = val;
  });
  return out;
}

function encodeQuery(params) {
  return Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(params[key] == null ? "" : String(params[key]));
  }).join("&");
}

function listUrlParts(url) {
  var text = String(url || "");
  var hash = "";
  var hashAt = text.indexOf("#");
  if (hashAt >= 0) {
    hash = text.slice(hashAt);
    text = text.slice(0, hashAt);
  }
  var qAt = text.indexOf("?");
  return {path: qAt >= 0 ? text.slice(0, qAt) : text, query: qAt >= 0 ? text.slice(qAt + 1) : "", hash: hash};
}

// 只接受页面自己打过的 Following / Followers。接口编号留在捕获到的路径里，这里不写死。
function isOwnListApiUrl(url, op) {
  var parts = listUrlParts(url);
  var match = parts.path.match(/^https?:\/\/([^/]+)\/i\/api\/graphql\/[^/?#]+\/(Following|Followers|BlueVerifiedFollowers)$/i);
  if (!match) return false;
  var host = match[1].toLowerCase();
  var name = match[2];
  if (op && name !== op) return false;
  if (host !== "x.com" && host !== "twitter.com" && host !== "api.x.com" && host.slice(-6) !== ".x.com") return false;
  return name === "Following" || name === "Followers" || name === "BlueVerifiedFollowers";
}

function listTemplateFromRequest(url, method, body) {
  var op = operationName(url);
  if (!isOwnListApiUrl(url, op)) return null;
  return {
    op: op,
    url: String(url || ""),
    method: String(method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    body: typeof body === "string" ? body : ""
  };
}

// 用捕获到的那次请求改出下一页：count 设为 100，游标换成这次的。第一页去掉游标，从名单开头读。
// 不新增接口编号，也不写入令牌。令牌留在页面内存里，不进这个返回值。
function buildListPageRequest(template, cursor) {
  var tpl = listTemplateFromRequest(template && template.url, template && template.method, template && template.body);
  if (!tpl || tpl.op !== (template && template.op)) return null;
  var parts = listUrlParts(tpl.url);
  var params = parseQuery(parts.query);
  var variables = {};
  if (params.variables) {
    try { variables = JSON.parse(params.variables); } catch (err) { return null; }
  }
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) return null;
  variables.count = FAST_READ_PAGE_SIZE;
  if (cursor) variables.cursor = String(cursor);
  else delete variables.cursor;
  params.variables = JSON.stringify(variables);
  var nextBody = tpl.body || "";
  if (tpl.method === "POST" && nextBody) {
    try {
      var parsed = JSON.parse(nextBody);
      if (parsed && typeof parsed === "object" && parsed.variables && typeof parsed.variables === "object") {
        parsed.variables.count = FAST_READ_PAGE_SIZE;
        if (cursor) parsed.variables.cursor = String(cursor);
        else delete parsed.variables.cursor;
        nextBody = JSON.stringify(parsed);
      }
    } catch (err) {}
  }
  var nextUrl = parts.path + (Object.keys(params).length ? "?" + encodeQuery(params) : "") + parts.hash;
  if (!isOwnListApiUrl(nextUrl, tpl.op)) return null;
  return {url: nextUrl, method: tpl.method, body: tpl.method === "POST" ? nextBody : ""};
}

function bottomCursor(json) {
  var found = "";
  function walk(node, depth) {
    if (found || !node || depth > 16) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    var cursorType = String(node.cursorType || node.cursor_type || "");
    var entry = String(node.entryId || node.entry_id || "");
    var value = node.value;
    if (typeof value !== "string" || !value) value = "";
    var bottom = cursorType.toLowerCase() === "bottom" || entry.indexOf("cursor-bottom") >= 0;
    if (bottom && value) {
      found = value;
      return;
    }
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === "value" || keys[k] === "cursor") continue;
      walk(node[keys[k]], depth + 1);
    }
  }
  walk(json, 0);
  return found;
}

// 429、任何非 2xx、或 x-rate-limit-remaining 小于等于 2，都立刻停。不自动重试。
// 快速翻页：这一页没有新账号、游标没动、或空页，都立刻停。有新账号且游标前进才继续。
function fastPageStopReason(beforeCount, afterCount, prevCursor, nextCursor) {
  var added = (afterCount | 0) > (beforeCount | 0);
  var cursor = String(nextCursor || "");
  var prev = String(prevCursor || "");
  if (cursor && prev && cursor === prev) return "游标没有变化，已停止";
  if (!added && !cursor) return "这一页没有新账号，也没有下一页，已停止";
  if (!added) return "这一页没有新账号，已停止";
  return "";
}

function fastReadStopReason(status, remaining) {
  var code = Number(status);
  if (!isFinite(code)) code = 0;
  if (code === 429) return "遇到 429 限流，已停止，不会自动重试";
  if (code < 200 || code >= 300) return "请求返回 " + code + "，已停止，不会自动重试";
  if (remaining == null || remaining === "") return "";
  var left = Number(remaining);
  if (!isFinite(left)) return "";
  if (left <= FAST_READ_REMAINING_FLOOR) return "剩余额度接近 0（" + left + "），已停止，不会自动重试";
  return "";
}

function createFastReader() {
  var running = false;
  var pages = 0;
  var stopReason = "";
  return {
    running: function () { return running; },
    pages: function () { return pages; },
    stopReason: function () { return stopReason; },
    start: function () {
      if (running) return {ok: false, reason: "已经在读"};
      running = true;
      pages = 0;
      stopReason = "";
      return {ok: true};
    },
    stop: function (reason) {
      stopReason = reason || "已停止";
      running = false;
    },
    notePage: function () {
      if (!running) return {action: "stop", reason: stopReason || "已停止"};
      if (pages >= FAST_READ_MAX_PAGES) {
        stopReason = "已到单次 " + FAST_READ_MAX_PAGES + " 页上限，已停止";
        running = false;
        return {action: "stop", reason: stopReason};
      }
      pages += 1;
      return {action: "continue", pages: pages};
    }
  };
}

function autoReadBlockReason(text) {
  var raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 400) return "";
  if (/速率限制|超出速率|rate limit|too many requests/i.test(raw)) return "看到限流提示，已停止，不会自动重试";
  if (/something went wrong|出错了|请稍后再试|try again later|请尝试重新加载/i.test(raw)) return "看到页面报错，已停止，不会自动重试";
  return "";
}

// 内存里的开关。不写入油猴存储，所以刷新页面后一定是关闭。没勾选、没点开始时 tick 不会要求滚动。
function createAutoReader() {
  var phase = "off";
  var acked = false;
  var startedAt = 0;
  var startedKind = "";
  var screens = 0;
  var lastCount = 0;
  var lastVisible = "";
  var lastGainAt = 0;
  var flatScreens = 0;
  var dry = 0;
  var stopReason = "";
  function resetRun() {
    phase = "off";
    acked = false;
    startedAt = 0;
    startedKind = "";
    screens = 0;
    lastCount = 0;
    lastVisible = "";
    lastGainAt = 0;
    flatScreens = 0;
    dry = 0;
  }
  function finish(reason) {
    stopReason = reason;
    resetRun();
    return {action: "stop", reason: reason};
  }
  return {
    phase: function () { return phase; },
    screens: function () { return screens; },
    screensSinceGain: function () { return flatScreens; },
    stopReason: function () { return stopReason; },
    openConfirm: function () {
      if (phase === "running") return "running";
      phase = "confirm";
      acked = false;
      stopReason = "";
      return "confirm";
    },
    setAcknowledged: function (checked) { acked = !!checked; },
    start: function (now, pageKind, count) {
      if (phase === "running") return {ok: false, reason: "已经在读"};
      if (!acked) return {ok: false, reason: "需要先勾选确认"};
      if (!pageKind) return {ok: false, reason: "请先打开你自己的关注或粉丝页"};
      phase = "running";
      startedAt = now;
      startedKind = pageKind;
      lastCount = count | 0;
      lastVisible = "";
      lastGainAt = now;
      screens = 0;
      flatScreens = 0;
      dry = 0;
      stopReason = "";
      return {ok: true};
    },
    stop: function (reason) {
      stopReason = reason || "已停止";
      resetRun();
    },
    tick: function (now, info) {
      if (phase !== "running") return {action: "idle"};
      info = info || {};
      var count = info.count | 0;
      var visible = String(info.visibleKey || "");
      var expected = info.expected | 0;
      // 只有已记人数变多才算「新增」。屏幕上换人（含已经记过的）只说明页面还在动，不重置新增计时。
      if (count > lastCount) {
        lastCount = count;
        lastGainAt = now;
        flatScreens = 0;
      } else flatScreens += 1;
      if (visible && visible !== lastVisible) {
        lastVisible = visible;
        dry = 0;
      } else dry += 1;
      var moved = info.moved === true || (info.moved == null && info.stuck !== true);
      var atBottom = info.atBottom === true;
      if (!info.pageKind || info.pageKind !== startedKind) return finish("不在刚才那份自己的名单页了，已停止");
      if (info.blocked) return finish(info.blocked);
      if (now - startedAt >= AUTO_READ_MAX_MS) return finish("已到单次 " + (AUTO_READ_MAX_MS / 60000) + " 分钟上限，已停止");
      if (screens >= AUTO_READ_MAX_SCREENS) return finish("已到单次 " + AUTO_READ_MAX_SCREENS + " 屏上限，已停止");
      if (expected > 0 && (count >= expected || listIsComplete(count, expected))) return finish("已记人数接近总数，差不多了，已停止");
      if (flatScreens >= AUTO_READ_FLAT_SCREENS || now - lastGainAt >= AUTO_READ_FLAT_MS) return finish("已记数长时间没有增加，可能已读完或页面不再提供新名单");
      if (atBottom && dry >= AUTO_READ_DRY_LIMIT) return finish("已到列表底，没有继续加载，已停止");
      if (!moved && dry >= AUTO_READ_DRY_LIMIT) return finish("页面没有继续加载，已停止");
      screens += 1;
      return {action: "scroll", gapMs: autoReadGapMs(info.unit), screens: screens, sinceGain: flatScreens};
    }
  };
}

function compactPeople(list) {
  var out = [];
  var seenId = {};
  var seenHandle = {};
  (list || []).forEach(function (user) {
    if (!user) return;
    var id = String(user.id || "");
    if (id && !/^\d+$/.test(id)) id = "";
    var handle = norm(user.handle);
    if (!id && !handle) return;
    if (id && seenId[id]) return;
    if (!id && seenHandle[handle]) return;
    if (id) seenId[id] = 1;
    if (handle) seenHandle[handle] = 1;
    out.push({id: id, handle: handle, name: String(user.name || "").replace(/\s+/g, " ").trim().slice(0, 40)});
  });
  return out;
}

function peopleFromBucket(bucket) {
  return compactPeople(Object.keys(bucket || {}).map(function (key) { return bucket[key]; }));
}

function snapshotSignature(people) {
  return (people || []).map(function (person) { return person.id ? "id:" + person.id : "h:" + person.handle; }).sort().join("\n");
}

function latestComplete(store, kind) {
  var best = null;
  (store.snapshots || []).forEach(function (snap) {
    if (!snap || snap.kind !== kind || !snap.complete) return;
    if (!best || snap.at >= best.at) best = snap;
  });
  return best;
}

function recordSnapshot(store, kind, people, at, complete, source, name) {
  ensureStore(store);
  if (kind !== "followers" && kind !== "following") return false;
  people = compactPeople(people);
  if (!people.length) return false;
  at = at || Date.now();
  complete = !!complete;
  source = source === "export" ? "export" : "page";
  name = String(name || "").slice(0, 180);
  var signature = snapshotSignature(people);
  if (source === "export" && name) {
    for (var i = 0; i < store.snapshots.length; i++) {
      var named = store.snapshots[i];
      if (named.source !== "export" || named.kind !== kind || named.name !== name) continue;
      if (snapshotSignature(named.people) === signature && named.at === at && !!named.complete === complete) return false;
      store.snapshots[i] = {kind: kind, at: at, complete: complete, source: source, name: name, people: people};
      return true;
    }
  }
  if (complete) {
    var latest = latestComplete(store, kind);
    if (latest && snapshotSignature(latest.people) === signature) return false;
  }
  if (source === "page") {
    var day = new Date(at).toISOString().slice(0, 10);
    for (var j = 0; j < store.snapshots.length; j++) {
      var snap = store.snapshots[j];
      if (snap.kind !== kind || snap.source !== "page") continue;
      if (new Date(snap.at).toISOString().slice(0, 10) !== day) continue;
      if (people.length < (snap.people || []).length) return false;
      if (snapshotSignature(snap.people) === signature && !!snap.complete === complete) return false;
      store.snapshots[j] = {kind: kind, at: at, complete: complete, source: source, name: "", people: people};
      return true;
    }
  }
  store.snapshots.push({kind: kind, at: at, complete: complete, source: source, name: name, people: people});
  return true;
}

function maybeSnapshot(store, kind, at) {
  ensureStore(store);
  if (kind !== "followers" && kind !== "following") return false;
  var people = peopleFromBucket(store[kind]);
  var expected = kind === "followers" ? (store.totals.followers || 0) : (store.totals.following || 0);
  return recordSnapshot(store, kind, people, at || Date.now(), listIsComplete(people.length, expected), "page", "");
}

function pruneSnapshots(store, now) {
  ensureStore(store);
  var cutoff = (now || Date.now()) - RETENTION_MS;
  var snaps = store.snapshots;
  var force = [];
  var newestPartial = {};
  ["followers", "following"].forEach(function (kind) {
    var complete = [];
    var partial = [];
    snaps.forEach(function (snap) {
      if (!snap || snap.kind !== kind) return;
      if (snap.complete) complete.push(snap);
      else partial.push(snap);
    });
    complete.sort(function (a, b) { return a.at - b.at; });
    partial.sort(function (a, b) { return a.at - b.at; });
    complete.slice(-2).forEach(function (snap) { force.push(snap); });
    if (partial.length) newestPartial[kind] = partial[partial.length - 1];
  });
  store.snapshots = snaps.filter(function (snap) {
    if (force.indexOf(snap) >= 0) return true;
    if ((snap.at || 0) < cutoff) return false;
    if (!snap.complete) return newestPartial[snap.kind] === snap;
    return true;
  });
}

function completeSeries(store, kind) {
  return (store.snapshots || []).filter(function (snap) {
    return snap && snap.kind === kind && snap.complete && snap.people && snap.people.length;
  }).sort(function (a, b) { return a.at - b.at; });
}

function snapshotDiffInput(store) {
  ensureStore(store);
  var followers = completeSeries(store, "followers");
  var following = completeSeries(store, "following");
  if (!followers.length && !following.length) return null;
  if (followers.length < 2 && following.length < 2) {
    return {
      sawFollowers: false, sawFollowing: false, sawPrevFollowers: false, sawPrevFollowing: false,
      followerAccounts: [], followingAccounts: [], prevFollowerAccounts: [], prevFollowingAccounts: [],
      followAuto: {waiting: true, note: SNAPSHOT_WAITING}
    };
  }
  function pair(list) {
    if (list.length < 2) return {prev: [], cur: [], ready: false};
    return {prev: list[list.length - 2].people, cur: list[list.length - 1].people, ready: true};
  }
  var fer = pair(followers);
  var fol = pair(following);
  return {
    sawFollowers: fer.ready,
    sawPrevFollowers: fer.ready,
    sawFollowing: fol.ready,
    sawPrevFollowing: fol.ready,
    followerAccounts: fer.cur,
    prevFollowerAccounts: fer.prev,
    followingAccounts: fol.cur,
    prevFollowingAccounts: fol.prev,
    followAuto: (fer.ready && fol.ready) ? null : {note: SNAPSHOT_WAITING}
  };
}

function rebuildKeepMaps(store) {
  store.keepIds = {};
  store.keepHandles = {};
  (store.keepEntries || []).forEach(function (entry) {
    if (entry.id && /^\d+$/.test(entry.id)) store.keepIds[entry.id] = 1;
    var handle = norm(entry.handle);
    if (handle) store.keepHandles[handle] = 1;
  });
}

function addKeep(store, person) {
  ensureStore(store);
  var id = "";
  var handle = "";
  if (typeof person === "string" || typeof person === "number") {
    var text = String(person || "").trim().replace(/^@/, "");
    if (/^\d+$/.test(text)) id = text;
    else handle = norm(text);
  } else if (person && typeof person === "object") {
    id = String(person.id || "");
    if (!/^\d+$/.test(id)) id = "";
    handle = norm(person.handle || person.account);
  }
  if (!id && !handle) return false;
  var entries = store.keepEntries;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!((id && entry.id === id) || (handle && entry.handle === handle))) continue;
    if (id) entry.id = id;
    if (handle) entry.handle = handle;
    rebuildKeepMaps(store);
    return true;
  }
  entries.push({id: id, handle: handle});
  rebuildKeepMaps(store);
  return true;
}

function removeKeep(store, person) {
  ensureStore(store);
  var id = "";
  var handle = "";
  if (typeof person === "string" || typeof person === "number") {
    var text = String(person || "").trim().replace(/^@/, "");
    if (/^\d+$/.test(text)) id = text;
    else handle = norm(text);
  } else if (person && typeof person === "object") {
    id = String(person.id || "");
    if (!/^\d+$/.test(id)) id = "";
    handle = norm(person.handle || person.account);
  }
  var before = store.keepEntries.length;
  store.keepEntries = store.keepEntries.filter(function (entry) {
    if (id && entry.id === id) return false;
    if (handle && entry.handle === handle) return false;
    return true;
  });
  rebuildKeepMaps(store);
  return store.keepEntries.length !== before;
}

function looksLikeBackup(text) {
  try {
    var obj = JSON.parse(text);
    return !!(obj && obj.v === 1 && obj.posts && obj.prefs);
  } catch (err) {
    return false;
  }
}

function rowToExportPost(row, owner) {
  var tid = String(row.tweet_id || "").trim();
  var dir = String(row.direction || "");
  var account = norm(row.account);
  if (!tid || (dir !== "in" && dir !== "out")) return null;
  var handle = dir === "out" ? owner : account;
  var replyToHandle = dir === "out" ? account : owner;
  if (!handle || !replyToHandle || handle === replyToHandle) return null;
  return {
    id: tid,
    uid: "",
    handle: handle,
    name: "",
    verified: false,
    replyTo: String(row.in_reply_to_status_id || ""),
    replyToHandle: replyToHandle,
    conv: String(row.conversation_id || ""),
    ts: String(row.ts || row.created_at || ""),
    text: String(row.text || ""),
    src: "export"
  };
}

function compactExtra(row) {
  var next = {
    id: String(row.id || ""),
    tweet_id: String(row.tweet_id || ""),
    ts: String(row.ts || row.created_at || ""),
    account: norm(row.account),
    direction: String(row.direction || ""),
    type: String(row.type || ""),
    text: String(row.text || "").slice(0, TEXT_LIMIT + 16),
    in_reply_to_status_id: String(row.in_reply_to_status_id || ""),
    conversation_id: String(row.conversation_id || ""),
    parent_kind: String(row.parent_kind || ""),
    post_id: String(row.post_id || ""),
    post_created_at: String(row.post_created_at || ""),
    first_observed_at: String(row.first_observed_at || ""),
    observed_baseline: String(row.observed_baseline || "")
  };
  if (!next.id && next.tweet_id) next.id = "tw:" + next.tweet_id;
  return next;
}

function markNewExportUsers(bucket, before) {
  Object.keys(bucket).forEach(function (key) {
    if (!before[key]) bucket[key].src = "export";
  });
}

function applyImported(store, data, owner, now) {
  if (!store || !data) return false;
  now = now || Date.now();
  var me = norm(owner || data.owner || (store.prefs && store.prefs.owner));
  Object.keys(store.posts || {}).forEach(function (id) {
    if (store.posts[id].src === "export") delete store.posts[id];
  });
  ["following", "followers"].forEach(function (bucket) {
    Object.keys(store[bucket] || {}).forEach(function (key) {
      if (store[bucket][key].src === "export") delete store[bucket][key];
    });
  });
  ensureStore(store);
  store.extraRows = [];
  var posts = [];
  var seenExtra = {};
  (data.rows || []).forEach(function (row) {
    if (!row) return;
    if (row.type === "like" || !row.tweet_id || (row.direction !== "in" && row.direction !== "out")) {
      var extra = compactExtra(row);
      if (extra.id && seenExtra[extra.id]) return;
      if (extra.id) seenExtra[extra.id] = 1;
      store.extraRows.push(extra);
      return;
    }
    var post = rowToExportPost(row, me);
    if (post) posts.push(post);
  });
  applyCapture(store, {kind: "export", skip: "", posts: posts, users: []}, now);
  function takeUsers(bucket, accounts, flag) {
    var before = {};
    Object.keys(store[bucket]).forEach(function (key) { before[key] = 1; });
    applyCapture(store, {kind: flag === "sawFollowing" ? "following" : "followers", skip: "", posts: [], users: accounts || []}, now);
    markNewExportUsers(store[bucket], before);
  }
  if (data.sawFollowing) takeUsers("following", data.followingAccounts, "sawFollowing");
  if (data.sawFollowers) takeUsers("followers", data.followerAccounts, "sawFollowers");
  Object.keys(data.keepIds || {}).forEach(function (id) { addKeep(store, {id: id, handle: ""}); });
  Object.keys(data.keepHandles || {}).forEach(function (handle) { addKeep(store, {id: "", handle: handle}); });
  store.meta.sawExport = true;
  if (!store.prefs.owner && data.owner) store.prefs.owner = norm(data.owner);
  prune(store, now);
  return true;
}

function toEngineData(store, owner, repliesFromTweets) {
  var records = [];
  var profiles = {};
  Object.keys(store.posts || {}).sort().forEach(function (id) {
    var post = store.posts[id];
    records.push({
      id: post.id,
      screen_name: post.handle,
      user_id: post.uid,
      name: post.name,
      is_blue_verified: post.verified ? "true" : "",
      in_reply_to: post.replyTo || "",
      in_reply_to_screen_name: post.replyToHandle || "",
      created_at: post.ts,
      full_text: post.text || "",
      conversation_id: post.conv || ""
    });
    var handle = norm(post.handle);
    if (handle && post.verified && !profiles[handle]) profiles[handle] = {handle: handle, verified: "true", is_blue_verified: "true"};
  });
  function usersOf(bucket) {
    var map = {};
    var list = [];
    Object.keys(bucket || {}).sort().forEach(function (key) {
      var user = bucket[key];
      var handle = norm(user.handle);
      list.push({id: user.id || "", handle: handle, name: user.name || ""});
      if (!handle || map[handle]) return;
      map[handle] = {
        handle: handle,
        verified: user.verified ? "true" : "",
        is_blue_verified: user.verified ? "true" : "",
        followers_count: user.followers || ""
      };
    });
    return {map: map, list: list};
  }
  var following = usersOf(store.following);
  var followers = usersOf(store.followers);
  var meta = store.meta || {};
  var data = {
    rows: [],
    following: following.map,
    followers: followers.map,
    profiles: profiles,
    followingAccounts: following.list,
    followerAccounts: followers.list,
    sawFollowing: !!meta.sawFollowing,
    sawFollowers: !!(meta.sawFollowers || meta.sawBlueFollowers),
    sawPrevFollowers: false,
    sawPrevFollowing: false,
    keepIds: store.keepIds || {},
    keepHandles: store.keepHandles || {},
    warnings: []
  };
  var rows = typeof repliesFromTweets === "function" ? repliesFromTweets(records, owner || "") : [];
  var seenRow = {};
  rows.forEach(function (row) { if (row && row.id) seenRow[row.id] = 1; });
  (store.extraRows || []).forEach(function (row) {
    if (!row || !norm(row.account)) return;
    var id = row.id || (row.tweet_id ? "tw:" + row.tweet_id : "");
    if (id && seenRow[id]) return;
    if (id) seenRow[id] = 1;
    var copy = {};
    Object.keys(row).forEach(function (key) { copy[key] = row[key]; });
    if (id) copy.id = id;
    rows.push(copy);
  });
  data.rows = rows;
  return data;
}

function secretKey(key) {
  return /cookie|auth_token|authorization|guest_id|^ct0$|^twid$|^kdt$/i.test(String(key || ""));
}

function assertNoSecrets(obj) {
  var dumped = JSON.stringify(obj);
  if (/auth_token|ct0\s*[:=]/.test(dumped)) throw new Error("备份里有不该出现的内容，已拒绝");
  JSON.stringify(obj, function (key, value) {
    if (secretKey(key)) throw new Error("备份里有不该出现的字段，已拒绝");
    return value;
  });
}

function normalizeStore(input) {
  var store = emptyStore();
  if (!input || typeof input !== "object") return store;
  var prefs = input.prefs || {};
  store.prefs.masked = !!prefs.masked;
  store.prefs.tz = String(prefs.tz || "");
  store.prefs.mode = prefs.mode === "7" || prefs.mode === "all" ? prefs.mode : "30";
  store.prefs.owner = norm(prefs.owner);
  var meta = input.meta || {};
  store.meta.sawFollowing = !!meta.sawFollowing;
  store.meta.sawFollowers = !!meta.sawFollowers;
  store.meta.sawBlueFollowers = !!meta.sawBlueFollowers;
  store.meta.sawNotifications = !!meta.sawNotifications;
  store.meta.sawExport = !!meta.sawExport;
  store.totals.followers = countNum(input.totals && input.totals.followers);
  store.totals.following = countNum(input.totals && input.totals.following);
  store.totals.blue = countNum(input.totals && input.totals.blue);
  Object.keys(input.posts || {}).forEach(function (id) {
    var post = input.posts[id];
    if (!post || typeof post !== "object") return;
    var next = compactPost(post, post.seen || 0);
    if (!next.id) return;
    store.posts[next.id] = next;
  });
  ["following", "followers"].forEach(function (bucket) {
    Object.keys(input[bucket] || {}).forEach(function (key) {
      var user = input[bucket][key];
      if (!user || typeof user !== "object") return;
      var id = String(user.id || "");
      var handle = norm(user.handle);
      if (!id && !handle) return;
      var storedKey = id ? "id:" + id : "h:" + handle;
      var followers = parseInt(user.followers || 0, 10);
      store[bucket][storedKey] = {
        id: id,
        handle: handle,
        name: String(user.name || "").slice(0, 40),
        verified: !!user.verified,
        followers: isNaN(followers) ? 0 : followers,
        seen: user.seen || 0
      };
      if (user.src === "export") store[bucket][storedKey].src = "export";
      if (bucket === "followers" && user.fromBlue) store[bucket][storedKey].fromBlue = true;
    });
  });
  var kept = [];
  function rememberKeep(entry) {
    var id = String(entry.id || "");
    if (id && !/^\d+$/.test(id)) id = "";
    var handle = norm(entry.handle);
    if (!id && !handle) return;
    for (var i = 0; i < kept.length; i++) {
      if ((id && kept[i].id === id) || (handle && kept[i].handle === handle)) {
        if (id) kept[i].id = id;
        if (handle) kept[i].handle = handle;
        return;
      }
    }
    kept.push({id: id, handle: handle});
  }
  (input.keepEntries || []).forEach(function (entry) { if (entry) rememberKeep(entry); });
  Object.keys(input.keepIds || {}).forEach(function (id) { rememberKeep({id: id, handle: ""}); });
  Object.keys(input.keepHandles || {}).forEach(function (handle) { rememberKeep({id: "", handle: handle}); });
  store.keepEntries = kept;
  rebuildKeepMaps(store);
  var seenExtra = {};
  (input.extraRows || []).forEach(function (row) {
    if (!row || typeof row !== "object") return;
    var extra = compactExtra(row);
    if (!extra.account && !extra.tweet_id && !extra.id) return;
    if (extra.id && seenExtra[extra.id]) return;
    if (extra.id) seenExtra[extra.id] = 1;
    store.extraRows.push(extra);
  });
  (input.snapshots || []).forEach(function (snap) {
    if (!snap || (snap.kind !== "followers" && snap.kind !== "following")) return;
    var people = compactPeople(snap.people);
    if (!people.length) return;
    var at = Number(snap.at);
    if (!isFinite(at) || at < 0) at = 0;
    store.snapshots.push({
      kind: snap.kind,
      at: at,
      complete: !!snap.complete,
      source: snap.source === "export" ? "export" : "page",
      name: String(snap.name || "").slice(0, 180),
      people: people
    });
  });
  return store;
}

function exportBackup(store, now) {
  var copy = normalizeStore(store);
  copy.exportedAt = new Date(now || Date.now()).toISOString();
  copy.note = "fan-audit 油猴版备份。只有打分需要的短字段，没有原始响应，也没有 cookie。";
  return JSON.stringify(copy);
}

function importBackup(text) {
  if (String(text || "").length > 4000000) throw new Error("备份太大，不像精简数据");
  var obj = JSON.parse(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("备份不是 JSON 对象");
  if (obj.v !== 1) throw new Error("不认识这份备份的版本");
  assertNoSecrets(obj);
  if (obj.data && (obj.data.user || obj.data.search_by_raw_query)) throw new Error("这像是原始响应，不是备份");
  return normalizeStore(obj);
}

function contextProblems(info) {
  info = info || {};
  var out = [];
  if (!info.page) {
    out.push({level: "error", text: "没有拿到页面 window（unsafeWindow 不可用）。脚本多半跑在沙箱里，读不到 X 自己发出的请求。请确认已打开「允许用户脚本」，并且本脚本有 unsafeWindow 权限。"});
    return out;
  }
  if (typeof info.page.XMLHttpRequest !== "function") {
    out.push({level: "error", text: "页面上没有 XMLHttpRequest，钩子没法挂。内容安全策略（CSP）或沙箱可能把脚本和页面隔开了。"});
  } else {
    var onPage = info.pageHookMarked || !!info.page.__fanAuditPageHook;
    var openMatches = !!(info.hookedOpen && info.page.XMLHttpRequest.prototype.open === info.hookedOpen);
    if (!onPage && !openMatches) {
      out.push({level: "error", text: "XHR 钩子没有留在页面自己的 XMLHttpRequest 上。CSP 或沙箱可能挡住了注入，这样什么都记不到。"});
    }
  }
  if (!info.sawPageApp) {
    out.push({level: "warn", text: "没有检测到 X 页面环境（window 上没有 webpackChunk_twitter_responsive_web）。这是从 twitter-web-exporter 借来的自检：脚本必须跑在页面环境里，而不是扩展沙箱里。若 CSP 拦住注入，这里会一直是空的。如果下面已经开始计数，说明请求还是接住了，这条可能是 X 改了内部变量名（待核实）。"});
  }
  return out;
}

// 只替换页面上的 open / send / fetch，好在 load 和响应体里读页面自己的结果。
// 不读 cookie。Following / Followers 上页面自己设置的请求头只留在这个函数的内存里，
// 等用户点了快速读取才用来再发同类请求。不写入备份，不放进诊断，也不通过事件交出去。
// 这个函数不能引用外层变量：跨沙箱时会把它的源码注进页面再执行。
function attachHooks(page, emit) {
  if (!page || typeof page.XMLHttpRequest !== "function") {
    throw new Error("页面上没有 XMLHttpRequest");
  }
  if (page.__fanAuditHooks) return page.__fanAuditHooks;
  var origOpen = page.XMLHttpRequest.prototype.open;
  var origSend = page.XMLHttpRequest.prototype.send;
  var origSetHeader = page.XMLHttpRequest.prototype.setRequestHeader;
  var origFetch = page.fetch;
  var listPending = {};
  var listTemplates = {};
  var listSeq = 0;
  function keepHeaderName(name) {
    var key = String(name || "").toLowerCase();
    return !!key && key !== "cookie" && key !== "cookie2" && key !== "set-cookie";
  }
  function copyHeaders(source) {
    var out = {};
    if (!source) return out;
    try {
      if (typeof source.forEach === "function") {
        source.forEach(function (value, key) {
          if (keepHeaderName(key)) out[String(key)] = String(value == null ? "" : value);
        });
        return out;
      }
    } catch (err) {}
    if (Array.isArray(source)) {
      source.forEach(function (pair) {
        if (!pair || pair.length < 2 || !keepHeaderName(pair[0])) return;
        out[String(pair[0])] = String(pair[1] == null ? "" : pair[1]);
      });
      return out;
    }
    if (typeof source === "object") {
      Object.keys(source).forEach(function (key) {
        if (!keepHeaderName(key)) return;
        out[key] = String(source[key] == null ? "" : source[key]);
      });
    }
    return out;
  }
  function listOp(url) {
    var op = "";
    var match = String(url || "").match(/\/graphql\/[^/?#]+\/(Following|Followers|BlueVerifiedFollowers)(?:\?|#|$)/);
    if (match) op = match[1];
    return op === "Following" || op === "Followers" || op === "BlueVerifiedFollowers" ? op : "";
  }
  function rememberList(url, method, headers, body) {
    var op = listOp(url);
    if (!op) return "";
    listSeq += 1;
    var id = String(listSeq);
    listPending[id] = {op: op, url: String(url || ""), method: String(method || "GET").toUpperCase() === "POST" ? "POST" : "GET", headers: copyHeaders(headers), body: typeof body === "string" ? body : ""};
    return id;
  }
  function headerValue(headers, name) {
    if (!headers) return "";
    var want = String(name || "").toLowerCase();
    if (typeof headers.get === "function") {
      try { return String(headers.get(name) || headers.get(want) || ""); } catch (err) { return ""; }
    }
    return "";
  }
  var interesting = /\/(UserRepliesTimeline|UserTweetsAndReplies|UserOriginalsTimeline|UserTweets|SearchTimeline|BlueVerifiedFollowers|Followers|Following|TweetDetail|ModeratedTimeline|NotificationsTimeline|NotificationsMentionsTimeline|UserByScreenName|UserByRestId)(?:\?|#|$)/;
  function isNotificationsRest(url) {
    return /\/i\/api\/2\/notifications\/(?:all|mentions|verified)\.json(?:\?|#|$)/.test(String(url || ""));
  }
  function wantsBody(url) {
    var text = String(url || "");
    if (isNotificationsRest(text) || interesting.test(text)) return true;
    return /\/graphql\/[^/?#]+\/[A-Za-z0-9_]*Notification[A-Za-z0-9_]*/.test(text);
  }
  function shouldWatch(url) {
    return isGraphql(url) || isNotificationsRest(url);
  }
  function requestUrl(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string" && input.url) return input.url;
      if (input && typeof input.href === "string") return input.href;
    } catch (err) {}
    return "";
  }
  function isGraphql(url) {
    return String(url || "").indexOf("/graphql/") >= 0;
  }
  function readXhrBody(xhr) {
    try {
      if (typeof xhr.responseText === "string" && xhr.responseText) return xhr.responseText;
    } catch (err) {}
    try {
      if (typeof xhr.response === "string" && xhr.response) return xhr.response;
    } catch (err) {}
    try {
      var response = xhr.response;
      if (response && typeof response === "object" && typeof response.byteLength !== "number") {
        var text = JSON.stringify(response);
        if (text && text.charAt(0) === "{") return text;
      }
    } catch (err) {}
    return "";
  }
  function hookedOpen(method, url) {
    var xhr = this;
    try { xhr.__fanUrl = url; xhr.__fanMethod = method; } catch (err) {}
    if (shouldWatch(url)) {
      xhr.addEventListener("load", function () {
        try {
          if (xhr.status && xhr.status >= 400) return;
          var current = String(xhr.__fanUrl || "");
          var text = wantsBody(current) ? readXhrBody(xhr) : "";
          emit(current, text, xhr.__fanBody || "", xhr.__fanListId || "");
        } catch (err) {}
      });
    }
    return origOpen.apply(xhr, arguments);
  }
  function hookedSetHeader(name, value) {
    try {
      if (keepHeaderName(name)) {
        if (!this.__fanHeaders) this.__fanHeaders = {};
        this.__fanHeaders[String(name)] = String(value == null ? "" : value);
      }
    } catch (err) {}
    if (typeof origSetHeader !== "function") return undefined;
    return origSetHeader.apply(this, arguments);
  }
  function hookedSend(body) {
    var xhr = this;
    try { xhr.__fanBody = typeof body === "string" ? body : ""; } catch (err) {}
    try { xhr.__fanListId = rememberList(xhr.__fanUrl, xhr.__fanMethod, xhr.__fanHeaders, xhr.__fanBody || ""); } catch (err) {}
    return origSend.apply(xhr, arguments);
  }
  function hookedFetch(input) {
    var url = requestUrl(input);
    var init = arguments[1];
    var body = "";
    try { if (init && typeof init.body === "string") body = init.body; } catch (err) {}
    var headers = {};
    try { headers = copyHeaders(init && init.headers); } catch (err) {}
    try {
      if (input && input.headers) {
        var fromRequest = copyHeaders(input.headers);
        Object.keys(fromRequest).forEach(function (key) { if (!headers[key]) headers[key] = fromRequest[key]; });
      }
    } catch (err) {}
    var listId = "";
    try { listId = rememberList(url, init && init.method, headers, body); } catch (err) {}
    var ret = origFetch.apply(this, arguments);
    if (!ret || typeof ret.then !== "function" || !shouldWatch(url)) return ret;
    return ret.then(function (res) {
      try {
        if (!res || res.ok === false) return res;
        if (!wantsBody(url)) {
          emit(String(url), "", body, listId);
          return res;
        }
        var clone = res && res.clone ? res.clone() : null;
        if (clone && clone.text) {
          clone.text().then(function (text) {
            try { emit(String(url), text, body, listId); } catch (err) {}
          }, function () {});
        }
      } catch (err) {}
      return res;
    });
  }
  function allowedReplay(url, op) {
    return listOp(url) === op && (op === "Following" || op === "Followers" || op === "BlueVerifiedFollowers");
  }
  function readListPage(op, url, method, body) {
    var tpl = listTemplates[op];
    if (!tpl || !allowedReplay(url, op)) return Promise.resolve({status: 0, text: "", remaining: ""});
    if (typeof origFetch !== "function") return Promise.resolve({status: 0, text: "", remaining: ""});
    var init = {method: method === "POST" ? "POST" : "GET", headers: tpl.headers || {}, credentials: "same-origin", cache: "no-store"};
    if (init.method === "POST") init.body = typeof body === "string" ? body : "";
    return origFetch.call(page, url, init).then(function (res) {
      var status = res && res.status ? res.status : 0;
      var remaining = headerValue(res && res.headers, "x-rate-limit-remaining");
      if (!res || typeof res.text !== "function") return {status: status, text: "", remaining: remaining};
      return res.text().then(function (text) {
        return {status: status, text: String(text || ""), remaining: remaining};
      }, function () {
        return {status: status || 0, text: "", remaining: remaining};
      });
    }, function () {
      return {status: 0, text: "", remaining: ""};
    });
  }
  page.__fanAuditKeepListTemplate = function (id) {
    var item = listPending[String(id || "")];
    if (!item) return false;
    listTemplates[item.op] = item;
    delete listPending[String(id || "")];
    return true;
  };
  page.__fanAuditDropListTemplate = function (id) {
    delete listPending[String(id || "")];
  };
  page.__fanAuditHasListTemplate = function (op) {
    return !!(listTemplates[op] && listTemplates[op].url);
  };
  page.__fanAuditListTemplate = function (op) {
    var item = listTemplates[op];
    if (!item) return null;
    return {op: item.op, url: item.url, method: item.method, body: item.body || ""};
  };
  page.__fanAuditFetchList = readListPage;
  page.XMLHttpRequest.prototype.open = hookedOpen;
  page.XMLHttpRequest.prototype.send = hookedSend;
  if (typeof origSetHeader === "function") page.XMLHttpRequest.prototype.setRequestHeader = hookedSetHeader;
  if (typeof origFetch === "function") page.fetch = hookedFetch;
  var hooks = {hookedOpen: hookedOpen, origOpen: origOpen, origFetch: origFetch};
  try { page.__fanAuditHooks = hooks; } catch (err) {}
  try { page.__fanAuditPageHook = 1; } catch (err) {}
  try {
    if (page.document && page.document.documentElement) page.document.documentElement.setAttribute("data-fan-audit-hook", "page");
  } catch (err) {}
  return hooks;
}

function installHooks(page, onResponse) {
  return attachHooks(page, onResponse);
}

function pageHookProgram() {
  return "try{(" + attachHooks.toString() + ")(window,function(url,text,body,listId){try{document.dispatchEvent(new CustomEvent(\"fan-audit-capture\",{detail:{url:String(url||\"\"),text:String(text||\"\"),body:typeof body===\"string\"?body:\"\",listId:String(listId||\"\")}}));}catch(err){}});}catch(err){}\n";
}

var BOARD_CSS = [
  "body{font-family:-apple-system,'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif;background:#F7F8FA;color:#1F2937;margin:0;padding:28px}",
  "h1{font-size:28px;margin:0 0 4px} h2{font-size:18px;margin:0 0 12px}",
  ".privacy{background:#ECFDF5;border:1px solid #6EE7B7;border-radius:12px;padding:12px 16px;font-size:16px;font-weight:650;margin:14px 0}",
  ".sub{color:#6B7280;font-size:14px;margin:0 0 12px}",
  ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin:14px 0}",
  ".card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:16px 18px}",
  "button.card,a.card{padding:16px 18px;text-align:left;width:100%;cursor:pointer;box-sizing:border-box;font:inherit;color:#1F2937}",
  "a.card{display:block;color:inherit;text-decoration:none}",
  "button.tier-card.empty,button.tier-card.empty .num,button.tier-card.empty .lab{background:#F3F4F6;color:#9CA3AF}",
  ".stat-cards{border-top:1px dashed #D1D5DB;padding-top:8px}",
  ".tag{display:inline-block;margin-top:6px;font-size:11px;color:#1D4ED8;background:#EFF6FF;border-radius:999px;padding:1px 8px}",
  ".block-head{display:flex;justify-content:space-between;align-items:center;gap:12px}",
  ".back-top{font-size:13px;color:#2563EB;text-decoration:none;white-space:nowrap}",
  ".tier-block{margin-bottom:16px;scroll-margin-top:12px}",
  "h2.flash{background:#FDE68A;border-radius:6px}",
  "button.bar{width:100%;background:transparent;border:0;padding:0;cursor:pointer;text-align:left;font:inherit}",
  ".num{font-size:32px;font-weight:700;color:#1F2937}.lab{color:#6B7280;font-size:13px;margin-top:4px}",
  ".panels{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:16px}",
  ".bar{display:flex;align-items:center;margin:6px 0;font-size:14px}",
  ".bar .k{width:210px}.bar .b{height:14px;border-radius:4px;background:#3B82F6;margin-right:8px}",
  ".bar .b.gray{background:#CBD5E1}.bar .b.gold{background:#F59E0B}.bar .b.silver{background:#94A3B8}",
  ".bar .b.green{background:#10B981}.bar .b.red{background:#F43F5E}",
  "table{border-collapse:collapse;width:100%;font-size:13px}",
  "th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #EEF0F3;vertical-align:top}",
  "th{color:#6B7280;font-weight:600}",
  ".warn{background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;padding:10px 14px;font-size:13px;margin:12px 0}",
  ".muted{color:#6B7280;font-size:12px}",
  "footer{color:#6B7280;font-size:13px;text-align:center;margin-top:18px}",
  "a{color:#2563EB}"
].join("\n");

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch];
  });
}

function standaloneHtml(fragment, note) {
  return "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>fan-audit 看板</title><style>"
    + BOARD_CSS + "</style></head><body><h1 id=\"top\">粉丝体检 · 互动关系星级</h1>"
    + "<p class=\"privacy\">这是本机生成的快照，打开时不会联网，也不会上传。</p>"
    + (note ? "<p class=\"sub\">" + escapeHtml(note) + "</p>" : "")
    + (fragment || "")
    + "<footer>fan-audit（油猴版）· 快照只供自己查看。工具不会代你点赞、关注、取关或发帖。</footer></body></html>";
}
var STORE_KEY = "fan-audit-v1";

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function pageWindow() {
  try {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow;
  } catch (err) {}
  return null;
}

function inFrame(page) {
  try { return !!(page && page.top && page.top !== page); } catch (err) { return true; }
}

function detectOwner(page) {
  var doc = document;
  try { if (page && page.document) doc = page.document; } catch (err) {}
  try {
    var link = doc.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (!link) return "";
    var href = link.getAttribute("href") || "";
    var match = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return match ? norm(match[1]) : "";
  } catch (err) {
    return "";
  }
}

function loadStore() {
  try {
    if (typeof GM_getValue !== "function") return emptyStore();
    var raw = GM_getValue(STORE_KEY, null);
    if (!raw) return emptyStore();
    if (typeof raw === "string") raw = JSON.parse(raw);
    return prune(normalizeStore(raw), Date.now());
  } catch (err) {
    return emptyStore();
  }
}

function boot() {
  var page = pageWindow();
  if (inFrame(page || window)) return;
  var store = loadStore();
  var hooks = null;
  var hookError = "";
  var panelOpen = false;
  var openTiers = {};
  var saveTimer = 0;
  var ui = {};
  var renderAutoRead = function () {};
  var pending = [];
  var flushing = false;
  var diag = {hook: "no", world: "unknown", sameRealm: false, pageApp: false, graphqlSeen: 0, matched: {}, unmatched: [], domAccepted: 0, skips: {}, skipsByOp: {}};
  var visit = {key: "", base: 0};
  var importParts = [];

  function persist() {
    try {
      if (typeof GM_setValue === "function") GM_setValue(STORE_KEY, normalizeStore(store));
    } catch (err) {}
  }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      persist();
    }, 800);
  }
  function currentOwner() {
    var typed = norm(store.prefs.owner);
    if (typed) return typed;
    var detected = detectOwner(page);
    if (!detected) return "";
    store.prefs.owner = detected;
    if (ui.owner) ui.owner.value = detected;
    scheduleSave();
    return detected;
  }
  function fallbackCopy(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      (document.body || document.documentElement).appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      area.remove();
      return !!ok;
    } catch (err) {
      return false;
    }
  }
  function scanCells() {
    var owner = currentOwner();
    if (!flushing) flushPending();
    var kind = listKindFromPath(location.pathname, owner);
    if (!kind || !owner) return;
    var root = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main[role="main"]');
    if (!root) return;
    var cells = root.querySelectorAll('[data-testid="UserCell"]');
    var users = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var nameBox = cell.querySelector('[data-testid="User-Name"]');
      var hrefs = [];
      var links = cell.querySelectorAll("a[href]");
      for (var j = 0; j < links.length; j++) hrefs.push(links[j].getAttribute("href") || "");
      var verified = !!cell.querySelector('[data-testid="icon-verified"], [data-testid="icon-verified-enterprise"], [data-testid="verificationBadge"]');
      var user = userFromVisible(hrefs, nameBox ? nameBox.textContent : "", verified);
      if (user && user.handle !== owner) users.push(user);
    }
    if (!users.length) return;
    var bucket = kind === "following" ? store.following : store.followers;
    var before = Object.keys(bucket).length;
    var capturedCells = applyCapture(store, {kind: kind, skip: "", posts: [], users: users}, Date.now());
    var snapped = maybeSnapshot(store, kind === "following" ? "following" : "followers", Date.now());
    if (capturedCells || snapped) {
      var after = Object.keys(bucket).length;
      if (after > before) diag.domAccepted += after - before;
      scheduleSave();
      updateBadge();
      if (panelOpen) render();
    }
  }
  function scanTotals() {
    var owner = currentOwner();
    if (!owner) return;
    var root = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main[role="main"]');
    if (!root) return;
    var changed = false;
    var links = root.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      var text = links[i].textContent || "";
      var found = headerListCount(href, text, owner);
      if (found && (store.totals[found.kind] || 0) !== found.count) {
        store.totals[found.kind] = found.count;
        changed = true;
      }
      var blue = headerVerifiedCount(href, text, owner);
      if (blue && (store.totals.blue || 0) !== blue) {
        if (!store.totals) store.totals = {followers: 0, following: 0, blue: 0};
        store.totals.blue = blue;
        changed = true;
      }
    }
    if (!changed) return;
    maybeSnapshot(store, "followers", Date.now());
    maybeSnapshot(store, "following", Date.now());
    scheduleSave();
    updateBadge();
    if (panelOpen) render();
  }
  function noteTraffic(url) {
    var op = operationName(url);
    if (!op) return;
    diag.graphqlSeen += 1;
    if (!classifyUrl(url)) {
      if (diag.unmatched.indexOf(op) < 0) {
        diag.unmatched.push(op);
        if (diag.unmatched.length > 8) diag.unmatched.shift();
      }
      return;
    }
    diag.matched[op] = (diag.matched[op] || 0) + 1;
  }
  function rememberListTemplate(captured, listId) {
    if (!listId || !page) return;
    var keep = page.__fanAuditKeepListTemplate;
    var drop = page.__fanAuditDropListTemplate;
    if ((captured.kind === "following" || captured.kind === "followers" || captured.kind === "blue-followers") && !captured.skip && typeof keep === "function") keep(listId);
    else if (typeof drop === "function") drop(listId);
  }
  function ingest(url, text, body, countTraffic, listId) {
    if (countTraffic) noteTraffic(url);
    var owner = currentOwner();
    var captured = parseCapture(url, text, {owner: owner, body: body, pageKind: listKindFromPath(location.pathname, owner), pagePath: location.pathname});
    rememberListTemplate(captured, listId);
    if (captured.skip) {
      diag.skips[captured.skip] = (diag.skips[captured.skip] || 0) + 1;
      var skipOp = captured.op || operationName(url) || "unknown";
      if (!diag.skipsByOp[skipOp]) diag.skipsByOp[skipOp] = {};
      diag.skipsByOp[skipOp][captured.skip] = (diag.skipsByOp[skipOp][captured.skip] || 0) + 1;
    }
    if (captured.skip === "还不知道你的用户名" && text && pending.length < 20 && String(text).length < 1500000) {
      pending.push({url: url, text: text, body: body || "", listId: listId || ""});
    }
    var capturedNow = Date.now();
    var stored = applyCapture(store, captured, capturedNow);
    var snapKind = captured.kind === "following" ? "following" : (captured.kind === "followers" || captured.kind === "blue-followers" ? "followers" : "");
    var snapped = snapKind ? maybeSnapshot(store, snapKind, capturedNow) : false;
    if (stored || snapped) scheduleSave();
    updateBadge();
    if (panelOpen) render();
    if (!flushing && currentOwner()) flushPending();
  }
  function flushPending() {
    if (flushing || !currentOwner() || !pending.length) return;
    flushing = true;
    var batch = pending.splice(0, pending.length);
    try {
      batch.forEach(function (item) { ingest(item.url, item.text, item.body, false, item.listId || ""); });
    } finally {
      flushing = false;
    }
  }
  function onResponse(url, text, body, listId) {
    ingest(url, text, body, true, listId || "");
  }
  function injectPageHook() {
    var code = pageHookProgram();
    function added() {
      return document.documentElement && document.documentElement.getAttribute("data-fan-audit-hook") === "page";
    }
    try {
      if (typeof GM_addElement === "function") {
        try { GM_addElement(document.documentElement, "script", {textContent: code}); }
        catch (err) { GM_addElement("script", {textContent: code}); }
      }
    } catch (err) {}
    if (!added()) {
      try {
        var script = document.createElement("script");
        script.textContent = code;
        (document.documentElement || document.head || document).appendChild(script);
        script.remove();
      } catch (err) {}
    }
    return added();
  }
  diag.sameRealm = sameRealm(page);
  try {
    diag.world = (typeof GM_info !== "undefined" && GM_info && GM_info.sandboxMode) || (diag.sameRealm ? "page" : "isolated");
  } catch (err) {
    diag.world = diag.sameRealm ? "page" : "isolated";
  }
  if (page && diag.sameRealm) {
    try { hooks = installHooks(page, onResponse); diag.hook = "page"; }
    catch (err) { hookError = "钩子没有装上。CSP 或沙箱可能挡住了页面环境。"; diag.hook = "failed"; }
  } else if (page) {
    document.addEventListener("fan-audit-capture", function (event) {
      var detail = (event && event.detail) || {};
      onResponse(String(detail.url || ""), String(detail.text || ""), String(detail.body || ""), String(detail.listId || ""));
    });
    if (injectPageHook()) diag.hook = "page-script";
    else {
      diag.hook = "blocked";
      hookError = "钩子没有进到页面自己的环境。x.com 的内容安全策略会拦住内联脚本；油猴若跑在隔离世界里，就读不到页面自己的请求。自己的粉丝页、关注页上已经画出来的账号仍会记下。";
    }
  } else diag.hook = "no-window";

  function problems() {
    var sawPageApp = false;
    try { sawPageApp = !!(page && ("webpackChunk_twitter_responsive_web" in page)); } catch (err) { sawPageApp = false; }
    diag.pageApp = sawPageApp;
    var list = contextProblems({
      page: page,
      hookedOpen: hooks && hooks.hookedOpen,
      pageHookMarked: diag.hook === "page" || diag.hook === "page-script",
      sawPageApp: sawPageApp
    });
    if (hookError) list.unshift({level: "error", text: hookError});
    if (typeof GM_setValue !== "function") {
      list.unshift({level: "error", text: "没有 GM_setValue，数据存不住。请用 Tampermonkey 或 Violentmonkey 安装这个脚本，不要用「页面脚本」方式另存。"});
    }
    return list;
  }

  function mount() {
    if (document.getElementById("fan-audit-host")) return;
    var host = document.createElement("div");
    host.id = "fan-audit-host";
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("z-index", "2147483646", "important");
    host.style.setProperty("right", "0", "important");
    host.style.setProperty("bottom", "0", "important");
    host.style.setProperty("width", "0", "important");
    host.style.setProperty("height", "0", "important");
    host.style.setProperty("overflow", "visible", "important");
    var shadow = host.attachShadow({mode: "open"});
    var style = document.createElement("style");
    style.textContent = BOARD_CSS + "\n" + [
      "#launcher{position:fixed;right:16px;bottom:16px;z-index:2147483646;border:1px solid #1D4ED8;background:#1D4ED8;color:#fff;border-radius:999px;padding:8px 14px;font:600 14px -apple-system,'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif;cursor:pointer}",
      "#launcher.warn{background:#B45309;border-color:#B45309}",
      "#panel{position:fixed;right:16px;bottom:64px;z-index:2147483646;width:min(440px,calc(100vw - 24px));background:#F7F8FA;color:#1F2937;border:1px solid #E5E7EB;border-radius:16px;font:14px -apple-system,'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif}",
      "#panel[hidden]{display:none !important}",
      "#panel.wide{top:0;right:0;bottom:0;left:0;width:100vw;height:100vh;max-width:none;border-radius:0}",
      "#scroller{position:relative;overflow:auto;padding:14px 14px 8px;max-height:min(78vh,760px)}",
      "#panel.wide #scroller{max-height:100vh;height:100vh;padding:28px 32px 24px;box-sizing:border-box}",
      "#scroller h1{font-size:18px}",
      "#panel.wide h1{font-size:28px}",
      "#panel.wide .panels{grid-template-columns:1fr 1fr}",
      "#panel.wide .bar .k{width:210px}",
      "@media(max-width:820px){#panel.wide .panels{grid-template-columns:1fr}}",
      "#diag-box{margin:8px 0 12px;font-size:13px;color:#6B7280}",
      "#diag-box summary{cursor:pointer;color:#374151;font-weight:650}",
      ".row{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:8px 0}",
      "label.field{font-size:12px;color:#374151;display:flex;flex-direction:column;gap:4px}",
      "input[type=text]{border:1px solid #D1D5DB;border-radius:8px;padding:6px 8px;background:#fff;color:#1F2937}",
      "button.ctrl,a.ctrl{border:1px solid #D1D5DB;background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;color:#1F2937;text-decoration:none;display:inline-block}",
      "button.ctrl.on{background:#1D4ED8;color:#fff;border-color:#1D4ED8}",
      "button.danger{border-color:#FECACA;color:#B91C1C}",
      ".bar .k{width:132px}",
      "#status{min-height:1.2em}",
      ".check{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0}",
      ".got{color:#047857;font-weight:700}",
      ".miss{color:#9CA3AF}",
      "#import-drop{border:1px dashed #D1D5DB;border-radius:12px;padding:10px 12px;margin:8px 0;background:#fff;color:#4B5563;font-size:13px}",
      "#import-drop.over{border-color:#1D4ED8;background:#EFF6FF}",
      "#keep-box{margin:8px 0 12px}",
      "#more{margin:8px 0 12px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:8px 12px}",
      "#more summary{cursor:pointer;font-weight:650;color:#374151}",
      "#auto-read{border:1px solid #FDE68A;background:#FFFBEB;border-radius:12px;padding:10px 12px;margin:8px 0}",
      "#auto-read p{margin:6px 0}",
      "#auto-read .risk{white-space:pre-wrap;color:#92400E;font-size:13px;line-height:1.5}",
      "#auto-read label{display:flex;gap:8px;align-items:flex-start;font-size:13px}",
      "button.ctrl:disabled{opacity:.45;cursor:not-allowed}",
      "#auto-stop{position:fixed;right:132px;bottom:16px;z-index:2147483646;border:1px solid #B91C1C;background:#fff;color:#B91C1C;border-radius:999px;padding:8px 14px;font:600 14px -apple-system,'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif;cursor:pointer}",
      "#results table{display:block;overflow-x:auto}"
    ].join("\n");
    shadow.appendChild(style);

    var launcher = el("button", "", "粉丝体检");
    launcher.id = "launcher";
    launcher.type = "button";
    var badge = el("span");
    badge.id = "badge";
    launcher.appendChild(badge);
    shadow.appendChild(launcher);

    var panel = el("section");
    panel.id = "panel";
    panel.hidden = true;
    var scroller = el("div");
    scroller.id = "scroller";
    panel.appendChild(scroller);
    shadow.appendChild(panel);

    var title = el("h1", "", "粉丝体检");
    title.id = "top";
    var lead = el("p", "privacy", "默认只记下你正在浏览时页面已经收到的内容，不自己发请求，也不自动滚动。不会点赞、关注、取关或发帖。自动读取在下面，默认关闭，可选滚动或快速请求。");
    var diagBox = el("details");
    diagBox.id = "diag-box";
    var diagSummary = el("summary", "", "诊断信息");
    var diagLine = el("p", "muted");
    diagLine.id = "diag";
    var copyDiag = el("button", "ctrl", "复制诊断");
    copyDiag.type = "button";
    copyDiag.id = "copy-diag";
    diagBox.appendChild(diagSummary);
    diagBox.appendChild(diagLine);
    diagBox.appendChild(copyDiag);
    var maskBtn = el("button", "ctrl", "一键打码");
    maskBtn.type = "button";
    maskBtn.id = "mask";
    var widenBtn = el("button", "ctrl", "全屏");
    widenBtn.type = "button";
    widenBtn.id = "widen";
    widenBtn.setAttribute("aria-pressed", "false");
    var rowMain = el("div", "row");
    rowMain.appendChild(maskBtn);
    rowMain.appendChild(widenBtn);
    var row1 = el("div", "row");
    var ownerLabel = el("label", "field", "你的用户名");
    var owner = el("input");
    owner.type = "text";
    owner.id = "owner";
    owner.autocomplete = "off";
    owner.spellcheck = false;
    owner.placeholder = "不带 @";
    owner.value = store.prefs.owner || "";
    ownerLabel.appendChild(owner);
    var tzLabel = el("label", "field", "时区");
    var tz = el("input");
    tz.type = "text";
    tz.id = "tz";
    tz.autocomplete = "off";
    tz.spellcheck = false;
    tz.value = store.prefs.tz || (typeof FanAudit !== "undefined" && FanAudit.defaultTimeZone ? FanAudit.defaultTimeZone() : "UTC");
    tzLabel.appendChild(tz);
    row1.appendChild(ownerLabel);
    row1.appendChild(tzLabel);

    function modeButton(mode, label) {
      var button = el("button", "ctrl", label);
      button.type = "button";
      button.setAttribute("data-mode", mode);
      button.addEventListener("click", function () {
        store.prefs.mode = mode;
        scheduleSave();
        render();
      });
      rowMain.appendChild(button);
      return button;
    }
    modeButton("7", "最近 7 天");
    modeButton("30", "最近 30 天");
    modeButton("all", "全部");

    var row3 = el("div", "row");
    var delBtn = el("button", "ctrl danger", "全部删除");
    delBtn.type = "button";
    var exportBtn = el("button", "ctrl", "导出 JSON 备份");
    exportBtn.type = "button";
    var importBtn = el("button", "ctrl", "导入 JSON 备份");
    importBtn.type = "button";
    var downloadBtn = el("button", "ctrl", "下载看板 HTML");
    downloadBtn.type = "button";
    var openTabBtn = el("button", "ctrl", "新标签打开");
    openTabBtn.type = "button";
    openTabBtn.id = "open-tab";
    row3.appendChild(openTabBtn);
    row3.appendChild(delBtn);
    row3.appendChild(exportBtn);
    row3.appendChild(importBtn);
    row3.appendChild(downloadBtn);
    var importBtnFiles = el("button", "ctrl", "导入导出文件");
    importBtnFiles.type = "button";
    importBtnFiles.id = "import-export";
    row3.appendChild(importBtnFiles);
    var file = el("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.hidden = true;
    var importFile = el("input");
    importFile.type = "file";
    importFile.multiple = true;
    importFile.accept = "application/json,.json,.csv,text/csv";
    importFile.hidden = true;
    importFile.id = "import-files";
    var drop = el("div", "");
    drop.id = "import-drop";
    drop.textContent = "把导出的 JSON 拖到这里，或点「导入导出文件」。能认用户推文 / UserTweets、正在关注 / Following、关注者 / Followers。数据只在你的浏览器里处理，不会上传。";
    var importTable = el("div");
    importTable.id = "import-table";
    var keepBox = el("section", "card");
    keepBox.id = "keep-box";
    keepBox.appendChild(el("h2", "", "保留名单"));
    keepBox.appendChild(el("p", "muted", "这些账号是你打算继续关注的，会从「没回关」里拿掉。只记在本机。没有关注或取关按钮。"));
    keepBox.appendChild(el("p", "muted", "打码模式打开后，保留名单和关注变化也只显示编号。"));
    var keepRow = el("div", "row");
    var keepInput = el("input");
    keepInput.type = "text";
    keepInput.id = "keep-input";
    keepInput.autocomplete = "off";
    keepInput.spellcheck = false;
    keepInput.placeholder = "用户名，不带 @";
    var keepAdd = el("button", "ctrl", "添加");
    keepAdd.type = "button";
    keepAdd.id = "keep-add";
    var keepRemove = el("button", "ctrl", "移除");
    keepRemove.type = "button";
    keepRemove.id = "keep-remove";
    keepRow.appendChild(keepInput);
    keepRow.appendChild(keepAdd);
    keepRow.appendChild(keepRemove);
    var keepList = el("div");
    keepList.id = "keep-list";
    keepBox.appendChild(keepRow);
    keepBox.appendChild(keepList);
    var more = el("details");
    more.id = "more";
    more.appendChild(el("summary", "", "更多"));
    more.appendChild(el("p", "muted", "导出、导入、删除和诊断收在这里。平时用上面的打码、全屏和日期就够。"));
    more.appendChild(diagBox);
    more.appendChild(row3);
    more.appendChild(drop);
    more.appendChild(importTable);
    more.appendChild(keepBox);

    var autoReader = createAutoReader();
    var fastReader = createFastReader();
    var autoShown = "off";
    var autoTimer = 0;
    var lastScroll = {moved: true, atBottom: false};
    var autoBox = el("section");
    autoBox.id = "auto-read";
    autoBox.appendChild(el("p", "", "自动读取我自己的关注 / 粉丝名单"));
    autoBox.appendChild(el("p", "muted", "默认关闭。滚动大约 1 到 2 秒一屏。快速模式由脚本自己连续请求列表，页与页之间不再故意等待。两种都不读别人的名单。刷新后回到关闭。"));
    var autoOpen = el("button", "ctrl", "查看风险并决定是否开启");
    autoOpen.type = "button";
    autoOpen.id = "auto-read-open";
    var autoRisk = el("div");
    autoRisk.id = "auto-read-risk";
    autoRisk.hidden = true;
    autoRisk.appendChild(el("p", "risk", AUTO_READ_RISK));
    var autoModeRow = el("div");
    var autoScrollMode = el("input");
    autoScrollMode.type = "radio";
    autoScrollMode.name = "fan-audit-auto-mode";
    autoScrollMode.value = "scroll";
    autoScrollMode.checked = true;
    var autoScrollLabel = el("label");
    autoScrollLabel.appendChild(autoScrollMode);
    autoScrollLabel.appendChild(document.createTextNode(" 滚动（约 1–2 秒一屏，单次最多 " + AUTO_READ_MAX_SCREENS + " 屏）"));
    var autoFastMode = el("input");
    autoFastMode.type = "radio";
    autoFastMode.name = "fan-audit-auto-mode";
    autoFastMode.value = "fast";
    var autoFastLabel = el("label");
    autoFastLabel.appendChild(autoFastMode);
    autoFastLabel.appendChild(document.createTextNode(" 快速（脚本自己连续请求列表，每页约 100 人，单次最多 " + FAST_READ_MAX_PAGES + " 页，风险更高）"));
    autoModeRow.appendChild(autoScrollLabel);
    autoModeRow.appendChild(autoFastLabel);
    autoRisk.appendChild(autoModeRow);
    var autoAckLabel = el("label");
    var autoAck = el("input");
    autoAck.type = "checkbox";
    autoAck.id = "auto-read-ack";
    autoAckLabel.appendChild(autoAck);
    autoAckLabel.appendChild(document.createTextNode(AUTO_READ_ACK));
    var autoStart = el("button", "ctrl", "开始读取");
    autoStart.type = "button";
    autoStart.id = "auto-read-start";
    autoStart.disabled = true;
    var autoCancel = el("button", "ctrl", "先用手动滑动");
    autoCancel.type = "button";
    autoCancel.id = "auto-read-cancel";
    var autoRiskRow = el("div", "row");
    autoRiskRow.appendChild(autoStart);
    autoRiskRow.appendChild(autoCancel);
    autoRisk.appendChild(autoAckLabel);
    autoRisk.appendChild(autoRiskRow);
    var autoStatus = el("p", "muted", "默认关闭。不点开始就不会滚动。");
    autoStatus.id = "auto-read-status";
    var autoStop = el("button", "ctrl danger", "停止");
    autoStop.type = "button";
    autoStop.id = "auto-read-stop";
    autoStop.hidden = true;
    autoBox.appendChild(autoOpen);
    autoBox.appendChild(autoRisk);
    autoBox.appendChild(autoStatus);
    autoBox.appendChild(autoStop);
    var autoFloat = el("button", "", "停止读取");
    autoFloat.type = "button";
    autoFloat.id = "auto-stop";
    autoFloat.hidden = true;
    shadow.appendChild(autoFloat);

    var tzLine = el("p", "sub");
    tzLine.id = "tz-label";
    var warnings = el("div");
    warnings.id = "warnings";
    var coverage = el("div");
    coverage.id = "coverage";
    var status = el("p", "muted");
    status.id = "status";
    var results = el("div");
    results.id = "results";
    var footer = el("footer");
    var repo = el("a", "", "fan-audit（油猴版）· GitHub 开源");
    repo.href = "https://github.com/ratt1e/Xfan-audit";
    repo.target = "_blank";
    repo.rel = "noopener noreferrer";
    footer.appendChild(repo);

    scroller.appendChild(title);
    scroller.appendChild(lead);
    scroller.appendChild(rowMain);
    scroller.appendChild(row1);
    scroller.appendChild(autoBox);
    scroller.appendChild(tzLine);
    scroller.appendChild(warnings);
    scroller.appendChild(coverage);
    scroller.appendChild(status);
    scroller.appendChild(results);
    scroller.appendChild(more);
    scroller.appendChild(file);
    scroller.appendChild(importFile);
    scroller.appendChild(footer);
    ui = {owner: owner, tz: tz, maskBtn: maskBtn, shadow: shadow, scroller: scroller, results: results, warnings: warnings, coverage: coverage, status: status, tzLine: tzLine, launcher: launcher, badge: badge, panel: panel, diagLine: diagLine, widenBtn: widenBtn, importTable: importTable, keepList: keepList, keepInput: keepInput, more: more, _backItems: [], _keepItems: []};
    var wide = false;
    function setWide(next) {
      wide = !!next;
      panel.classList.toggle("wide", wide);
      widenBtn.textContent = wide ? "退出全屏" : "全屏";
      widenBtn.setAttribute("aria-pressed", wide ? "true" : "false");
    }
    function clearAutoTimer() {
      if (!autoTimer) return;
      clearTimeout(autoTimer);
      autoTimer = 0;
    }
    renderAutoRead = function () {
      var phase = fastReader.running() ? "running" : autoReader.phase();
      autoOpen.hidden = phase === "running";
      autoRisk.hidden = phase !== "confirm";
      autoStop.hidden = phase !== "running";
      autoFloat.hidden = phase !== "running";
      if (phase === "confirm" && autoShown !== "confirm") {
        autoAck.checked = false;
        autoReader.setAcknowledged(false);
        autoStart.disabled = true;
        autoScrollMode.checked = true;
        autoFastMode.checked = false;
      }
      autoShown = phase;
      var reason = autoReader.stopReason();
      if (phase === "running" && fastReader.running()) autoStatus.textContent = "正在快速读取。已请求 " + fastReader.pages() + " 页。这一页没有新账号就会停。可以随时停止。";
      else if (phase === "running") autoStatus.textContent = "正在滚动。已滚 " + autoReader.screens() + " 屏，距离上次新增 " + autoReader.screensSinceGain() + " 屏。可以随时停止。";
      else if (phase === "confirm") autoStatus.textContent = "先看完上面的提示，选一种方式并勾选后才能开始。现在还没有滚动，也没有发请求。";
      else if (reason) autoStatus.textContent = reason + " 自动读取已关闭。";
      else autoStatus.textContent = "默认关闭。不点开始就不会滚动。";
    }
    function haltAuto(reason) {
      clearAutoTimer();
      autoReader.stop(reason);
      fastReader.stop(reason);
      if (reason) status.textContent = reason;
      renderAutoRead();
    }
    function findPageScroller() {
      var doc = document;
      var view = window;
      try {
        var page = pageWindow();
        if (page && page.document) { doc = page.document; view = page; }
      } catch (err) {}
      var root = doc.querySelector('[data-testid="primaryColumn"]');
      if (!root) return null;
      var node = root;
      while (node && node !== doc.body && node !== doc.documentElement) {
        try {
          var style = view.getComputedStyle(node);
          var oy = style && style.overflowY;
          if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 80) return {node: node, view: view};
        } catch (err) {}
        node = node.parentElement;
      }
      return {node: doc.scrollingElement || doc.documentElement, view: view, windowScroll: true};
    }
    function scrollMetrics(found) {
      var view = found.view;
      var node = found.node;
      var doc = view.document || document;
      if (found.windowScroll) {
        var y = view.scrollY || view.pageYOffset || 0;
        var height = view.innerHeight || 0;
        var full = 0;
        try { full = (doc.scrollingElement || doc.documentElement).scrollHeight || 0; } catch (err) {}
        return {pos: y, atBottom: full > 0 && y + height >= full - 48};
      }
      var pos = node.scrollTop || 0;
      var client = node.clientHeight || 0;
      var total = node.scrollHeight || 0;
      return {pos: pos, atBottom: total > 0 && pos + client >= total - 48};
    }
    function visibleListKey() {
      var doc = document;
      try {
        var pageView = pageWindow();
        if (pageView && pageView.document) doc = pageView.document;
      } catch (err) {}
      var root = doc.querySelector('[data-testid="primaryColumn"]') || doc.querySelector('main[role="main"]');
      if (!root) return "";
      var cells = root.querySelectorAll('[data-testid="UserCell"]');
      var names = [];
      for (var i = 0; i < cells.length; i++) {
        var links = cells[i].querySelectorAll("a[href]");
        var handle = "";
        for (var j = 0; j < links.length; j++) {
          var match = String(links[j].getAttribute("href") || "").match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
          if (match) { handle = match[1].toLowerCase(); break; }
        }
        if (handle) names.push(handle);
      }
      return names.join("\n");
    }
    function nudgeOwnList() {
      var found = findPageScroller();
      if (!found || !found.node) return {moved: false, atBottom: false};
      var scrollerNode = found.node;
      var view = found.view;
      var before = scrollMetrics(found).pos;
      var cells = [];
      try {
        var column = (view.document || document).querySelector('[data-testid="primaryColumn"]');
        if (column) cells = column.querySelectorAll('[data-testid="UserCell"]');
      } catch (err) {}
      if (cells.length) {
        try { cells[cells.length - 1].scrollIntoView({block: "end", inline: "nearest"}); } catch (err) {}
      }
      var mid = scrollMetrics(found).pos;
      var viewHeight = found.windowScroll ? (view.innerHeight || 700) : (scrollerNode.clientHeight || 700);
      var delta = Math.max(480, Math.floor(viewHeight * 0.95));
      if (found.windowScroll) view.scrollTo(0, mid + delta);
      else scrollerNode.scrollTop = mid + delta;
      var afterMetrics = scrollMetrics(found);
      return {moved: afterMetrics.pos > before + 8, atBottom: afterMetrics.atBottom};
    }
    function pageBlockReason() {
      var doc = document;
      try {
        var page = pageWindow();
        if (page && page.document) doc = page.document;
      } catch (err) {}
      var nodes = doc.querySelectorAll('[data-testid="toast"], [role="alert"], [data-testid="error-detail"], [data-testid="empty_state_header_text"], [data-testid="empty_state_body_text"]');
      for (var i = 0; i < nodes.length; i++) {
        var reason = autoReadBlockReason(nodes[i].textContent || "");
        if (reason) return reason;
      }
      return "";
    }
    function scheduleAuto(delay) {
      clearAutoTimer();
      autoTimer = setTimeout(runAutoTick, delay);
    }
    function runAutoTick() {
      autoTimer = 0;
      if (autoReader.phase() !== "running") return;
      var ownerName = currentOwner();
      var kind = autoReadPageKind(location.pathname, ownerName);
      var decision = autoReader.tick(Date.now(), {
        pageKind: kind,
        blocked: pageBlockReason(),
        count: autoReadCount(store, kind),
        expected: kind === "following" ? (store.totals.following || 0) : kind === "blue-followers" ? (store.totals.blue || 0) : (store.totals.followers || 0),
        visibleKey: visibleListKey(),
        moved: lastScroll.moved,
        atBottom: lastScroll.atBottom,
        unit: Math.random()
      });
      if (decision.action !== "scroll") {
        if (decision.action === "stop") status.textContent = decision.reason;
        renderAutoRead();
        updateBadge();
        return;
      }
      lastScroll = nudgeOwnList();
      scanCells();
      scanTotals();
      scheduleAuto(decision.gapMs);
      renderAutoRead();
      updateBadge();
      if (panelOpen) render();
    }
    autoOpen.addEventListener("click", function () {
      autoReader.openConfirm();
      renderAutoRead();
    });
    autoAck.addEventListener("change", function () {
      autoReader.setAcknowledged(autoAck.checked);
      autoStart.disabled = !autoAck.checked;
    });
    autoCancel.addEventListener("click", function () {
      haltAuto("先不读。没有滚动。");
    });
    function chosenAutoMode() {
      return autoFastMode.checked ? "fast" : "scroll";
    }
    function hasListTemplate(op) {
      return !!(page && typeof page.__fanAuditHasListTemplate === "function" && page.__fanAuditHasListTemplate(op));
    }
    function runFastList(op, cursor, done) {
      if (!fastReader.running()) return;
      var decision = fastReader.notePage();
      if (decision.action !== "continue") {
        status.textContent = decision.reason;
        haltAuto(decision.reason);
        return;
      }
      var tpl = page && page.__fanAuditListTemplate ? page.__fanAuditListTemplate(op) : null;
      var req = buildListPageRequest(tpl, cursor);
      if (!req || typeof page.__fanAuditFetchList !== "function") {
        haltAuto("还不能发这一页。请先在当前这个名单页手动往下滑一点，让页面自己加载一页后再试。关注页对应正在关注，粉丝页对应关注者，认证粉丝页对应认证粉丝。");
        return;
      }
      Promise.resolve(page.__fanAuditFetchList(op, req.url, req.method, req.body)).then(function (res) {
        if (!fastReader.running()) return;
        res = res || {};
        var stop = fastReadStopReason(res.status, res.remaining);
        if (stop) {
          haltAuto(stop);
          return;
        }
        var kind = op === "Following" ? "following" : op === "BlueVerifiedFollowers" ? "blue-followers" : "followers";
        var before = autoReadCount(store, kind);
        ingest(req.url, res.text || "", req.body || "", false, "");
        var after = autoReadCount(store, kind);
        var next = "";
        try { next = bottomCursor(JSON.parse(res.text || "")); } catch (err) { next = ""; }
        renderAutoRead();
        updateBadge();
        if (panelOpen) render();
        var pageStop = fastPageStopReason(before, after, cursor, next);
        if (pageStop) {
          haltAuto(pageStop);
          return;
        }
        if (!next) {
          done();
          return;
        }
        runFastList(op, next, done);
      }, function () {
        if (!fastReader.running()) return;
        haltAuto("请求失败，已停止，不会自动重试");
      });
    }
    function fastOpForKind(kind) {
      if (kind === "following") return "Following";
      if (kind === "followers") return "Followers";
      if (kind === "blue-followers") return "BlueVerifiedFollowers";
      return "";
    }
    function fastListLabel(op) {
      if (op === "Following") return "正在关注";
      if (op === "Followers") return "关注者";
      if (op === "BlueVerifiedFollowers") return "认证粉丝";
      return "名单";
    }
    function startFastRead() {
      var here = fastOpForKind(autoReadPageKind(location.pathname, currentOwner()));
      if (here && !hasListTemplate(here)) {
        status.textContent = "还没有捕获到你自己的" + fastListLabel(here) + "列表请求。请留在这个页面，手动往下滑一点，让页面自己加载一页后再试。关注页对应正在关注，粉丝页对应关注者，认证粉丝页对应认证粉丝。脚本不会去猜接口编号。";
        return;
      }
      var ops = [];
      if (here) ops.push(here);
      ["Following", "Followers", "BlueVerifiedFollowers"].forEach(function (op) {
        if (ops.indexOf(op) < 0 && hasListTemplate(op)) ops.push(op);
      });
      if (!ops.length) {
        status.textContent = "还没有捕获到你自己的正在关注、关注者或认证粉丝列表请求。请打开对应页面，手动往下滑一点后再试。脚本不会去猜接口编号。";
        return;
      }
      var begun = fastReader.start();
      if (!begun.ok) {
        status.textContent = begun.reason;
        return;
      }
      autoReader.stop("");
      status.textContent = "已开始快速读取。只请求已捕获的正在关注、关注者或认证粉丝，页与页之间不等待。";
      renderAutoRead();
      function nextOp(index) {
        if (!fastReader.running()) return;
        if (index >= ops.length) {
          haltAuto("快速读取已读完捕获到的名单。");
          return;
        }
        runFastList(ops[index], "", function () { nextOp(index + 1); });
      }
      nextOp(0);
    }
    autoStart.addEventListener("click", function () {
      if (!autoAck.checked) return;
      if (autoReader.phase() === "running" || fastReader.running()) return;
      autoReader.setAcknowledged(true);
      if (chosenAutoMode() === "fast") {
        startFastRead();
        renderAutoRead();
        return;
      }
      var ownerName = currentOwner();
      var kind = autoReadPageKind(location.pathname, ownerName);
      var begun = autoReader.start(Date.now(), kind, autoReadCount(store, kind));
      if (!begun.ok) {
        status.textContent = begun.reason;
        renderAutoRead();
        return;
      }
      lastScroll = {moved: true, atBottom: false};
      status.textContent = "已开始滚动。只滚动当前这份你自己的名单，由页面自己加载。已经记过的人也会算作页面还在加载。";
      renderAutoRead();
      scheduleAuto(autoReadGapMs(Math.random()));
    });
    autoStop.addEventListener("click", function () { haltAuto("已手动停止"); });
    autoFloat.addEventListener("click", function () { haltAuto("已手动停止"); });
    renderAutoRead();

    launcher.addEventListener("click", function () {
      panelOpen = !panelOpen;
      panel.hidden = !panelOpen;
      if (panelOpen) {
        if (!norm(store.prefs.owner)) currentOwner();
        flushPending();
        scanCells();
        render();
      }
    });
    copyDiag.addEventListener("click", function () {
      var text = diagnosticsCopy({
        hook: diag.hook,
        world: diag.world,
        sameRealm: diag.sameRealm,
        pageApp: diag.pageApp,
        graphqlSeen: diag.graphqlSeen,
        matched: diag.matched,
        unmatched: diag.unmatched,
        domAccepted: diag.domAccepted,
        ownerDetected: !!norm(store.prefs.owner),
        storedPosts: Object.keys(store.posts).length,
        storedFollowing: Object.keys(store.following).length,
        storedFollowers: Object.keys(store.followers).length,
        skips: diag.skips,
        skipsByOp: diag.skipsByOp
      });
      function copied(ok) {
        status.textContent = ok ? "已复制诊断。里面只有接口名和次数，没有账号名。" : "没能复制，请再点一次。";
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { copied(true); }, function () { copied(fallbackCopy(text)); });
          return;
        }
      } catch (err) {}
      copied(fallbackCopy(text));
    });
    maskBtn.addEventListener("click", function () {
      store.prefs.masked = !store.prefs.masked;
      scheduleSave();
      render();
    });
    owner.addEventListener("change", function () {
      var next = norm(owner.value);
      if (next !== norm(store.prefs.owner)) {
        store.totals = {followers: 0, following: 0, blue: 0};
        store.snapshots = [];
      }
      store.prefs.owner = next;
      owner.value = store.prefs.owner;
      scheduleSave();
      render();
    });
    tz.addEventListener("change", function () {
      store.prefs.tz = tz.value.trim();
      if (!store.prefs.tz && typeof FanAudit !== "undefined") tz.value = FanAudit.defaultTimeZone();
      scheduleSave();
      render();
    });
    delBtn.addEventListener("click", function () {
      var total = Object.keys(store.posts).length + Object.keys(store.following).length + Object.keys(store.followers).length;
      if (!confirm("删除本机保存的全部采集数据（" + total + " 条）和关注快照？删掉之后不能恢复。打码、时区和保留名单会留下。")) return;
      var prefs = store.prefs;
      var kept = {entries: store.keepEntries, ids: store.keepIds, handles: store.keepHandles};
      store = emptyStore();
      store.prefs = prefs;
      store.keepEntries = kept.entries || [];
      store.keepIds = kept.ids || {};
      store.keepHandles = kept.handles || {};
      openTiers = {};
      persist();
      status.textContent = "采集数据已删除。";
      render();
    });
    exportBtn.addEventListener("click", function () {
      try {
        downloadText("fan-audit-backup.json", exportBackup(store, Date.now()), "application/json");
        status.textContent = "已开始下载 JSON 备份。里面是精简字段，没有 cookie。";
      } catch (err) {
        status.textContent = "导出没能开始。可以换一个浏览器再试。";
      }
    });
    importBtn.addEventListener("click", function () { file.click(); });
    importBtnFiles.addEventListener("click", function () { importFile.click(); });
    function peopleOf(data, kind) {
      if (kind === "followers") return data.followerAccounts || [];
      if (kind === "prev-followers") return data.prevFollowerAccounts || [];
      if (kind === "following") return data.followingAccounts || [];
      if (kind === "prev-following") return data.prevFollowingAccounts || [];
      return [];
    }
    function commitImports() {
      if (typeof FanAudit === "undefined" || !FanAudit.loadTexts) {
        status.textContent = "打分引擎没有装进脚本。";
        return;
      }
      var ownerName = currentOwner() || norm(store.prefs.owner);
      var ready = importParts.filter(function (part) {
        return part.kind && part.kind !== "ask-users" && part.kind !== "unknown" && part.kind !== "bad";
      });
      if (!ready.length) return;
      var data;
      try {
        data = FanAudit.loadTexts(ready.map(function (part) {
          return {name: part.name, text: part.text, owner: ownerName, kind: part.kind};
        }));
      } catch (err) {
        status.textContent = "有一份文件读不了，已跳过";
        return;
      }
      var now = Date.now();
      applyImported(store, data, ownerName || data.owner, now);
      ready.forEach(function (part) {
        var snapKind = "";
        if (part.kind === "followers" || part.kind === "prev-followers") snapKind = "followers";
        if (part.kind === "following" || part.kind === "prev-following") snapKind = "following";
        if (!snapKind) return;
        var one;
        try {
          one = FanAudit.loadTexts([{name: part.name, text: part.text, owner: ownerName, kind: part.kind}]);
        } catch (err) { return; }
        recordSnapshot(store, snapKind, peopleOf(one, part.kind), exportTimeFromName(part.name, now), true, "export", part.name);
      });
      if (!norm(store.prefs.owner) && data.owner) {
        store.prefs.owner = norm(data.owner);
        owner.value = store.prefs.owner;
      }
      prune(store, now);
      persist();
      var note = data.warnings && data.warnings.length ? data.warnings.join("；") : "已导入导出文件。只写进本机，没有上传。";
      status.textContent = note;
    }
    function readImportFiles(fileList) {
      var files = [].slice.call(fileList || []);
      if (!files.length) return;
      var left = files.length;
      var slots = new Array(files.length);
      var refused = 0;
      files.forEach(function (picked, index) {
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || "");
          if (looksLikeBackup(text)) refused += 1;
          else {
            var kind = "bad";
            try { kind = FanAudit.fileKind(picked.name, text); } catch (err) { kind = "bad"; }
            slots[index] = {name: picked.name, text: text, kind: kind};
          }
          if (--left !== 0) return;
          slots.forEach(function (part) {
            if (!part) return;
            var replaced = false;
            for (var i = 0; i < importParts.length; i++) {
              if (importParts[i].name === part.name) { importParts[i] = part; replaced = true; break; }
            }
            if (!replaced) importParts.push(part);
          });
          commitImports();
          if (refused) status.textContent = "这是粉丝体检备份，请用「导入 JSON 备份」";
          render();
        };
        reader.onerror = function () {
          if (--left === 0) render();
        };
        reader.readAsText(picked);
      });
    }
    importFile.addEventListener("change", function () {
      var picked = importFile.files;
      importFile.value = "";
      readImportFiles(picked);
    });
    drop.addEventListener("dragover", function (event) { event.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (event) {
      event.preventDefault();
      drop.classList.remove("over");
      readImportFiles(event.dataTransfer && event.dataTransfer.files);
    });
    importTable.addEventListener("change", function (event) {
      var sel = event.target;
      if (!sel || sel.tagName !== "SELECT" || sel.getAttribute("data-idx") == null) return;
      var idx = +sel.getAttribute("data-idx");
      if (!importParts[idx]) return;
      importParts[idx].kind = sel.value;
      commitImports();
      render();
    });
    function keepFromInput(raw) {
      return String(raw || "").trim();
    }
    keepAdd.addEventListener("click", function () {
      if (!addKeep(store, keepFromInput(keepInput.value))) {
        status.textContent = "先写用户名。";
        return;
      }
      keepInput.value = "";
      scheduleSave();
      status.textContent = "已放进保留名单。不会去关注。";
      render();
    });
    keepRemove.addEventListener("click", function () {
      if (!removeKeep(store, keepFromInput(keepInput.value))) {
        status.textContent = "保留名单里没有这个用户名。";
        return;
      }
      keepInput.value = "";
      scheduleSave();
      status.textContent = "已从保留名单拿掉。不会去取关。";
      render();
    });
    keepBox.addEventListener("click", function (event) {
      var node = event.target;
      if (!node || !node.closest) return;
      var edit = node.closest("[data-keep-edit]");
      if (!edit) return;
      var item = (ui._keepItems || [])[+edit.getAttribute("data-keep-edit")];
      if (!item) return;
      removeKeep(store, item);
      scheduleSave();
      status.textContent = "已从保留名单拿掉。不会去取关。";
      render();
    });
    file.addEventListener("change", function () {
      var picked = file.files && file.files[0];
      file.value = "";
      if (!picked) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          store = prune(importBackup(String(reader.result || "")), Date.now());
          owner.value = store.prefs.owner || "";
          if (store.prefs.tz) tz.value = store.prefs.tz;
          persist();
          status.textContent = "已导入备份。";
          render();
        } catch (err) {
          status.textContent = err && err.message ? err.message : "导入失败";
        }
      };
      reader.readAsText(picked);
    });
    widenBtn.addEventListener("click", function () { setWide(!wide); });
    openTabBtn.addEventListener("click", function () {
      var openedUrl = "";
      try {
        var view = buildView();
        if (view.error) { status.textContent = view.error; return; }
        var note = store.prefs.masked ? "打开时打码是开的，页面里用账号编号。" : "打开时打码是关的，页面里有账号名，请只留在自己电脑上。";
        var blob = new Blob([standaloneHtml(view.fragment, note)], {type: "text/html"});
        openedUrl = URL.createObjectURL(blob);
        var opened = window.open(openedUrl, "_blank", "noopener");
        if (!opened) {
          URL.revokeObjectURL(openedUrl);
          status.textContent = "没能打开新标签。请改用全屏。数据没有离开这台电脑。";
          return;
        }
        status.textContent = "已在新标签打开本机看板，没有上传。若页面是空的，用全屏看。";
        setTimeout(function () { URL.revokeObjectURL(openedUrl); }, 120000);
      } catch (err) {
        if (openedUrl) URL.revokeObjectURL(openedUrl);
        status.textContent = "没能打开新标签。请改用全屏。数据没有离开这台电脑。";
      }
    });
    downloadBtn.addEventListener("click", function () {
      try {
        var view = buildView();
        if (view.error) { status.textContent = view.error; return; }
        var note = store.prefs.masked ? "下载时打码是开的，文件里用账号编号。" : "下载时打码是关的，文件里有账号名，请只留在自己电脑上。";
        downloadText("fan-audit-board.html", standaloneHtml(view.fragment, note), "text/html");
        status.textContent = "已开始下载看板 HTML。若浏览器没有保存文件，可能是 X 页面拦住了下载（待核实），可以先导出 JSON 备份。";
      } catch (err) {
        status.textContent = "下载没能开始。X 页面是否拦截下载还待核实，可以先导出 JSON 备份。";
      }
    });
    results.addEventListener("click", function (event) {
      var node = event.target;
      if (!node || !node.closest) return;
      var keepBtn = node.closest("[data-keep-index]");
      if (keepBtn) {
        var item = (ui._backItems || [])[+keepBtn.getAttribute("data-keep-index")];
        if (item) {
          addKeep(store, item);
          scheduleSave();
          status.textContent = "已放进保留名单。不会去关注。";
          render();
        }
        return;
      }
      var back = node.closest("a.back-top");
      if (back) {
        event.preventDefault();
        scroller.scrollTo({top: 0, behavior: "smooth"});
        return;
      }
      var expand = node.closest("[data-expand]");
      if (expand) {
        openTiers[expand.getAttribute("data-expand")] = true;
        var top = scroller.scrollTop;
        render();
        scroller.scrollTop = top;
        return;
      }
      var jumpId = node.closest("[data-jump-id]");
      if (jumpId) {
        scrollToId(jumpId.getAttribute("data-jump-id"), +(jumpId.getAttribute("data-count") || 0));
        return;
      }
      var jump = node.closest("[data-jump]");
      if (jump) {
        scrollToId("tier-" + jump.getAttribute("data-jump"), +(jump.getAttribute("data-count") || 0));
      }
    });

    (document.body || document.documentElement).appendChild(host);
    updateBadge();
    setTimeout(function () { currentOwner(); flushPending(); scanCells(); scanTotals(); updateBadge(); if (panelOpen) render(); }, 1000);
    setTimeout(function () { currentOwner(); flushPending(); scanCells(); scanTotals(); updateBadge(); if (panelOpen) render(); }, 5000);
    try {
      page && page.addEventListener("pagehide", function () {
        persist();
        haltAuto("页面关闭，自动读取已复位");
      });
    } catch (err) {}
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !panelOpen) return;
      if (wide) { setWide(false); return; }
      panelOpen = false;
      panel.hidden = true;
    });
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], {type: mime || "text/plain"});
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function scrollToId(id, count) {
    var target = ui.shadow.getElementById(id);
    var note = ui.shadow.getElementById("jump-note");
    if (note) note.textContent = count ? "" : "这一层暂时没有人";
    if (!target) return;
    var top = 0;
    var node = target;
    while (node && node !== ui.scroller) {
      top += node.offsetTop || 0;
      node = node.offsetParent;
    }
    ui.scroller.scrollTo({top: Math.max(0, top - 8), behavior: "smooth"});
    var heading = target.querySelector("h2");
    if (!heading) return;
    heading.classList.remove("flash");
    void heading.offsetWidth;
    heading.classList.add("flash");
  }

  function captureChecklist(owner, report) {
    var box = el("div");
    box.id = "checklist";
    box.appendChild(el("p", "sub", "采集清单（点链接在当前页打开，再手动往下翻。默认不自动滚动，也不自己发请求。）"));
    function row(label, href, captured, detail) {
      var line = el("p", "check");
      line.appendChild(el("span", captured ? "got" : "miss", captured ? "✓" : "未采集"));
      if (href) {
        var link = el("a", "ctrl", label);
        link.href = href;
        line.appendChild(link);
      } else {
        var plain = el("span", "", label);
        line.appendChild(plain);
      }
      if (detail) line.appendChild(el("span", "muted", " " + detail));
      box.appendChild(line);
      return line;
    }
    var handle = norm(owner);
    var home = handle ? "https://x.com/" + encodeURIComponent(handle) : "";
    var inbound = (report.inboundDays || 0) > 0;
    var replies = ((report.srcCount && report.srcCount.replies) || 0) > 0;
    row("别人回我", handle ? "https://x.com/search?q=" + encodeURIComponent("to:" + handle) + "&f=live" : "", inbound, inbound ? (report.inbound + " 条 / " + report.inboundDays + " 天") : "");
    var totals = report.totals || {};
    row("关注列表", home ? home + "/following" : "", !!report.sawFollowing, progressText(report.following, totals.following));
    row("粉丝列表", home ? home + "/followers" : "", !!report.sawFollowers, progressText(report.followers, totals.followers));
    row("认证粉丝", home ? home + "/verified_followers" : "", !!report.sawBlueFollowers, progressText(report.blueFollowers, totals.blue));
    row("主页回复", home ? home + "/with_replies" : "", replies, replies ? (report.srcCount.replies + " 条 / " + report.srcDays.replies + " 天") : "");
    var noted = ((report.srcCount && report.srcCount.notifications) || 0) > 0;
    var sawNotes = !!report.sawNotifications;
    row("通知", "https://x.com/notifications/mentions", noted || sawNotes, noted ? (report.srcCount.notifications + " 条 / " + report.srcDays.notifications + " 天") : (sawNotes ? "已打开，回复 0 条" : ""));
    box.appendChild(el("p", "muted", "「差不多了」表示已记人数达到页头或资料里的公开人数：20 人及以下要正好对上，再多至少约 95%。没读到人数就写「总数待核实」，不会猜一个数字。"));
    box.appendChild(el("p", "warn", "别人回我是搜索页，别一次翻太久。X 会限流，被限了就停下来等一等再翻。这一项没有自动读取，请自己滑动。"));
    return box;
  }

  function updateBadge() {
    if (!ui.badge) return;
    var owner = norm(ui.owner ? ui.owner.value : store.prefs.owner);
    var ctx = pageContext(location.pathname, location.search, owner);
    var report = coverageReport(store, owner, effectiveTz());
    var count = 0;
    if (ctx.kind === "followers") count = report.followers;
    else if (ctx.kind === "following") count = report.following;
    else if (ctx.kind === "replies") count = report.srcCount.replies;
    else if (ctx.kind === "inbound") count = report.inbound;
    else if (ctx.kind === "notifications") count = report.srcCount.notifications;
    var key = ctx.kind + ":" + location.pathname + location.search;
    if (key !== visit.key) {
      visit.key = key;
      visit.base = count;
    }
    ui.badge.textContent = badgeText(ctx.label, count, visit.base);
    var total = Object.keys(store.posts).length + Object.keys(store.following).length + Object.keys(store.followers).length;
    var bad = problems().some(function (item) { return item.level === "error"; });
    ui.launcher.classList.toggle("warn", bad && !total);
  }

  function effectiveTz() {
    var typed = (ui.tz && ui.tz.value || store.prefs.tz || "").trim();
    if (typed) return typed;
    if (typeof FanAudit !== "undefined" && FanAudit.defaultTimeZone) return FanAudit.defaultTimeZone();
    return "UTC";
  }

  function buildView() {
    if (typeof FanAudit === "undefined" || !FanAudit.analyze) return {error: "打分引擎没有装进脚本。"};
    var owner = norm(ui.owner ? ui.owner.value : store.prefs.owner);
    var data = toEngineData(store, owner, FanAudit.repliesFromTweets);
    var opt = {me: owner, gapsAreEmpty: true, tz: effectiveTz()};
    if (store.prefs.mode === "all") opt.allDays = true;
    else opt.days = store.prefs.mode === "7" ? 7 : 30;
    try {
      var result = FanAudit.analyze(data, opt);
      var back = FanAudit.notFollowedBack(data, result.rows);
      var diffInput = snapshotDiffInput(store);
      var diff = diffInput ? FanAudit.followDiff(diffInput) : null;
      var extras = [];
      if (back) extras.push({id: "not-followed-back", count: back.ready ? String(back.items.length) : "—", label: "没回关"});
      if (diff) {
        var changeKeys = ["unfollowed_me", "new_followers", "i_unfollowed", "i_followed"];
        var changeSeen = false;
        var changeTotal = 0;
        changeKeys.forEach(function (key) {
          if (diff[key] != null) { changeSeen = true; changeTotal += diff[key].length; }
        });
        extras.push({id: "follow-diff", count: changeSeen ? String(changeTotal) : "—", label: "关注变化"});
      }
      var fragment = FanAudit.boardHtml(result.rows, {masked: !!store.prefs.masked, open: openTiers, extras: extras, interactionReady: result.meta.interactionReady !== false, interactionNote: result.meta.interactionNote || ""});
      if (back) fragment += FanAudit.notFollowedBackHtml(back, {masked: !!store.prefs.masked, rows: result.rows});
      var diffHtml = diff ? FanAudit.followDiffHtml(diff, {masked: !!store.prefs.masked, rows: result.rows}) : "";
      fragment += diffHtml;
      return {result: result, fragment: fragment, owner: owner, back: back};
    } catch (err) {
      return {error: err && err.message ? err.message : "时区无效，请填 IANA 名称，例如 Asia/Shanghai"};
    }
  }

  function renderImportTable() {
    if (!ui.importTable) return;
    ui.importTable.textContent = "";
    if (!importParts.length) return;
    var choices = [["tweets", "用户推文"], ["following", "正在关注"], ["followers", "关注者"], ["prev-following", "旧·正在关注"], ["prev-followers", "旧·关注者"], ["keep", "保留名单"], ["interactions", "互动"], ["replies", "回复"], ["likes", "点赞"], ["profiles", "资料"]];
    var card = el("div", "card");
    card.appendChild(el("h2", "", "读入的文件"));
    var table = document.createElement("table");
    var head = document.createElement("tr");
    head.appendChild(el("th", "", "文件"));
    head.appendChild(el("th", "", "识别为"));
    table.appendChild(head);
    importParts.forEach(function (part, i) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "", part.name));
      var td = document.createElement("td");
      var sel = document.createElement("select");
      sel.setAttribute("data-idx", String(i));
      var opts = choices.slice();
      if (part.kind === "ask-users") opts.unshift(["ask-users", "请选择"]);
      else if (part.kind === "unknown") opts.unshift(["unknown", "未识别"]);
      else if (part.kind === "bad") opts.unshift(["bad", "读不了"]);
      opts.forEach(function (pair) {
        var opt = document.createElement("option");
        opt.value = pair[0];
        opt.textContent = pair[1];
        if (pair[0] === part.kind) opt.selected = true;
        sel.appendChild(opt);
      });
      td.appendChild(sel);
      tr.appendChild(td);
      table.appendChild(tr);
    });
    card.appendChild(table);
    if (importParts.some(function (part) { return part.kind === "ask-users"; })) {
      card.appendChild(el("div", "warn", "部分文件无法确认是「正在关注」还是「关注者」，请在下拉框中选择。旧名单请选「旧·关注者」或「旧·正在关注」，需持续关注的账号请选「保留名单」。未选择的文件暂不计入。"));
      if (ui.more) ui.more.open = true;
    }
    ui.importTable.appendChild(card);
  }

  function renderKeep(rows) {
    if (!ui.keepList) return;
    var masked = !!store.prefs.masked;
    var ordered = [];
    var seen = {};
    function push(entry) {
      var key = (entry.handle || "") + "#" + (entry.id || "");
      if (seen[key]) return;
      seen[key] = 1;
      ordered.push({id: entry.id || "", handle: entry.handle || ""});
    }
    var used = {};
    (rows || []).forEach(function (row) {
      (store.keepEntries || []).forEach(function (entry) {
        if (entry.handle && entry.handle === row.account) {
          used[entry.handle] = 1;
          push(entry);
        }
      });
    });
    (store.keepEntries || []).slice().sort(function (a, b) {
      var left = a.handle || a.id || "";
      var right = b.handle || b.id || "";
      return left < right ? -1 : left > right ? 1 : 0;
    }).forEach(function (entry) {
      if (entry.handle && used[entry.handle]) return;
      push(entry);
    });
    var known = {};
    (rows || []).forEach(function (row, i) {
      var s = String(i + 1);
      known[row.account] = "账号#" + (s.length < 2 ? "0" + s : s);
    });
    var next = (rows || []).length + 1;
    ui._keepItems = ordered;
    ui.keepList.textContent = "";
    if (!ordered.length) {
      ui.keepList.appendChild(el("p", "muted", "还没有保留的人。没回关里可以点「☆ 保留」。"));
      return;
    }
    ordered.forEach(function (entry, i) {
      var line = el("p", "check");
      var label = "";
      if (masked) {
        label = entry.handle && known[entry.handle];
        if (!label) {
          var s = String(next);
          label = "账号#" + (s.length < 2 ? "0" + s : s);
          next += 1;
        }
      } else label = entry.handle ? "@" + entry.handle : entry.id;
      line.appendChild(el("span", "", label));
      var btn = el("button", "ctrl", "移除");
      btn.type = "button";
      btn.setAttribute("data-keep-edit", String(i));
      line.appendChild(btn);
      ui.keepList.appendChild(line);
    });
  }

  function attachKeepButtons(items) {
    ui._backItems = items || [];
    var section = ui.shadow.getElementById("not-followed-back");
    if (!section) return;
    var rows = section.querySelectorAll("table tr");
    if (!rows.length) return;
    var head = document.createElement("th");
    head.textContent = "";
    rows[0].appendChild(head);
    for (var i = 1; i < rows.length; i++) {
      if (!ui._backItems[i - 1]) continue;
      var cell = document.createElement("td");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctrl";
      btn.textContent = "☆ 保留";
      btn.setAttribute("data-keep-index", String(i - 1));
      cell.appendChild(btn);
      rows[i].appendChild(cell);
    }
  }

  function render() {
    if (!ui.results) return;
    renderAutoRead();
    renderImportTable();
    renderKeep([]);
    if (ui.diagLine) {
      var matched = Object.keys(diag.matched).sort().map(function (key) { return key + " " + diag.matched[key]; }).join("、") || "无";
      var notable = [];
      diag.unmatched.forEach(function (op) {
        if (/Notification/i.test(op) && notable.indexOf(op) < 0) notable.push(op);
      });
      var skipBits = [];
      Object.keys(diag.skipsByOp).sort().forEach(function (op) {
        var reasons = diag.skipsByOp[op] || {};
        Object.keys(reasons).sort().forEach(function (reason) {
          if (reason === "不在采集名单" && !/Notification/i.test(op)) return;
          if (skipBits.length >= 4) return;
          skipBits.push(op + " " + reason + " " + reasons[reason]);
        });
      });
      var hookLabel = (diag.hook === "page" || diag.hook === "page-script") ? "已装" : "没装上";
      ui.diagLine.textContent = "钩子" + hookLabel
        + " · 匹配 " + matched
        + (notable.length ? " · 通知接口还没接上 " + notable.join("、") : "")
        + (skipBits.length ? " · 跳过 " + skipBits.join("、") : "")
        + "。装饰接口和完整次数在「复制诊断」里。";
    }
    ui.maskBtn.classList.toggle("on", !!store.prefs.masked);
    ui.maskBtn.textContent = store.prefs.masked ? "一键打码（已开）" : "一键打码";
    ui.maskBtn.setAttribute("aria-pressed", store.prefs.masked ? "true" : "false");
    var modes = ui.shadow.querySelectorAll("[data-mode]");
    for (var i = 0; i < modes.length; i++) {
      modes[i].classList.toggle("on", modes[i].getAttribute("data-mode") === (store.prefs.mode || "30"));
    }
    ui.warnings.textContent = "";
    problems().forEach(function (item) {
      ui.warnings.appendChild(el("div", "warn", item.text));
    });
    var report = coverageReport(store, norm(ui.owner.value), effectiveTz());
    ui.coverage.textContent = "";
    var empty = !Object.keys(store.posts).length && !Object.keys(store.following).length && !Object.keys(store.followers).length;
    if (empty) {
      var guide = el("p", "warn", EMPTY_GUIDE);
      guide.id = "empty-guide";
      ui.coverage.appendChild(guide);
      ui.coverage.appendChild(el("p", "muted", norm(ui.owner.value)
        ? "名单还是空的。请确认打开的是你自己的关注、粉丝或主页回复页，再手动往下翻。钩子有没有接上，展开「诊断信息」。默认保留 " + RETENTION_DAYS + " 天。"
        : "如果用户名是空的，先打开自己的主页，或在上面填上，再手动往下翻。默认保留 " + RETENTION_DAYS + " 天。"));
    }
    ui.coverage.appendChild(captureChecklist(norm(ui.owner.value), report));
    if (!empty) {
      ui.coverage.appendChild(el("p", "sub", "数据完整度（按当前时区算天数）"));
      ui.coverage.appendChild(el("p", "muted", "别人回我：" + report.inbound + " 条，覆盖 " + report.inboundDays + " 天。搜索记下 " + report.srcCount.search + " 条（" + report.srcDays.search + " 天），帖子详情 " + report.srcCount.detail + " 条（" + report.srcDays.detail + " 天），通知 " + report.srcCount.notifications + " 条（" + report.srcDays.notifications + " 天）。"));
      ui.coverage.appendChild(el("p", "muted", "我发出的回复：" + report.outbound + " 条，覆盖 " + report.outboundDays + " 天。主页回复页 " + report.srcCount.replies + " 条（" + report.srcDays.replies + " 天），主页帖子页 " + report.srcCount.originals + " 条（" + report.srcDays.originals + " 天）。"));
      var totals = report.totals || {};
      ui.coverage.appendChild(el("p", "muted", "正在关注：" + progressText(report.following, totals.following) + (report.sawFollowing ? "（已打开过列表）" : "（还没打开过列表）") + "。关注者：" + progressText(report.followers, totals.followers) + (report.sawFollowers ? "（已打开过普通粉丝列表）" : "（还没打开过普通粉丝列表）") + "。认证粉丝：" + progressText(report.blueFollowers, totals.blue) + (report.sawBlueFollowers ? "（已打开过）" : "（还没打开过）") + "。"));
      if (report.sawBlueFollowers && !report.sawFollowers) {
        ui.coverage.appendChild(el("p", "warn", "关注者目前只来自认证粉丝列表，普通粉丝还没记到，没回关会偏多。请再打开普通粉丝页往下翻。"));
      }
      if (!report.inboundDays) {
        ui.coverage.appendChild(el("p", "warn", "还没记到「别人回我」。金银牌会偏少。可以自己打开搜索 to:你的用户名（选最新）往下翻，或点开自己的帖子。"));
      }
      ui.coverage.appendChild(el("p", "muted", "名单是这段时间翻到的页面累加的，默认保留 " + RETENTION_DAYS + " 天。要重计请先全部删除，再重新往下翻。没点「开始读取」之前，脚本不会自己滚动。"));
      var completeFollowers = (store.snapshots || []).filter(function (snap) { return snap.kind === "followers" && snap.complete; }).length;
      var completeFollowing = (store.snapshots || []).filter(function (snap) { return snap.kind === "following" && snap.complete; }).length;
      var partial = (store.snapshots || []).some(function (snap) { return !snap.complete; });
      var snapText = "关注变化要有两份完整快照才对比。完整是指：资料或页头给出了人数，20 人及以下必须正好采齐，再多至少要到 95%（向上取整）。人数未知，或只翻了认证粉丝，都先标成未完整，不拿来对比，避免把没翻到的人算成取关。导入的关注者、正在关注按整份名单记，日期用文件名末尾的导出时间。目前完整快照：关注 " + completeFollowing + " 份，粉丝 " + completeFollowers + " 份。";
      if (completeFollowers < 2 && completeFollowing < 2) snapText += SNAPSHOT_WAITING + "。";
      if (partial) snapText += " 未完整的那次只留着，不参与对比。";
      ui.coverage.appendChild(el("p", "muted", snapText));
    }
    if (!norm(ui.owner.value)) {
      ui.results.innerHTML = "";
      renderKeep([]);
      ui.tzLine.textContent = "先填写你的用户名，或打开自己的主页让脚本从左侧个人主页按钮识别。";
      updateBadge();
      return;
    }
    var view = buildView();
    if (view.error) {
      ui.results.innerHTML = "";
      ui.tzLine.textContent = view.error;
      updateBadge();
      return;
    }
    var meta = view.result.meta;
    var cover = "区间 " + meta.start + " ~ " + meta.end + "。当前时区：" + meta.tz + "。覆盖 " + meta.covered + " 天";
    cover += meta.uncovered ? "，" + meta.uncovered + " 天无数据（不算零互动，不进持续性分母）" : "，无数据 0 天";
    ui.tzLine.textContent = cover + " · " + view.result.rows.length + " 个账号";
    ui.results.innerHTML = view.fragment;
    renderKeep(view.result.rows);
    attachKeepButtons(view.back && view.back.items);
    updateBadge();
  }

  var scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = 0; scanCells(); scanTotals(); updateBadge(); }, 400);
  }
  try {
    var observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {childList: true, subtree: true});
  } catch (err) {}
  setInterval(function () { scanCells(); scanTotals(); updateBadge(); }, 2000);

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
}

if (typeof document !== "undefined") boot();
})();
