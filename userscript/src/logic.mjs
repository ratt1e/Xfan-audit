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
export var EMPTY_GUIDE = "刚安装还没有数据？依次打开你的关注列表、粉丝列表和主页回复页，手动往下滑几屏，脚本会记下。";
export var TEXT_LIMIT = 30;
export var SNAPSHOT_WAITING = "下次完整采集后自动对比";
// 自动读取默认关闭，刷新后也不恢复。这些数只约束「用户勾选并点了开始」之后的那一次。
export var AUTO_READ_GAP_MIN_MS = 1000;
export var AUTO_READ_GAP_MAX_MS = 2000;
export var AUTO_READ_MAX_SCREENS = 220;
export var AUTO_READ_MAX_MS = 12 * 60 * 1000;
export var AUTO_READ_STALL_MS = 45000;
export var AUTO_READ_STALL_SCREENS = 4;
export var AUTO_READ_STALL_FLOOR_MS = 12000;
// 到底或页面不再滚动之后，还要连续这么多次看不到加载，才停。
export var AUTO_READ_DRY_LIMIT = 5;
// 已记人数完全不增加时，满 30 屏或满 1 分钟就停。画面还在换也不再无限滚。
export var AUTO_READ_FLAT_SCREENS = 30;
export var AUTO_READ_FLAT_MS = 60 * 1000;
// 连续这么久滚动位置完全没变，就认为没找到名单自己的滚动容器。
export var AUTO_READ_NO_MOVE_MS = 6000;
export var FAST_READ_PAGE_SIZE = 100;
export var FAST_READ_MAX_PAGES = 120;
export var FAST_READ_REMAINING_FLOOR = 2;
export var AUTO_READ_RISK = "自动读取默认关闭。两种方式都只读你自己的关注和粉丝名单，不会关注、取关、点赞、转发、回复、私信或拉黑，也不会读别人的名单。\n\n滚动：脚本代替你在当前页面往下翻，让页面自己加载。这已经不属于「只读你浏览过的内容」。\n\n快速：脚本自己连续请求 X 的关注和粉丝列表接口，用游标一页一页往下读。这是自动化抓取，风险比滚动更高，可能被限流、临时限制甚至封号。X 没有公布具体阈值，不能保证安全，后果自负。不想冒险就关掉，继续用手动滑动。";
export var AUTO_READ_ACK = "我已阅读上面的提示。我知道快速模式会由脚本自己连续请求列表接口，可能被限流、临时限制甚至封号，后果自己承担。";

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

export function emptyStore() {
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
    excludeEntries: [],
    excludeIds: {},
    excludeHandles: {},
    extraRows: [],
    meta: {sawFollowing: false, sawFollowers: false, sawBlueFollowers: false, sawNotifications: false, sawExport: false}
  };
}

export function norm(value) {
  return String(value || "").trim().replace(/^@/, "").trim().toLowerCase();
}

export function operationName(url) {
  var text = String(url || "");
  var match = text.match(/\/graphql\/[^/?#]+\/([A-Za-z0-9_]+)/);
  if (match) return match[1];
  if (/\/notifications\/all\.json(?:\?|#|$)/.test(text)) return "NotificationsAll";
  if (/\/notifications\/mentions\.json(?:\?|#|$)/.test(text)) return "NotificationsMentions";
  if (/\/notifications\/verified\.json(?:\?|#|$)/.test(text)) return "NotificationsVerified";
  return "";
}

export function classifyUrl(url) {
  var op = operationName(url);
  if (OPS[op]) return OPS[op];
  if (/^Notifications[A-Za-z0-9]*Timeline$/.test(op)) return "notifications";
  if (op === "NotificationsAll" || op === "NotificationsMentions" || op === "NotificationsVerified") return "notifications";
  return "";
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

export function badgeText(label, count, base) {
  if (!label) return "";
  var n = count | 0;
  var extra = base != null && n > base ? " +" + (n - base) : "";
  return " " + label + " " + n + extra;
}

export function pageContext(pathname, search, owner) {
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

export function timelineKindFromPath(pathname, owner) {
  var me = norm(owner);
  if (!me) return "";
  var match = String(pathname || "").match(/^\/([A-Za-z0-9_]{1,15})(\/with_replies)?\/?$/);
  if (!match || norm(match[1]) !== me) return "";
  return match[2] ? "replies" : "originals";
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

export function parseCapture(url, text, options) {
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

export function prune(store, now) {
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

export function applyCapture(store, captured, now) {
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

export function coverageReport(store, owner, tz) {
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
  if (!store.excludeEntries) store.excludeEntries = [];
  if (!store.excludeIds) store.excludeIds = {};
  if (!store.excludeHandles) store.excludeHandles = {};
  if (!store.extraRows) store.extraRows = [];
  if (!store.meta) store.meta = {};
  return store;
}

export function listIsComplete(captured, expected) {
  captured = captured | 0;
  expected = expected | 0;
  if (expected <= 0) return false;
  if (expected <= 20) return captured === expected;
  return captured >= Math.ceil(expected * 0.95);
}

export function exportTimeFromName(name, fallback) {
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

export function headerListCount(href, text, owner) {
  var match = String(href || "").match(/^\/([A-Za-z0-9_]{1,15})\/(followers|following|verified_followers)\/?$/);
  if (!match || norm(match[1]) !== norm(owner)) return null;
  if (match[2] === "verified_followers") return null;
  var count = plainCount(text);
  if (!count) return null;
  return {kind: match[2] === "following" ? "following" : "followers", count: count};
}

export function headerVerifiedCount(href, text, owner) {
  var match = String(href || "").match(/^\/([A-Za-z0-9_]{1,15})\/verified_followers\/?$/);
  if (!match || norm(match[1]) !== norm(owner)) return 0;
  return plainCount(text);
}

// 已记 N / 共约 M。M 只用已经读到的公开人数；没有就写总数待核实。接近的口径和名单快照的完整线相同。
export function progressText(captured, expected) {
  var n = countNum(captured);
  var total = countNum(expected);
  var text = "已记 " + n + " / " + (total > 0 ? "共约 " + total : "总数待核实");
  if (total > 0 && (n >= total || listIsComplete(n, total))) text += "，差不多了";
  return text;
}

export function overflowCanScroll(overflowY) {
  var oy = String(overflowY || "");
  return oy === "auto" || oy === "scroll" || oy === "overlay";
}

// 从格子往上找真正在滚的那一层。主栏外面的窗口只有自己确实更高时才用。
export function chooseScrollNode(chain) {
  var list = chain || [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || item.isDocument) continue;
    if (overflowCanScroll(item.overflowY) && item.scrollHeight > item.clientHeight + 40) return i;
  }
  for (var j = 0; j < list.length; j++) {
    var doc = list[j];
    if (doc && doc.isDocument && doc.scrollHeight > doc.clientHeight + 80) return j;
  }
  return -1;
}

// 从当前滚动位置往下推大约一屏，不先跳到已加载内容的末尾。
export function nudgeScroller(scroller, viewHeight) {
  if (!scroller || typeof scroller.scrollTop !== "number") return {moved: false, atBottom: false, pos: 0};
  var before = scroller.scrollTop || 0;
  var client = scroller.clientHeight || viewHeight || 700;
  var total = scroller.scrollHeight || 0;
  var delta = Math.max(480, Math.floor((viewHeight || client || 700) * 0.9));
  var max = total > client ? total - client : before;
  var target = before + delta;
  if (target > max) target = max;
  try { scroller.scrollTop = target; } catch (err) {}
  var after = scroller.scrollTop || 0;
  if (after <= before + 8 && typeof scroller.scrollBy === "function") {
    try { scroller.scrollBy(0, delta); } catch (err) {}
    after = scroller.scrollTop || 0;
  }
  return {moved: after > before + 8, atBottom: total > 0 && after + client >= total - 48, pos: after};
}

export function scrollStartPlan(input) {
  input = input || {};
  if (!input.acked) return {ok: false, action: "", reason: "请先勾选确认"};
  if (input.mode !== "scroll" && input.mode !== "fast") return {ok: false, action: "", reason: "请先选择滚动或快速"};
  if (input.mode === "fast") return {ok: true, action: "fast", reason: ""};
  if (!input.pageKind) return {ok: false, action: "", reason: "没找到可滚动的列表，请先打开关注、粉丝或认证粉丝页"};
  if (!input.hasScroller) return {ok: false, action: "", reason: "没有找到可滚动的列表，请先打开关注、粉丝或认证粉丝页"};
  return {ok: true, action: "scroll", reason: ""};
}

export function autoReadGapMs(unit) {
  var u = Number(unit);
  if (!isFinite(u) || u < 0) u = 0;
  if (u >= 1) return AUTO_READ_GAP_MAX_MS;
  return AUTO_READ_GAP_MIN_MS + Math.floor(u * (AUTO_READ_GAP_MAX_MS - AUTO_READ_GAP_MIN_MS + 1));
}

export function autoReadPageKind(pathname, owner) {
  var kind = listKindFromPath(pathname, owner);
  if (kind === "following" || kind === "followers" || kind === "blue-followers") return kind;
  return "";
}

export function autoReadCount(store, kind) {
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
export function isOwnListApiUrl(url, op) {
  var parts = listUrlParts(url);
  var match = parts.path.match(/^https?:\/\/([^/]+)\/i\/api\/graphql\/[^/?#]+\/(Following|Followers|BlueVerifiedFollowers)$/i);
  if (!match) return false;
  var host = match[1].toLowerCase();
  var name = match[2];
  if (op && name !== op) return false;
  if (host !== "x.com" && host !== "twitter.com" && host !== "api.x.com" && host.slice(-6) !== ".x.com") return false;
  return name === "Following" || name === "Followers" || name === "BlueVerifiedFollowers";
}

export function listTemplateFromRequest(url, method, body) {
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
export function buildListPageRequest(template, cursor) {
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

export function bottomCursor(json) {
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
export function fastPageStopReason(beforeCount, afterCount, prevCursor, nextCursor) {
  var added = (afterCount | 0) > (beforeCount | 0);
  var cursor = String(nextCursor || "");
  var prev = String(prevCursor || "");
  if (cursor && prev && cursor === prev) return "游标没有变化，已停止";
  if (!added && !cursor) return "这一页没有新账号，也没有下一页，已停止";
  if (!added) return "这一页没有新账号，已停止";
  return "";
}

export function fastReadStopReason(status, remaining) {
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

export function createFastReader() {
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

export function autoReadBlockReason(text) {
  var raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 400) return "";
  if (/速率限制|超出速率|rate limit|too many requests/i.test(raw)) return "看到限流提示，已停止，不会自动重试";
  if (/something went wrong|出错了|请稍后再试|try again later|请尝试重新加载/i.test(raw)) return "看到页面报错，已停止，不会自动重试";
  return "";
}

// 内存里的开关。不写入油猴存储，所以刷新页面后一定是关闭。没勾选、没点开始时 tick 不会要求滚动。
export function createAutoReader() {
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
      if (!moved && !atBottom && (info.sinceMoveMs | 0) >= AUTO_READ_NO_MOVE_MS) return finish("没有找到可滚动的列表，已停止");
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

export function recordSnapshot(store, kind, people, at, complete, source, name) {
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

export function maybeSnapshot(store, kind, at) {
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

export function snapshotDiffInput(store) {
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
  var look = excludeLook(store);
  function shown(list) {
    return (list || []).filter(function (person) { return !personExcluded(look, person); });
  }
  return {
    sawFollowers: fer.ready,
    sawPrevFollowers: fer.ready,
    sawFollowing: fol.ready,
    sawPrevFollowing: fol.ready,
    followerAccounts: shown(fer.cur),
    prevFollowerAccounts: shown(fer.prev),
    followingAccounts: shown(fol.cur),
    prevFollowingAccounts: shown(fol.prev),
    excludeHandles: look.handles,
    excludeIds: look.ids,
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

export function addKeep(store, person) {
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

export function removeKeep(store, person) {
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

var EXCLUDE_HANDLE = /^[a-z0-9_]{1,15}$/;

function rebuildExcludeMaps(store) {
  store.excludeIds = {};
  store.excludeHandles = {};
  (store.excludeEntries || []).forEach(function (entry) {
    if (entry.id && /^\d+$/.test(entry.id)) store.excludeIds[entry.id] = 1;
    var handle = norm(entry.handle);
    if (handle) store.excludeHandles[handle] = 1;
  });
}

function excludePerson(person) {
  var id = "";
  var handle = "";
  if (typeof person === "string" || typeof person === "number") {
    var text = String(person || "").trim().replace(/^@+/, "");
    if (/^\d+$/.test(text)) id = text;
    else handle = norm(text);
  } else if (person && typeof person === "object") {
    id = String(person.id || "");
    if (!/^\d+$/.test(id)) id = "";
    handle = norm(person.handle || person.account);
  }
  if (handle && !EXCLUDE_HANDLE.test(handle)) handle = "";
  return {id: id, handle: handle};
}

export function parseExcludeText(text) {
  var found = [];
  var seen = {};
  String(text || "").split(/\r?\n/).forEach(function (line) {
    var raw = line.trim();
    if (!raw || raw.charAt(0) === "#") return;
    var hash = raw.search(/\s+#/);
    var body = hash >= 0 ? raw.slice(0, hash) : raw;
    body.split(/[\s,，;；]+/).forEach(function (token) {
      token = String(token || "").trim().replace(/^@+/, "").replace(/^["']|["']$/g, "");
      if (!token || token.charAt(0) === "#") return;
      var person = excludePerson(token);
      if (!person.id && !person.handle) return;
      var key = person.id ? "id:" + person.id : "h:" + person.handle;
      if (seen[key]) return;
      seen[key] = 1;
      found.push(person);
    });
  });
  return found;
}

export function addExclude(store, person) {
  ensureStore(store);
  var next = excludePerson(person);
  if (!next.id && !next.handle) return false;
  var entries = store.excludeEntries;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!((next.id && entry.id === next.id) || (next.handle && entry.handle === next.handle))) continue;
    if (next.id) entry.id = next.id;
    if (next.handle) entry.handle = next.handle;
    rebuildExcludeMaps(store);
    return true;
  }
  entries.push({id: next.id, handle: next.handle});
  rebuildExcludeMaps(store);
  return true;
}

export function addExcludeMany(store, text) {
  var items = parseExcludeText(text);
  items.forEach(function (item) { addExclude(store, item); });
  ensureStore(store);
  return {parsed: items.length, total: store.excludeEntries.length};
}

export function removeExclude(store, person) {
  ensureStore(store);
  var next = excludePerson(person);
  var before = store.excludeEntries.length;
  store.excludeEntries = store.excludeEntries.filter(function (entry) {
    if (next.id && entry.id === next.id) return false;
    if (next.handle && entry.handle === next.handle) return false;
    return true;
  });
  rebuildExcludeMaps(store);
  return store.excludeEntries.length !== before;
}

export function clearExclude(store) {
  ensureStore(store);
  var had = store.excludeEntries.length > 0;
  store.excludeEntries = [];
  rebuildExcludeMaps(store);
  return had;
}

export function excludeText(store) {
  ensureStore(store);
  var lines = store.excludeEntries.map(function (entry) {
    return entry.handle || entry.id || "";
  }).filter(Boolean);
  return lines.length ? lines.join("\n") + "\n" : "";
}

function excludeLook(store) {
  ensureStore(store);
  rebuildExcludeMaps(store);
  var handles = {};
  var ids = {};
  Object.keys(store.excludeHandles).forEach(function (handle) { handles[handle] = 1; });
  Object.keys(store.excludeIds).forEach(function (id) { ids[id] = 1; });
  function absorb(id, handle) {
    id = String(id || "");
    handle = norm(handle);
    if ((id && ids[id]) || (handle && handles[handle])) {
      if (handle) handles[handle] = 1;
      if (/^\d+$/.test(id)) ids[id] = 1;
    }
  }
  ["following", "followers"].forEach(function (bucket) {
    Object.keys(store[bucket] || {}).forEach(function (key) {
      var user = store[bucket][key];
      if (user) absorb(user.id, user.handle);
    });
  });
  Object.keys(store.posts || {}).forEach(function (key) {
    var post = store.posts[key];
    if (post) absorb(post.uid, post.handle);
  });
  return {handles: handles, ids: ids};
}

function personExcluded(look, person) {
  var id = String((person && person.id) || "");
  var handle = norm(person && (person.handle || person.account));
  if (id && look.ids[id]) return true;
  if (handle && look.handles[handle]) return true;
  return false;
}

export function looksLikeBackup(text) {
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

export function applyImported(store, data, owner, now) {
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

export function toEngineData(store, owner, repliesFromTweets) {
  var look = excludeLook(store);
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
    if (handle && !look.handles[handle] && post.verified && !profiles[handle]) profiles[handle] = {handle: handle, verified: "true", is_blue_verified: "true"};
  });
  function usersOf(bucket) {
    var map = {};
    var list = [];
    Object.keys(bucket || {}).sort().forEach(function (key) {
      var user = bucket[key];
      if (personExcluded(look, user)) return;
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
    excludeHandles: look.handles,
    excludeIds: look.ids,
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
  var excluded = [];
  function rememberExclude(entry) {
    var id = String(entry.id || "");
    if (id && !/^\d+$/.test(id)) id = "";
    var handle = norm(entry.handle);
    if (handle && !EXCLUDE_HANDLE.test(handle)) handle = "";
    if (!id && !handle) return;
    for (var i = 0; i < excluded.length; i++) {
      if ((id && excluded[i].id === id) || (handle && excluded[i].handle === handle)) {
        if (id) excluded[i].id = id;
        if (handle) excluded[i].handle = handle;
        return;
      }
    }
    excluded.push({id: id, handle: handle});
  }
  (input.excludeEntries || []).forEach(function (entry) { if (entry) rememberExclude(entry); });
  Object.keys(input.excludeIds || {}).forEach(function (id) { rememberExclude({id: id, handle: ""}); });
  Object.keys(input.excludeHandles || {}).forEach(function (handle) { rememberExclude({id: "", handle: handle}); });
  store.excludeEntries = excluded;
  rebuildExcludeMaps(store);
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

export function installHooks(page, onResponse) {
  return attachHooks(page, onResponse);
}

export function pageHookProgram() {
  return "try{(" + attachHooks.toString() + ")(window,function(url,text,body,listId){try{document.dispatchEvent(new CustomEvent(\"fan-audit-capture\",{detail:{url:String(url||\"\"),text:String(text||\"\"),body:typeof body===\"string\"?body:\"\",listId:String(listId||\"\")}}));}catch(err){}});}catch(err){}\n";
}

export var BOARD_CSS = [
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
