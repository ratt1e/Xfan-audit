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

export var RETENTION_DAYS = 90;
export var RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export var EMPTY_GUIDE = "刚安装还没有数据？依次打开你的关注列表、粉丝列表和主页回复页，手动往下滑几屏，脚本会自动记录。";
export var TEXT_LIMIT = 30;

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
  ModeratedTimeline: "detail"
};

var POST_FIELDS = ["id", "uid", "handle", "name", "verified", "replyTo", "replyToHandle", "conv", "ts", "text", "src", "seen"];

export function emptyStore() {
  return {
    v: 1,
    prefs: {masked: false, tz: "", mode: "30", owner: ""},
    posts: {},
    following: {},
    followers: {},
    meta: {sawFollowing: false, sawFollowers: false, sawBlueFollowers: false}
  };
}

export function norm(value) {
  return String(value || "").trim().replace(/^@/, "").trim().toLowerCase();
}

export function operationName(url) {
  var match = String(url || "").match(/\/graphql\/[^/?#]+\/([A-Za-z0-9_]+)/);
  return match ? match[1] : "";
}

export function classifyUrl(url) {
  return OPS[operationName(url)] || "";
}

export function listKindFromPath(pathname, owner) {
  var me = norm(owner);
  if (!me) return "";
  var match = String(pathname || "").match(/^\/([A-Za-z0-9_]{1,15})\/(followers|verified_followers|following)\/?$/);
  if (!match || norm(match[1]) !== me) return "";
  if (match[2] === "following") return "following";
  if (match[2] === "verified_followers") return "blue-followers";
  return "followers";
}

export function userFromVisible(hrefs, nameText, verified) {
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

export function diagnosticsCopy(state) {
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
  Object.keys(state.skips || {}).sort().forEach(function (key) {
    var label = SKIP_OK[key] ? key : "other";
    var count = state.skips[key] | 0;
    var found = false;
    for (var i = 0; i < skips.length; i++) {
      if (skips[i].label === label) { skips[i].count += count; found = true; }
    }
    if (!found) skips.push({label: label, count: count});
  });
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
    "skips=" + (skips.map(function (item) { return item.label + "=" + item.count; }).join(",") || "none")
  ].join("\n");
}

export function sameRealm(page) {
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

export function snippet(text, limit) {
  var chars = Array.from(String(text || "").replace(/\s+/g, " ").trim());
  var max = limit || TEXT_LIMIT;
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
}

// 问候判断看「去掉标点后的字数」和词表。只存 30 字时，长文如果开头像问候，会被误判。
// 全文已经超过问候长度上限时，补两个字，让打分引擎仍把它当成非问候。
export function textForStore(full) {
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

function fromItemContent(content, tweets, users) {
  if (!content || typeof content !== "object") return;
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
  } else {
    var direct = data.user && data.user.result && data.user.result.timeline && data.user.result.timeline.timeline;
    specific = (direct && direct.instructions) || [];
  }
  if (specific.length) return specific;
  return findInstructions(data, 0) || [];
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

function stamp(tweets, src) {
  return tweets.map(function (tweet) {
    return {
      id: tweet.id, uid: tweet.uid, handle: tweet.handle, name: tweet.name, verified: !!tweet.verified,
      replyTo: tweet.replyTo, replyToHandle: tweet.replyToHandle, conv: tweet.conv, ts: tweet.ts,
      text: tweet.text, src: src
    };
  });
}

export function parseCapture(url, text, options) {
  options = options || {};
  var kind = classifyUrl(url);
  if (!kind) return {kind: "", skip: "不在采集名单", posts: [], users: []};
  var json;
  try { json = JSON.parse(text); } catch (err) {
    return {kind: kind, skip: "响应不是 JSON", posts: [], users: []};
  }
  if (!json || typeof json !== "object") return {kind: kind, skip: "响应不是 JSON", posts: [], users: []};
  var owner = norm(options.owner);
  var profile = readProfile(json);
  var instructions = readInstructions(json, kind);
  var collected = collect(instructions);
  if (kind === "following" || kind === "followers" || kind === "blue-followers") {
    if (!owner) return {kind: kind, skip: "还不知道你的用户名", posts: [], users: [], profile: profile};
    var profileHandle = profile && norm(profile.handle);
    if (profileHandle && profileHandle !== owner) {
      return {kind: kind, skip: "不是你的关注或粉丝列表", posts: [], users: [], profile: profile};
    }
    if (!profileHandle && options.pageKind !== kind) {
      return {kind: kind, skip: "不是你的关注或粉丝列表", posts: [], users: [], profile: profile};
    }
    var users = collected.users.filter(function (user) { return norm(user.handle) !== owner; });
    return {kind: kind, skip: "", posts: [], users: users, profile: profile};
  }
  if (kind === "replies" || kind === "originals") {
    if (!owner) return {kind: kind, skip: "还不知道你的用户名", posts: [], users: [], profile: profile};
    if (!profile || norm(profile.handle) !== owner) {
      return {kind: kind, skip: "不是你的主页时间线", posts: [], users: [], profile: profile};
    }
    return {kind: kind, skip: "", posts: stamp(collected.tweets, kind), users: [], profile: profile};
  }
  if (!owner) return {kind: kind, skip: "还不知道你的用户名", posts: [], users: [], profile: profile};
  if (kind === "search") {
    var query = readRawQuery(url, options.body);
    if (query && !queryMentionsTo(query, owner)) {
      return {kind: kind, skip: "搜索不是 to:你的用户名", posts: [], users: [], profile: profile, query: query};
    }
    return {kind: kind, skip: "", posts: stamp(relatedTweets(collected.tweets, owner), "search"), users: [], profile: profile, query: query};
  }
  return {kind: kind, skip: "", posts: stamp(relatedTweets(collected.tweets, owner), "detail"), users: [], profile: profile};
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

export function prune(store, now) {
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
  return store;
}

export function applyCapture(store, captured, now) {
  if (!store || !captured || captured.skip || !captured.kind) return false;
  now = now || Date.now();
  var changed = false;
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
      if (handle) {
        var keys = Object.keys(store[bucket]);
        for (var i = 0; i < keys.length; i++) {
          if (norm(store[bucket][keys[i]].handle) === handle) { existingKey = keys[i]; break; }
        }
      }
      if (existingKey && existingKey !== key) {
        var previous = store[bucket][existingKey];
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
      if (!prev || prev.handle !== next.handle || prev.name !== next.name || prev.verified !== next.verified || prev.followers !== next.followers || prev.id !== next.id) {
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

export function coverageReport(store, owner, tz) {
  var me = norm(owner);
  var daysIn = {};
  var daysOut = {};
  var daysBySrc = {replies: {}, originals: {}, search: {}, detail: {}};
  var countIn = 0;
  var countOut = 0;
  var srcCount = {replies: 0, originals: 0, search: 0, detail: 0};
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
      detail: Object.keys(daysBySrc.detail).length
    },
    following: Object.keys(store.following || {}).length,
    followers: Object.keys(store.followers || {}).length,
    sawFollowing: !!meta.sawFollowing,
    sawFollowers: !!meta.sawFollowers,
    sawBlueFollowers: !!meta.sawBlueFollowers
  };
}

export function toEngineData(store, owner, repliesFromTweets) {
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
    warnings: []
  };
  if (typeof repliesFromTweets === "function") data.rows = repliesFromTweets(records, owner || "");
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

export function normalizeStore(input) {
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
    });
  });
  return store;
}

export function exportBackup(store, now) {
  var copy = normalizeStore(store);
  copy.exportedAt = new Date(now || Date.now()).toISOString();
  copy.note = "fan-audit 油猴版备份。只有打分需要的短字段，没有原始响应，也没有 cookie。";
  return JSON.stringify(copy);
}

export function importBackup(text) {
  if (String(text || "").length > 4000000) throw new Error("备份太大，不像精简数据");
  var obj = JSON.parse(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("备份不是 JSON 对象");
  if (obj.v !== 1) throw new Error("不认识这份备份的版本");
  assertNoSecrets(obj);
  if (obj.data && (obj.data.user || obj.data.search_by_raw_query)) throw new Error("这像是原始响应，不是备份");
  return normalizeStore(obj);
}

export function contextProblems(info) {
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
// 不调用 send，不新建请求，不读请求头和 cookie。
// 这个函数不能引用外层变量：跨沙箱时会把它的源码注进页面再执行。
function attachHooks(page, emit) {
  if (!page || typeof page.XMLHttpRequest !== "function") {
    throw new Error("页面上没有 XMLHttpRequest");
  }
  if (page.__fanAuditHooks) return page.__fanAuditHooks;
  var origOpen = page.XMLHttpRequest.prototype.open;
  var origSend = page.XMLHttpRequest.prototype.send;
  var origFetch = page.fetch;
  var interesting = /\/(UserRepliesTimeline|UserTweetsAndReplies|UserOriginalsTimeline|UserTweets|SearchTimeline|BlueVerifiedFollowers|Followers|Following|TweetDetail|ModeratedTimeline)(?:\?|#|$)/;
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
    try { xhr.__fanUrl = url; } catch (err) {}
    if (isGraphql(url)) {
      xhr.addEventListener("load", function () {
        try {
          if (xhr.status && xhr.status >= 400) return;
          var current = String(xhr.__fanUrl || "");
          var text = interesting.test(current) ? readXhrBody(xhr) : "";
          emit(current, text, xhr.__fanBody || "");
        } catch (err) {}
      });
    }
    return origOpen.apply(xhr, arguments);
  }
  function hookedSend(body) {
    try { this.__fanBody = typeof body === "string" ? body : ""; } catch (err) {}
    return origSend.apply(this, arguments);
  }
  function hookedFetch(input) {
    var url = requestUrl(input);
    var init = arguments[1];
    var body = "";
    try { if (init && typeof init.body === "string") body = init.body; } catch (err) {}
    var ret = origFetch.apply(this, arguments);
    if (!ret || typeof ret.then !== "function" || !isGraphql(url)) return ret;
    return ret.then(function (res) {
      try {
        if (!res || res.ok === false) return res;
        if (!interesting.test(String(url))) {
          emit(String(url), "", body);
          return res;
        }
        var clone = res && res.clone ? res.clone() : null;
        if (clone && clone.text) {
          clone.text().then(function (text) {
            try { emit(String(url), text, body); } catch (err) {}
          }, function () {});
        }
      } catch (err) {}
      return res;
    });
  }
  page.XMLHttpRequest.prototype.open = hookedOpen;
  page.XMLHttpRequest.prototype.send = hookedSend;
  if (typeof origFetch === "function") page.fetch = hookedFetch;
  var hooks = {hookedOpen: hookedOpen, origOpen: origOpen, origFetch: origFetch};
  try { page.__fanAuditHooks = hooks; } catch (err) {}
  try { page.__fanAuditPageHook = 1; } catch (err) {}
  try {
    if (page.document && page.document.documentElement) page.document.documentElement.setAttribute("data-fan-audit-hook", "page");
  } catch (err) {}
  return hooks;
}

export function installHooks(page, onResponse) {
  return attachHooks(page, onResponse);
}

export function pageHookProgram() {
  return "try{(" + attachHooks.toString() + ")(window,function(url,text,body){try{document.dispatchEvent(new CustomEvent(\"fan-audit-capture\",{detail:{url:String(url||\"\"),text:String(text||\"\"),body:typeof body===\"string\"?body:\"\"}}));}catch(err){}});}catch(err){}\n";
}

export var BOARD_CSS = [
  "body{font-family:-apple-system,'PingFang SC','Noto Sans CJK SC','Microsoft YaHei',sans-serif;background:#F7F8FA;color:#1F2937;margin:0;padding:28px}",
  "h1{font-size:28px;margin:0 0 4px} h2{font-size:18px;margin:0 0 12px}",
  ".privacy{background:#ECFDF5;border:1px solid #6EE7B7;border-radius:12px;padding:12px 16px;font-size:16px;font-weight:650;margin:14px 0}",
  ".sub{color:#6B7280;font-size:14px;margin:0 0 12px}",
  ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin:14px 0}",
  ".card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:16px 18px}",
  "button.card,a.card{padding:16px 18px;text-align:left;width:100%;cursor:pointer;box-sizing:border-box;font:inherit}",
  "a.card{display:block;color:inherit;text-decoration:none}",
  "button.tier-card.empty,button.tier-card.empty .num,button.tier-card.empty .lab{background:#F3F4F6;color:#9CA3AF}",
  ".stat-cards{border-top:1px dashed #D1D5DB;padding-top:8px}",
  ".tag{display:inline-block;margin-top:6px;font-size:11px;color:#1D4ED8;background:#EFF6FF;border-radius:999px;padding:1px 8px}",
  ".block-head{display:flex;justify-content:space-between;align-items:center;gap:12px}",
  ".back-top{font-size:13px;color:#2563EB;text-decoration:none;white-space:nowrap}",
  ".tier-block{margin-bottom:16px;scroll-margin-top:12px}",
  "h2.flash{background:#FDE68A;border-radius:6px}",
  "button.bar{width:100%;background:transparent;border:0;padding:0;cursor:pointer;text-align:left;font:inherit}",
  ".num{font-size:32px;font-weight:700}.lab{color:#6B7280;font-size:13px;margin-top:4px}",
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

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[ch];
  });
}

export function standaloneHtml(fragment, note) {
  return "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>fan-audit 看板</title><style>"
    + BOARD_CSS + "</style></head><body><h1 id=\"top\">粉丝体检 · 互动关系星级</h1>"
    + "<p class=\"privacy\">这是本机生成的快照，打开时不会联网，也不会上传。</p>"
    + (note ? "<p class=\"sub\">" + escapeHtml(note) + "</p>" : "")
    + (fragment || "")
    + "<footer>fan-audit（油猴版）· 快照只供自己查看。工具不会代你点赞、关注、取关或发帖。</footer></body></html>";
}
