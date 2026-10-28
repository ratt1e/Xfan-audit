import fs from "fs";
import path from "path";
import vm from "vm";
import {fileURLToPath} from "url";
import {
  EMPTY_GUIDE, RETENTION_DAYS, classifyUrl, textForStore, snippet, parseCapture, applyCapture,
  emptyStore, coverageReport, toEngineData, prune, exportBackup, importBackup, contextProblems,
  installHooks, pageHookProgram, norm, operationName, listKindFromPath, timelineKindFromPath, userFromVisible, diagnosticsCopy,
  pageContext, badgeText, listIsComplete, exportTimeFromName, recordSnapshot, snapshotDiffInput,
  addKeep, removeKeep, applyImported, headerListCount, headerVerifiedCount, SNAPSHOT_WAITING, looksLikeBackup,
  progressText, AUTO_READ_MAX_SCREENS, AUTO_READ_GAP_MIN_MS, AUTO_READ_GAP_MAX_MS, AUTO_READ_DRY_LIMIT,
  AUTO_READ_FLAT_SCREENS, AUTO_READ_FLAT_MS, fastPageStopReason,
  autoReadGapMs, autoReadBlockReason, createAutoReader, FAST_READ_PAGE_SIZE, FAST_READ_MAX_PAGES,
  FAST_READ_REMAINING_FLOOR, buildListPageRequest, bottomCursor, fastReadStopReason, createFastReader,
  isOwnListApiUrl
} from "../userscript/src/logic.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", message);
  }
}

function engineFrom(code, filename) {
  const sandbox = {console, Intl, Date, Math, Object, Array, String, Number, RegExp, JSON, isNaN, parseInt};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, {filename});
  return sandbox.FanAudit || sandbox.root.FanAudit;
}

const pageEngine = fs.readFileSync(path.join(root, "engine/fan_audit_engine.js"), "utf8");
const fan = engineFrom(pageEngine, "engine/fan_audit_engine.js");

const builtPath = path.join(root, "userscript/fan-audit.user.js");
const built = fs.readFileSync(builtPath, "utf8");
const bundled = built.match(/\/\* FAN_ENGINE_START \*\/\n([\s\S]*?)\n\/\* FAN_ENGINE_END \*\//);
check(!!bundled, "构建产物里有打分引擎");
const bundledEngine = bundled[1].replace(/\}\)\(root\);$/, '})(typeof globalThis !== "undefined" ? globalThis : this);');
check(bundledEngine.trim() === pageEngine.trim(), "打包进去的引擎和 engine/fan_audit_engine.js 是同一份");
const fanBuilt = engineFrom("var root = {};\n" + bundled[1], "userscript/fan-audit.user.js");
check(typeof fanBuilt.analyze === "function", "打包引擎可以运行");

check(classifyUrl("https://x.com/i/api/graphql/abc/UserRepliesTimeline?variables=1") === "replies", "回复时间线");
check(classifyUrl("https://x.com/i/api/graphql/abc/BlueVerifiedFollowers") === "blue-followers", "认证粉丝不是普通粉丝");
check(classifyUrl("https://x.com/i/api/graphql/abc/HomeTimeline") === "", "首页时间线不收");
check(classifyUrl("https://x.com/i/api/graphql/abc/DirectMessages") === "", "私信不收");
check(built.includes("GM_xmlhttpRequest") === false, "不使用 GM_xmlhttpRequest");
check(!new RegExp("(^|\\n)\\s*//\\s*" + "@" + "connect\\b").test(built), "没有 connect 授权");
check(built.includes("document.cookie") === false, "不读 cookie");
check(built.includes("nudgeOwnList"), "自动读取靠滚动页面本身");
check(built.includes("createAutoReader"), "自动读取有独立开关");
check(built.includes("脚本自己连续请求 X 的关注和粉丝列表接口") && built.includes("不想冒险就关掉，继续用手动滑动") && built.includes("也不会读别人的名单"), "风险提示原文在安装文件里");
check(built.includes("不封号") === false, "不写不封号");
check(built.split("不能保证安全").length === 2, "只写明不能保证安全，没有别的安全保证");
check(!/Bearer [A-Za-z0-9_\-.]{20,}/.test(built), "没有硬编码 Bearer 令牌");
check(built.includes(EMPTY_GUIDE), "空状态文案在安装文件里");
const meta = "// " + "@";
check(built.includes(meta + "version      0.3.1"), "版本号");
check(built.includes(meta + "sandbox      raw"), "要求页面环境");
check(built.includes(meta + "grant        GM_addElement"), "可以用元素注入把钩子送进页面");
check(built.includes(meta + "run-at       document-start"), "document-start");
check(built.includes(meta + "match        *://x.com/*"), "匹配 x.com");
check(built.includes(meta + "author       " + ("ranger" + "_escape")), "作者署名");
check(built.includes("https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js"), "更新地址指向 main 上的 raw 文件");
check(built.includes("fan-audit（油猴版）· GitHub 开源"), "面板页脚");
check(built.includes("https://github.com/ratt1e/Xfan-audit"), "仓库链接");
check(built.includes("Copyright (c) 2023 prin"), "保留上游 MIT 署名");
check(built.includes("function installHooks"), "钩子被打进安装文件");
check(built.includes("webpackChunk_twitter_responsive_web"), "自检保留上游用的页面环境标记");

const greeting = "早安";
check(textForStore(greeting) === greeting, "短问候原样保留");
const long = "早安" + "！".repeat(40) + "后面还有很多实质内容要说清楚才行呀";
const storedLong = textForStore(long);
check(storedLong.indexOf("补") >= 0 && storedLong.length > 30, "长文开头像问候时补上字数");
check(Array.from(snippet(long, 30)).length === 30, "正文截到 30 字");
check(storedLong.length < long.length, "不存全文");

const sample = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/userscript_sample.json"), "utf8"));
const store = emptyStore();
store.prefs.owner = sample.owner;
let keptSearchNoise = false;
sample.events.forEach(function (event) {
  const url = "https://x.com/i/api/graphql/hash/" + event.op + (event.query
    ? "?variables=" + encodeURIComponent(JSON.stringify({rawQuery: event.query, product: "Latest"}))
    : "");
  const captured = parseCapture(url, JSON.stringify(event.body), {owner: sample.owner});
  if (event.owner && event.owner !== sample.owner) {
    check(captured.skip !== "", "别人的列表要跳过");
    check(captured.users.length === 0, "别人的列表没有用户被收下");
  }
  applyCapture(store, captured, Date.parse("2026-10-22T00:00:00Z"));
  if (event.op === "SearchTimeline") {
    keptSearchNoise = Object.keys(store.posts).indexOf("1001008") >= 0;
  }
});
check(keptSearchNoise === false, "to:自己的搜索里，回给别人的帖子不入库");
check(store.posts["1001004"] == null, "纯转帖不入库");
check(store.posts["1002002"] == null, "详情页里不是回你的楼中楼不入库");
check(store.posts["1001001"] && store.posts["1001001"].text.length <= 46, "入库正文是短的");
check(store.posts["1001001"].replyTo === "1003001", "留下回复目标");
check(store.posts["1001001"].handle === "user_04", "留下对方用户名");
check(store.posts["1005001"].text.indexOf("补") >= 0, "夹具里的长文按短字段保存");
check(store.meta.sawFollowing && store.meta.sawFollowers && store.meta.sawBlueFollowers, "三类名单都见到了");
check(Object.keys(store.following).length === 3, "正在关注只有自己的三个人");
check(store.totals.followers === 20 && store.totals.following === 1, "自己的公开人数来自页面已经带回的字段");
check((store.totals.blue || 0) === 0, "没有认证粉丝公开总数时不编造");
const sampleReport = coverageReport(store, sample.owner, "UTC");
check(sampleReport.blueFollowers === 1, "认证粉丝按从那一页记下的人单独计数");
check(progressText(sampleReport.followers, sampleReport.totals.followers).indexOf("共约 20") >= 0, "粉丝进度用公开人数做分母");
check(progressText(1, 0) === "已记 1 / 总数待核实", "没有总数就不编造");
check(progressText(19, 20) === "已记 19 / 共约 20", "差一点不说差不多了");
check(progressText(20, 20).indexOf("差不多了") >= 0, "采齐了提示差不多了");
check(progressText(95, 100).indexOf("差不多了") >= 0 && progressText(94, 100).indexOf("差不多了") < 0, "超过 20 人沿用 95% 那条完整线");
check(!JSON.stringify(store).includes("user_11"), "没有混进别人的关注");

const data = toEngineData(store, sample.owner, fan.repliesFromTweets);
const result = fan.analyze(data, {me: sample.owner, days: 30, gapsAreEmpty: true, tz: "America/Los_Angeles"});
const builtData = toEngineData(store, sample.owner, fanBuilt.repliesFromTweets);
const builtResult = fanBuilt.analyze(builtData, {me: sample.owner, days: 30, gapsAreEmpty: true, tz: "America/Los_Angeles"});
function tierMap(rows) {
  const out = {};
  rows.forEach(function (row) { out[row.account] = row.tier; });
  return out;
}
const tiers = tierMap(result.rows);
check(JSON.stringify(tierMap(builtResult.rows)) === JSON.stringify(tiers), "网页引擎和打包引擎分层一致");
check(tiers.user_04 === "单向·他常来我少回", "user_04 单向");
check(tiers.user_05 === "单向·他常来我少回", "长文没有被当成问候所以仍是单向");
check(tiers.user_01 === "沉睡互关" && tiers.user_03 === "沉睡互关", "互关但没说话是沉睡互关");
check(tiers.user_02 === "零互动", "只关注、没互动是零互动");
check(tiers.user_08 === "样本不足", "只回过一句是样本不足");
check(tiers.user_09 == null && tiers.user_07 == null && tiers.user_11 == null, "无关账号不进分层");
const user01 = result.rows.filter(function (row) { return row.account === "user_01"; })[0];
check(user01 && user01.verified === true, "认证标记进了打分");
const user05 = result.rows.filter(function (row) { return row.account === "user_05"; })[0];
check(user05 && user05.greet_share === 0, "截短后的长文不算问候");
check(result.meta.interactionReady === true, "两边都有、并且跨了至少两天，才做互动分层");
check(result.meta.inboundDays >= 1 && result.meta.outboundDays >= 1 && result.meta.talkDays >= 2, "互动天数来自回复，不来自名单");
check(result.meta.covered === 3, "有数据的天数是 3");
check(result.meta.uncovered === 27, "没数据的天数不进覆盖");
check(result.meta.tz === "America/Los_Angeles", "时区按传入的算");
const back = fan.notFollowedBack(data, result.rows);
check(back && back.ready && back.items.length === 1 && back.items[0].handle === "user_02", "没回关只有 user_02");
const masked = fan.boardHtml(result.rows, {masked: true});
const open = fan.boardHtml(result.rows, {masked: false});
check(masked.includes("账号#01") && masked.includes("https://x.com/") === false, "打码换成编号并去掉主页链接");
check(open.includes("https://x.com/user_04") || open.includes("https://x.com/user_01"), "不打码时账号链到主页");
check(masked.includes("user_0") === false, "打码结果里没有用户名");

const report = coverageReport(store, sample.owner, "America/Los_Angeles");
check(report.inbound === 6 && report.inboundDays === 3, "别人回我覆盖 3 天");
check(report.outbound === 1 && report.outboundDays === 1, "我发出的回复单独计数");
check(report.srcDays.replies === 3 && report.srcDays.originals === 3 && report.srcDays.detail === 1, "按来源算天数");

const old = emptyStore();
old.posts["1009001"] = {id: "1009001", uid: "1000099", handle: "user_06", name: "演示己", verified: false, replyTo: "1", replyToHandle: "demo_owner", conv: "1", ts: "2020-01-01T00:00:00.000Z", text: "旧", src: "replies", seen: Date.parse("2020-01-02T00:00:00Z")};
old.following["id:1000098"] = {id: "1000098", handle: "user_06", name: "演示己", verified: false, followers: 1, seen: Date.parse("2020-01-02T00:00:00Z")};
prune(old, Date.parse("2026-10-22T00:00:00Z"));
check(Object.keys(old.posts).length === 0 && Object.keys(old.following).length === 0, "超过 " + RETENTION_DAYS + " 天的记录会删");

const backup = exportBackup(store, Date.parse("2026-10-22T00:00:00Z"));
check(backup.includes("tweet_results") === false, "备份不是原始响应");
const restored = importBackup(backup);
check(Object.keys(restored.posts).length === Object.keys(store.posts).length, "备份可以导回");
let rejected = false;
try {
  const bad = {v: 1, posts: {}};
  bad["auth" + "_token"] = "abcdefghijklmnop";
  importBackup(JSON.stringify(bad));
} catch (err) { rejected = true; }
check(rejected, "带 token 字段的备份会被拒绝");

const bare = {XMLHttpRequest: function () {}, fetch: function () {}};
bare.XMLHttpRequest.prototype = {open: function () {}, send: function () {}};
const warn = contextProblems({page: bare, hookedOpen: function () {}, sawPageApp: false});
check(warn.some(function (item) { return item.level === "error" && item.text.indexOf("XHR") >= 0; }), "钩子不在页面 XHR 上时要报错");
check(warn.some(function (item) { return item.text.indexOf("CSP") >= 0 || item.text.indexOf("沙箱") >= 0; }), "自检提到 CSP 或沙箱");
check(contextProblems({page: null})[0].level === "error", "没有 unsafeWindow 时报错");

function makePage() {
  function XHR() { this.listeners = {}; this.status = 200; this.responseText = ""; }
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  XHR.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
  const page = {
    XMLHttpRequest: XHR,
    fetchCalls: 0,
    bodies: {},
    fetch: function (input) {
      page.fetchCalls += 1;
      const key = typeof input === "string" ? input : "";
      const text = page.bodies[key] || "";
      return Promise.resolve({ok: true, clone: function () { return {text: function () { return Promise.resolve(text); }}; }});
    }
  };
  return page;
}
const page = makePage();
const seen = [];
const hooks = installHooks(page, function (url, text) { seen.push(url + " " + text.length); });
check(page.fetchCalls === 0, "安装钩子本身不发请求");
const xhr = new page.XMLHttpRequest();
xhr.open("GET", "https://x.com/i/api/graphql/hash/Following");
xhr.responseText = JSON.stringify(sample.events[0].body);
xhr.send("ignored");
xhr.listeners.load.forEach(function (fn) { fn(); });
check(seen.length === 1, "XHR load 时读到页面自己的响应");
const quiet = new page.XMLHttpRequest();
quiet.open("GET", "https://x.com/i/api/1.1/jot/client_event");
quiet.responseText = "{}";
quiet.send(null);
if (quiet.listeners.load) quiet.listeners.load.forEach(function (fn) { fn(); });
check(seen.length === 1 && !quiet.listeners.load, "非 GraphQL 地址不读、也不挂监听");
const fetchUrl = "https://x.com/i/api/graphql/hash/Followers";
page.bodies[fetchUrl] = JSON.stringify(sample.events[1].body);
await page.fetch(fetchUrl);
await new Promise(function (resolve) { setTimeout(resolve, 0); });
check(seen.length === 2, "fetch 兜底也能读到响应");
check(page.fetchCalls === 1, "fetch 兜底没有多打一次请求");
check(page.XMLHttpRequest.prototype.open === hooks.hookedOpen, "钩子挂在页面的 XMLHttpRequest 上");
const fine = contextProblems({page: page, hookedOpen: hooks.hookedOpen, sawPageApp: true});
check(fine.length === 0, "页面环境和钩子都在时自检通过");

const home = new page.XMLHttpRequest();
home.open("GET", "https://x.com/i/api/graphql/hash/HomeTimeline");
home.responseText = "{\"data\":{\"user_01\":true}}";
home.send(null);
home.listeners.load.forEach(function (fn) { fn(); });
check(seen.length === 3 && seen[2].indexOf("HomeTimeline") >= 0 && seen[2].endsWith(" 0"), "未识别的 GraphQL 只记操作名，不读正文");
check(seen[2].indexOf("user_01") < 0, "未识别响应的正文不会交给上层");
const notesXhr = new page.XMLHttpRequest();
notesXhr.open("GET", "https://x.com/i/api/2/notifications/all.json?cursor=1");
notesXhr.responseText = "{\"globalObjects\":{\"tweets\":{}}}";
notesXhr.send(null);
check(notesXhr.listeners && notesXhr.listeners.load && notesXhr.listeners.load.length === 1, "通知 REST 会挂上 load 监听");
notesXhr.listeners.load.forEach(function (fn) { fn(); });
check(seen.length === 4 && seen[3].indexOf("/notifications/all.json") >= 0 && !seen[3].endsWith(" 0"), "通知 REST 会读响应正文");
const profileXhr = new page.XMLHttpRequest();
profileXhr.open("GET", "https://x.com/i/api/graphql/hash/UserByScreenName");
profileXhr.responseText = "{\"data\":{\"user\":{}}}";
profileXhr.send(null);
profileXhr.listeners.load.forEach(function (fn) { fn(); });
check(seen.length === 5 && seen[4].indexOf("UserByScreenName") >= 0 && !seen[4].endsWith(" 0"), "资料接口会读人数");
check(pageHookProgram().indexOf("UserByScreenName") >= 0 && pageHookProgram().indexOf("UserByRestId") >= 0, "钩子名单里有资料接口");

function ThrowingXHR() { this.listeners = {}; this.status = 200; this.response = {data: {ok: 1}}; }
ThrowingXHR.prototype.open = function () {};
ThrowingXHR.prototype.send = function () {};
ThrowingXHR.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
Object.defineProperty(ThrowingXHR.prototype, "responseText", {get: function () { throw new Error("json"); }});
const jsonPage = {XMLHttpRequest: ThrowingXHR, fetch: function () { return Promise.resolve({ok: true, clone: function () { return {text: function () { return Promise.resolve(""); }}; }}); }};
const jsonSeen = [];
installHooks(jsonPage, function (url, text) { jsonSeen.push(text); });
const jsonXhr = new jsonPage.XMLHttpRequest();
jsonXhr.open("GET", "https://x.com/i/api/graphql/hash/Followers");
jsonXhr.send(null);
jsonXhr.listeners.load.forEach(function (fn) { fn(); });
check(jsonSeen.length === 1 && jsonSeen[0].indexOf("\"ok\":1") >= 0, "responseText 读不到时改读 JSON 响应");

const urlPage = makePage();
const urlSeen = [];
installHooks(urlPage, function (url, text) { urlSeen.push(url + " " + text.length); });
const followersUrl = "https://x.com/i/api/graphql/hash/Followers";
urlPage.bodies[followersUrl] = "{\"ok\":true}";
await urlPage.fetch({href: followersUrl});
await new Promise(function (resolve) { setTimeout(resolve, 0); });
check(urlSeen.length === 1 && urlSeen[0].indexOf(followersUrl) === 0, "fetch 的 URL 对象也能读到地址");

const early = parseCapture("https://x.com/i/api/graphql/hash/Followers", JSON.stringify(sample.events[1].body), {owner: ""});
check(early.skip === "还不知道你的用户名" && early.users.length === 0, "还不知道用户名时先不要收下粉丝");
const later = parseCapture("https://x.com/i/api/graphql/hash/Followers", JSON.stringify(sample.events[1].body), {owner: sample.owner});
check(later.skip === "" && later.users.length > 0, "知道用户名之后同一份响应能收下");

const moved = JSON.parse(JSON.stringify(sample.events[1].body));
moved.data.user.result.timeline_v2 = moved.data.user.result.timeline;
delete moved.data.user.result.timeline;
const movedCap = parseCapture("https://x.com/i/api/graphql/hash/Followers", JSON.stringify(moved), {owner: sample.owner});
check(movedCap.skip === "" && movedCap.users.length > 0, "时间线改到 timeline_v2 仍能收下");

check(listKindFromPath("/demo_owner/verified_followers", "demo_owner") === "blue-followers", "认证粉丝页路径");
check(listKindFromPath("/user_02/followers", "demo_owner") === "", "别人的粉丝页不算自己的名单");
check(listKindFromPath("/demo_owner/followers", "") === "", "没有用户名时不从路径猜");
const visible = userFromVisible(["/user_12"], "演示甲\n@user_12", true);
check(visible && visible.handle === "user_12" && visible.verified === true && visible.id === "", "页面格子只留下短字段");
const domStore = emptyStore();
domStore.prefs.owner = "demo_owner";
applyCapture(domStore, {kind: "followers", skip: "", posts: [], users: [visible]}, Date.parse("2026-10-22T00:00:00Z"));
applyCapture(domStore, {kind: "followers", skip: "", posts: [], users: [{id: "1000012", handle: "user_12", name: "演示甲", verified: true, followers: 3}]}, Date.parse("2026-10-22T00:00:00Z"));
check(Object.keys(domStore.followers).length === 1 && domStore.followers["id:1000012"].followers === 3, "格子和接口里的同一个人合成一条");

const copied = diagnosticsCopy({
  hook: "page-script",
  world: "raw",
  sameRealm: false,
  pageApp: true,
  graphqlSeen: 3,
  matched: {Followers: 2, BlueVerifiedFollowers: 1},
  unmatched: ["HomeTimeline", "user_01"],
  domAccepted: 4,
  ownerDetected: true,
  storedPosts: 0,
  storedFollowing: 1,
  storedFollowers: 4,
  skips: {"还不知道你的用户名": 1, "demo_owner": 2}
});
check(copied.indexOf("Followers=2") >= 0 && copied.indexOf("BlueVerifiedFollowers=1") >= 0, "诊断复制件有接口次数");
check(copied.indexOf("HomeTimeline") >= 0 && copied.indexOf("user_01") < 0 && copied.indexOf("demo_owner") < 0 && copied.indexOf("@") < 0, "诊断复制件丢掉账号名");
check(copied.indexOf("ownerDetected=yes") >= 0, "诊断只报告有没有认出用户名");
const byOp = diagnosticsCopy({
  hook: "page",
  world: "raw",
  sameRealm: true,
  pageApp: true,
  graphqlSeen: 9,
  matched: {UserRepliesTimeline: 7},
  unmatched: [],
  skipsByOp: {
    UserRepliesTimeline: {"不是你的主页时间线": 7},
    ProfileSpotlightsQuery: {"不在采集名单": 12},
    user_01: {"demo_owner": 2}
  }
});
check(byOp.indexOf("UserRepliesTimeline:不是你的主页时间线=7") >= 0, "跳过按接口拆开");
check(byOp.indexOf("ProfileSpotlightsQuery:不在采集名单=12") >= 0, "不在名单的接口单独计数");
check(byOp.indexOf("user_01") < 0 && byOp.indexOf("demo_owner") < 0, "按接口拆开的诊断也不带账号名");

const events = [];
const hookPage = makePage();
const sandbox = {
  URL: URL,
  JSON: JSON,
  Promise: Promise,
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  document: {
    documentElement: {setAttribute: function () {}, getAttribute: function () { return "page"; }},
    dispatchEvent: function (event) { events.push(event); }
  }
};
sandbox.window = sandbox;
sandbox.XMLHttpRequest = hookPage.XMLHttpRequest;
sandbox.fetch = hookPage.fetch;
vm.runInContext(pageHookProgram(), vm.createContext(sandbox), {filename: "page-hook.js"});
check(sandbox.__fanAuditPageHook === 1, "页面钩子脚本能执行");
check(pageHookProgram().indexOf("document.cookie") < 0 && pageHookProgram().indexOf("GM_") < 0, "注进页面的钩子不读 cookie、不用 GM");
const hookedXhr = new sandbox.XMLHttpRequest();
hookedXhr.open("GET", "https://x.com/i/api/graphql/hash/Following");
hookedXhr.responseText = "{\"data\":{}}";
hookedXhr.send(null);
hookedXhr.listeners.load.forEach(function (fn) { fn(); });
check(events.length === 1 && events[0].detail.url.indexOf("Following") >= 0 && events[0].detail.text.indexOf("data") >= 0, "页面里的钩子用事件把响应交回来");
check(operationName(events[0].detail.url) === "Following", "事件里能取出操作名");

const maskedNames = fan.boardHtml(result.rows, {masked: true});
check(maskedNames.split("tier-").length > 2, "分层卡片还在");
check(maskedNames.indexOf("color:#1F2937") < 0, "看板片段本身不写死颜色，颜色在样式里");
check(built.indexOf(".num{font-size:32px;font-weight:700;color:#1F2937}") >= 0, "分层数字用深色，不靠按钮默认字色");
check(built.indexOf("别人回我") >= 0 && built.indexOf("f=live") >= 0 && built.indexOf("别一次翻太久") >= 0, "采集清单和限流说明在安装文件里");
check(built.indexOf("诊断信息") >= 0 && built.indexOf("全屏") >= 0 && built.indexOf("退出全屏") >= 0, "诊断可折叠，面板可全屏");
check(built.indexOf("https://x.com/notifications/mentions") >= 0, "通知清单指向提及页");
check(built.indexOf("GM_openInTab") < 0 && built.indexOf("GM_xmlhttpRequest") < 0, "不用 GM_openInTab 或 GM_xmlhttpRequest");

check(timelineKindFromPath("/demo_owner/with_replies", "demo_owner") === "replies", "主页回复页路径");
check(timelineKindFromPath("/demo_owner", "demo_owner") === "originals", "自己的主页路径");
check(timelineKindFromPath("/demo_owner/followers", "demo_owner") === "", "粉丝页不是主页时间线");
check(classifyUrl("https://x.com/i/api/graphql/hash/NotificationsTimeline") === "notifications", "通知时间线在采集名单里");
check(classifyUrl("https://x.com/i/api/graphql/hash/NotificationsMentionsTimeline") === "notifications", "提及时间线名字也能认");
check(operationName("https://x.com/i/api/2/notifications/all.json?cursor=1") === "NotificationsAll", "all.json 记成 NotificationsAll");
check(operationName("https://x.com/i/api/2/notifications/mentions.json") === "NotificationsMentions", "mentions.json 记成 NotificationsMentions");
check(classifyUrl("https://x.com/i/api/2/notifications/mentions.json") === "notifications", "提及 REST 在采集名单里");
check(pageContext("/demo_owner/followers", "", "demo_owner").label === "粉丝", "粉丝页角标");
check(pageContext("/demo_owner/verified_followers", "", "demo_owner").kind === "followers", "认证粉丝页也算粉丝");
check(pageContext("/demo_owner/following", "", "demo_owner").label === "关注", "关注页角标");
check(pageContext("/demo_owner/with_replies", "", "demo_owner").label === "主页回复", "主页回复页角标");
check(pageContext("/search", "?q=" + encodeURIComponent("to:demo_owner") + "&f=live", "demo_owner").label === "别人回我", "别人回我搜索页角标");
check(pageContext("/notifications", "", "demo_owner").label === "通知" && pageContext("/notifications/mentions", "", "demo_owner").kind === "notifications", "通知页角标");
check(pageContext("/user_09/followers", "", "demo_owner").label === "" && pageContext("/home", "", "demo_owner").label === "", "别人的粉丝页和首页不显示数量");
check(badgeText("", 4625, 0) === "", "没有对应页面时角标不加总条数");
check(badgeText("粉丝", 559, 559) === " 粉丝 559" && badgeText("粉丝", 561, 559) === " 粉丝 561 +2", "角标带本页数量和这一轮新增");

function bareTweet(id, handle, uid, text, replyTo, replyToHandle, created) {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: {user_results: {result: {__typename: "User", rest_id: uid, core: {name: handle, screen_name: handle}}}},
    legacy: {
      id_str: id,
      full_text: text,
      created_at: created,
      in_reply_to_status_id_str: replyTo || null,
      in_reply_to_screen_name: replyToHandle || null,
      conversation_id_str: replyTo || id
    }
  };
}
function repliesPayload(screenName) {
  const person = {__typename: "User", rest_id: "1000001", core: {name: "演示主人"}};
  if (screenName) person.core.screen_name = screenName;
  person.timeline = {timeline: {instructions: [{type: "TimelineAddEntries", entries: [{
    entryId: "profile-conversation-1008001",
    content: {
      entryType: "TimelineTimelineModule",
      items: [
        {entryId: "profile-conversation-1008001-tweet-1008001", item: {itemContent: {tweet_results: {result: bareTweet("1008001", "user_09", "1000009", "父帖正文不是回复", "", "", "Sun Oct 18 16:00:00 +0000 2026")}}}},
        {entryId: "profile-conversation-1008001-tweet-1008002", item: {itemContent: {tweet_results: {result: bareTweet("1008002", "demo_owner", "1000001", "这是认真回复父帖的一句", "1008001", "user_09", "Mon Oct 19 16:00:00 +0000 2026")}}}}
      ]
    }
  }]}]}};
  return {data: {user: {result: person}}};
}
const nameless = parseCapture("https://x.com/i/api/graphql/hash/UserRepliesTimeline", JSON.stringify(repliesPayload("")), {owner: "demo_owner", pagePath: "/demo_owner/with_replies"});
check(nameless.skip === "" && nameless.posts.length === 2, "主页用户对象没有用户名时，用当前回复页路径收下");
const parent = nameless.posts.filter(function (post) { return post.id === "1008001"; })[0];
const mine = nameless.posts.filter(function (post) { return post.id === "1008002"; })[0];
check(parent && !parent.replyTo && mine && mine.replyTo === "1008001" && mine.replyToHandle === "user_09", "对话模块留下父帖和自己的回复目标");
const moduleRows = fan.repliesFromTweets(nameless.posts.map(function (post) {
  return {id: post.id, screen_name: post.handle, in_reply_to: post.replyTo, in_reply_to_screen_name: post.replyToHandle, created_at: post.ts, full_text: post.text, conversation_id: post.conv};
}), "demo_owner");
check(moduleRows.length === 1 && moduleRows[0].direction === "out" && moduleRows[0].account === "user_09", "父帖不算别人回我，只记自己发出的回复");
const namedOther = parseCapture("https://x.com/i/api/graphql/hash/UserRepliesTimeline", JSON.stringify(repliesPayload("user_09")), {owner: "demo_owner", pagePath: "/demo_owner/with_replies"});
check(namedOther.skip === "不是你的主页时间线" && namedOther.posts.length === 0, "响应里写明是别人的主页时仍然跳过");
const wrongPath = parseCapture("https://x.com/i/api/graphql/hash/UserRepliesTimeline", JSON.stringify(repliesPayload("")), {owner: "demo_owner", pagePath: "/user_09/with_replies"});
check(wrongPath.skip === "不是你的主页时间线", "没有用户名、路径也不是自己的回复页时跳过");
const fromVars = "https://x.com/i/api/graphql/hash/UserRepliesTimeline?variables=" + encodeURIComponent(JSON.stringify({screen_name: "demo_owner"}));
const namedByRequest = parseCapture(fromVars, JSON.stringify(repliesPayload("")), {owner: "demo_owner", pagePath: ""});
check(namedByRequest.skip === "" && namedByRequest.posts.length === 2, "请求参数里的用户名可以补上主页时间线");

const notice = {data: {viewer_v2: {user_results: {result: {notification_timeline: {timeline: {instructions: [{type: "TimelineAddEntries", entries: [
  {entryId: "notification-1", content: {itemContent: {tweet_results: {result: bareTweet("1008101", "user_04", "1000005", "回复了你的帖", "1003001", "demo_owner", "Tue Oct 20 16:00:00 +0000 2026")}}}},
  {entryId: "notification-2", content: {itemContent: {tweet_results: {result: bareTweet("1008102", "user_03", "1000004", "这是别人之间的回复", "1008109", "user_05", "Tue Oct 20 16:00:00 +0000 2026")}}}}
]}]}}}}}}};
const noted = parseCapture("https://x.com/i/api/graphql/hash/NotificationsTimeline", JSON.stringify(notice), {owner: "demo_owner"});
check(noted.skip === "" && noted.posts.length === 1 && noted.posts[0].id === "1008101" && noted.posts[0].src === "notifications", "通知里只留下回复你的那条");

function noteEntry(id, content) {
  return {entryId: "notification-" + id, content: {itemContent: content}};
}
function noteTimeline(entries) {
  return {data: {viewer_v2: {user_results: {result: {notification_timeline: {timeline: {instructions: [{type: "TimelineAddEntries", entries: entries}]}}}}}}};
}
const shaped = parseCapture(
  "https://x.com/i/api/graphql/hash/NotificationsTimeline?variables=" + encodeURIComponent(JSON.stringify({timeline_type: "Mentions", count: 20})),
  JSON.stringify(noteTimeline([
    noteEntry("a", {__typename: "TimelineNotification", itemType: "TimelineNotification", notification_icon: "reply", template: {target_objects: [{tweet_results: {result: bareTweet("1008201", "user_04", "1000005", "从模板里回复你", "1003001", "demo_owner", "Wed Oct 21 16:00:00 +0000 2026")}}]}}),
    noteEntry("b", {__typename: "TimelineNotification", itemType: "TimelineNotification", notification_icon: "mention", template: {target_objects: [bareTweet("1008205", "user_06", "1000006", "提及并回复你", "1003002", "demo_owner", "Wed Oct 21 17:00:00 +0000 2026")]}}),
    noteEntry("c", {__typename: "TimelineNotificationAggregateUserActions", itemType: "TimelineNotificationAggregateUserActions", notification_icon: "heart", template: {target_objects: [{tweet_results: {result: bareTweet("1008202", "user_04", "1000005", "赞了你的回复", "1003001", "demo_owner", "Wed Oct 21 16:00:00 +0000 2026")}}]}}),
    noteEntry("d", {__typename: "TimelineNotification", itemType: "TimelineNotification", notification_icon: "person", template: {from_users: [{rest_id: "1000008"}]}}),
    noteEntry("e", {__typename: "TimelineNotificationAggregateUserActions", itemType: "TimelineNotificationAggregateUserActions", notification_icon: "retweet", template: {target_objects: [{tweet_results: {result: bareTweet("1008203", "demo_owner", "1000001", "你的原帖被转发", "", "", "Wed Oct 21 16:00:00 +0000 2026")}}]}}),
    noteEntry("f", {__typename: "TimelineNotification", itemType: "TimelineNotification", notification_icon: "reply", template: {target_objects: [{tweet_results: {result: bareTweet("1008204", "user_03", "1000004", "回复了别人", "1008209", "user_05", "Wed Oct 21 16:00:00 +0000 2026")}}]}})
  ])),
  {owner: "demo_owner"}
);
const shapedIds = shaped.posts.map(function (post) { return post.id; }).sort();
check(shaped.skip === "" && shapedIds.join(",") === "1008201,1008205", "通知 GraphQL 只留下回复你的帖子，赞和转发丢掉");

function restNote(icon, tweetId, userId) {
  return {icon: {id: icon}, template: {aggregateUserActionsV1: {fromUsers: [{user: {id: userId}}], targetObjects: [{tweet: {id: tweetId}}]}}};
}
const restBody = {
  globalObjects: {
    tweets: {
      "1008301": {id_str: "1008301", full_text: "REST 回复你", user_id_str: "1000005", in_reply_to_status_id_str: "1003001", in_reply_to_screen_name: "demo_owner", created_at: "Thu Oct 22 16:00:00 +0000 2026", conversation_id_str: "1003001"},
      "1008302": {id_str: "1008302", full_text: "被赞的帖", user_id_str: "1000001", created_at: "Thu Oct 22 16:00:00 +0000 2026"},
      "1008303": {id_str: "1008303", full_text: "被转发的帖", user_id_str: "1000001", created_at: "Thu Oct 22 16:00:00 +0000 2026"},
      "1008304": {id_str: "1008304", full_text: "只是提及不是回复", user_id_str: "1000007", created_at: "Thu Oct 22 16:00:00 +0000 2026"}
    },
    users: {
      "1000005": {id_str: "1000005", screen_name: "user_04", name: "甲"},
      "1000007": {id_str: "1000007", screen_name: "user_06", name: "乙"}
    },
    notifications: {
      R1: restNote("reply", "1008301", "1000005"),
      R2: restNote("heart", "1008302", "1000005"),
      R3: restNote("retweet", "1008303", "1000008"),
      R4: restNote("person", "1008302", "1000008"),
      R5: restNote("mention", "1008304", "1000007")
    }
  }
};
const restCap = parseCapture("https://x.com/i/api/2/notifications/mentions.json", JSON.stringify(restBody), {owner: "demo_owner"});
check(restCap.posts.length === 1 && restCap.posts[0].id === "1008301" && restCap.posts[0].handle === "user_04" && restCap.posts[0].src === "notifications", "REST 通知只留下回复你的那条");
const likesOnly = parseCapture("https://x.com/i/api/2/notifications/all.json", JSON.stringify({globalObjects: {tweets: {"1008302": restBody.globalObjects.tweets["1008302"]}, users: {}, notifications: {H1: restNote("heart", "1008302", "1000005")}}}), {owner: "demo_owner"});
const likeStore = emptyStore();
check(likesOnly.posts.length === 0 && applyCapture(likeStore, likesOnly, Date.parse("2026-10-22T00:00:00Z")) && likeStore.meta.sawNotifications === true && Object.keys(likeStore.posts).length === 0, "只有赞的通知页算打开过，但不入库");

function searchWrap(tweet) {
  return {data: {search_by_raw_query: {search_timeline: {timeline: {instructions: [{type: "TimelineAddEntries", entries: [{entryId: "tweet-" + tweet.rest_id, content: {itemContent: {tweet_results: {result: tweet}}}}]}]}}}}};
}
const searchUrl = "https://x.com/i/api/graphql/hash/SearchTimeline?variables=" + encodeURIComponent(JSON.stringify({rawQuery: "to:demo_owner", product: "Latest"}));
const sharedTweet = bareTweet("1008101", "user_04", "1000005", "回复了你的帖", "1003001", "demo_owner", "Tue Oct 20 16:00:00 +0000 2026");
const searchCap = parseCapture(searchUrl, JSON.stringify(searchWrap(sharedTweet)), {owner: "demo_owner"});
const dedupeStore = emptyStore();
applyCapture(dedupeStore, searchCap, Date.parse("2026-10-22T00:00:00Z"));
applyCapture(dedupeStore, noted, Date.parse("2026-10-22T00:00:01Z"));
const deduped = coverageReport(dedupeStore, "demo_owner", "UTC");
check(Object.keys(dedupeStore.posts).length === 1 && dedupeStore.posts["1008101"].src === "search" && deduped.srcCount.search === 1 && deduped.srcCount.notifications === 0 && deduped.sawNotifications === true && deduped.inbound === 1, "同一条帖子搜索和通知只留一份，来源用先看到的");
const noteFirst = emptyStore();
applyCapture(noteFirst, noted, Date.parse("2026-10-22T00:00:00Z"));
applyCapture(noteFirst, searchCap, Date.parse("2026-10-22T00:00:01Z"));
check(Object.keys(noteFirst.posts).length === 1 && noteFirst.posts["1008101"].src === "notifications", "先从通知看到的帖子不会被搜索覆盖来源");

function absenceOpts(rows) {
  return fan.analyze({
    rows: rows,
    following: {user_01: {handle: "user_01"}, user_02: {handle: "user_02"}},
    followers: {user_01: {handle: "user_01"}},
    profiles: {}
  }, {me: "demo_owner", end: "2026-10-19", days: 30, gapsAreEmpty: true, tz: "America/Los_Angeles"});
}
const listsOnly = absenceOpts([]);
check(listsOnly.meta.interactionReady === false && listsOnly.meta.talkDays === 0, "只有名单时互动分层不启用");
check(listsOnly.meta.inboundDays === 0 && listsOnly.meta.outboundDays === 0, "名单不算互动天数");
check(listsOnly.rows.every(function (row) {
  return row.tier !== "沉睡互关" && row.tier !== "零互动" && row.tier.indexOf("单向") !== 0;
}), "只有名单时不标沉睡、零互动或单向");
const mutualOnly = listsOnly.rows.filter(function (row) { return row.account === "user_01"; })[0];
check(mutualOnly && mutualOnly.mutual === true, "互关仍然算得出来");
const thinHtml = fan.boardHtml(listsOnly.rows, {interactionReady: false, interactionNote: listsOnly.meta.interactionNote, extras: [{id: "not-followed-back", count: "1", label: "没回关"}]});
check(thinHtml.indexOf('data-jump="沉睡互关"') < 0 && thinHtml.indexOf("不急着取关") < 0 && thinHtml.indexOf('id="tier-') < 0, "名单不足时看板不写沉睡互关");
check(thinHtml.indexOf("互动数据还不够") >= 0 && thinHtml.indexOf("互关") >= 0 && thinHtml.indexOf("没回关") >= 0, "看板留下互关和没回关，并说明互动不够");
const outboundOnly = absenceOpts([
  {id: "a", tweet_id: "1", ts: "2026-10-17T16:00:00Z", account: "user_01", direction: "out", type: "reply", text: "第一句认真回复"},
  {id: "b", tweet_id: "2", ts: "2026-10-18T16:00:00Z", account: "user_01", direction: "out", type: "reply", text: "第二句认真回复"},
  {id: "c", tweet_id: "3", ts: "2026-10-19T16:00:00Z", account: "user_01", direction: "out", type: "reply", text: "第三句认真回复"}
]);
check(outboundOnly.meta.interactionReady === false && outboundOnly.meta.outboundDays === 3 && outboundOnly.meta.inboundDays === 0, "只有我发出的回复时还不够");
check(outboundOnly.rows.every(function (row) { return row.tier.indexOf("单向") !== 0 && row.tier !== "沉睡互关"; }), "缺了别人回我就不标单向或沉睡");
const sameDay = absenceOpts([
  {id: "d", tweet_id: "4", ts: "2026-10-19T16:00:00Z", account: "user_01", direction: "out", type: "reply", text: "同一天发出的回复"},
  {id: "e", tweet_id: "5", ts: "2026-10-19T18:00:00Z", account: "user_01", direction: "in", type: "reply", text: "同一天别人的回复"}
]);
check(sameDay.meta.interactionReady === false && sameDay.meta.talkDays === 1 && sameDay.meta.inboundDays === 1 && sameDay.meta.outboundDays === 1, "两边挤在同一天仍然太薄");
const enough = absenceOpts([
  {id: "f", tweet_id: "6", ts: "2026-10-18T16:00:00Z", account: "user_02", direction: "out", type: "reply", text: "前一天发出的回复"},
  {id: "g", tweet_id: "7", ts: "2026-10-19T16:00:00Z", account: "user_02", direction: "in", type: "reply", text: "后一天别人的回复"}
]);
const quietMutual = enough.rows.filter(function (row) { return row.account === "user_01"; })[0];
check(enough.meta.interactionReady === true && quietMutual && quietMutual.tier === "沉睡互关", "两边跨了两天才把没说话的互关标成沉睡");

check(listIsComplete(0, 0) === false && listIsComplete(2, 0) === false, "不知道资料人数时不算完整");
check(listIsComplete(2, 3) === false && listIsComplete(3, 3) === true && listIsComplete(20, 20) === true, "20 人及以下必须正好采齐");
check(listIsComplete(19, 21) === false && listIsComplete(20, 21) === true, "超过 20 人至少要到 95%");
check(exportTimeFromName("twitter-正在关注-1792582202463.json", 5) === 1792582202463, "文件名里的 13 位毫秒是导出时间");
check(exportTimeFromName("twitter-关注者-1792582202.json", 5) === 1792582202000, "文件名里的 10 位秒会换成毫秒");
check(exportTimeFromName("notes.json", 5) === 5 && exportTimeFromName("x-123.json", 5) === 5, "对不上的数字不用");
check(headerListCount("/demo_owner/verified_followers", "12", "demo_owner") == null, "认证粉丝页头不算全部粉丝");
check(headerVerifiedCount("/demo_owner/verified_followers", "12 Verified", "demo_owner") === 12, "认证粉丝页头的精确人数单独记下");
check(headerVerifiedCount("/demo_owner/verified_followers", "1.2K", "demo_owner") === 0, "认证粉丝缩写人数不用");
check(headerVerifiedCount("/user_02/verified_followers", "12", "demo_owner") === 0, "别人的认证粉丝人数不采用");
check(headerListCount("/demo_owner/followers", "1.2K Followers", "demo_owner") == null, "缩写人数不用来判断采全没有");
check(headerListCount("/user_02/followers", "10", "demo_owner") == null, "别人主页上的人数不采用");
const headerCount = headerListCount("/demo_owner/following", "1,234 Following", "demo_owner");
check(headerCount && headerCount.kind === "following" && headerCount.count === 1234, "页头上的精确人数能用");

const countBody = JSON.stringify({data: {user: {result: {legacy: {screen_name: "demo_owner", followers_count: 3, friends_count: 2}}}}});
const countCap = parseCapture("https://x.com/i/api/graphql/hash/UserByScreenName", countBody, {owner: "demo_owner"});
check(classifyUrl("https://x.com/i/api/graphql/hash/UserByRestId") === "counts", "UserByRestId 是人数");
check(countCap.kind === "counts" && countCap.counts.followers === 3 && countCap.counts.following === 2, "资料响应里有粉丝数和关注数");
const countStore = emptyStore();
countStore.prefs.owner = "demo_owner";
applyCapture(countStore, countCap, Date.parse("2026-10-22T00:00:00Z"));
const otherCounts = parseCapture("https://x.com/i/api/graphql/hash/UserByScreenName", JSON.stringify({data: {user: {result: {legacy: {screen_name: "user_09", followers_count: 99, friends_count: 88}}}}}), {owner: "demo_owner"});
applyCapture(countStore, otherCounts, Date.parse("2026-10-22T00:00:00Z"));
check(countStore.totals.followers === 3 && countStore.totals.following === 2, "只有自己的资料会改人数");
const metricBody = JSON.stringify({data: {user: {result: {core: {screen_name: "demo_owner"}, public_metrics: {followers_count: 40, following_count: 15, verified_followers_count: 7}}}}});
const metricCap = parseCapture("https://x.com/i/api/graphql/hash/UserByScreenName", metricBody, {owner: "demo_owner"});
check(metricCap.counts && metricCap.counts.followers === 40 && metricCap.counts.following === 15 && metricCap.counts.blue === 7, "public_metrics 里的粉丝、关注和认证粉丝人数能用");
applyCapture(countStore, metricCap, Date.parse("2026-10-22T00:00:00Z"));
check(countStore.totals.followers === 40 && countStore.totals.following === 15 && countStore.totals.blue === 7, "自己的 public_metrics 会改人数");
const otherMetric = parseCapture("https://x.com/i/api/graphql/hash/UserByScreenName", JSON.stringify({data: {user: {result: {core: {screen_name: "user_09"}, public_metrics: {followers_count: 9, following_count: 8, verified_followers_count: 6}}}}}), {owner: "demo_owner"});
applyCapture(countStore, otherMetric, Date.parse("2026-10-22T00:00:00Z"));
check(countStore.totals.blue === 7, "别人的 public_metrics 不改人数");

function snapPerson(id, handle) { return {id: id, handle: handle, name: handle}; }
const snapStore = emptyStore();
recordSnapshot(snapStore, "followers", [snapPerson("1000002", "user_02"), snapPerson("1000003", "user_03")], Date.parse("2026-09-01T00:00:00Z"), false, "page", "");
check(snapshotDiffInput(snapStore) == null, "只有未完整快照时不出现关注变化");
recordSnapshot(snapStore, "followers", [snapPerson("1000002", "user_02"), snapPerson("1000003", "user_03")], Date.parse("2026-10-01T00:00:00Z"), true, "export", "twitter-关注者-1790000000000.json");
const waiting = snapshotDiffInput(snapStore);
const waitingDiff = fan.followDiff(waiting);
check(waiting && waiting.followAuto.waiting === true && waiting.followAuto.note === SNAPSHOT_WAITING, "只有一份完整快照时等待下一次");
check(waitingDiff && waitingDiff.ready === false && waitingDiff.notes.indexOf(SNAPSHOT_WAITING) >= 0, "关注变化写下次完整采集后自动对比");
const waitingHtml = fan.followDiffHtml(waitingDiff, {masked: true, rows: []});
check(waitingHtml.indexOf("取关我的") >= 0 && waitingHtml.indexOf("user_") < 0, "打码后的关注变化没有用户名");
recordSnapshot(snapStore, "followers", [snapPerson("1000003", "user_03"), snapPerson("1000004", "user_04")], 1792627200000, true, "page", "");
recordSnapshot(snapStore, "following", [snapPerson("1000002", "user_02")], 1792582202463, true, "export", "twitter-正在关注-1792582202463.json");
recordSnapshot(snapStore, "following", [snapPerson("1000002", "user_02"), snapPerson("1000005", "user_05")], 1792627200000, true, "page", "");
const diff = fan.followDiff(snapshotDiffInput(snapStore));
check(diff.unfollowed_me.map(function (item) { return item.handle; }).join(",") === "user_02", "谁取关了我");
check(diff.new_followers.map(function (item) { return item.handle; }).join(",") === "user_04", "谁新关注我");
check(diff.i_unfollowed.length === 0, "我取关了谁是空的");
check(diff.i_followed.map(function (item) { return item.handle; }).join(",") === "user_05", "我新关注了谁");
check(recordSnapshot(snapStore, "followers", [snapPerson("1000003", "user_03"), snapPerson("1000004", "user_04")], 1792700000000, true, "page", "") === false, "名单没变就不再存一份完整快照");

const dayStore = emptyStore();
const morning = Date.parse("2026-10-22T01:00:00Z");
recordSnapshot(dayStore, "followers", [snapPerson("1000001", "user_01")], morning, false, "page", "");
recordSnapshot(dayStore, "followers", [snapPerson("1000001", "user_01"), snapPerson("1000002", "user_02")], morning + 3600000, true, "page", "");
check(dayStore.snapshots.length === 1 && dayStore.snapshots[0].people.length === 2 && dayStore.snapshots[0].complete === true, "同一天页面快照用更全的那次替换");
check(recordSnapshot(dayStore, "followers", [snapPerson("1000001", "user_01")], morning + 7200000, false, "page", "") === false, "同一天人数变少不往回盖");

const aged = emptyStore();
recordSnapshot(aged, "followers", [snapPerson("1000001", "user_01")], Date.parse("2020-01-01T00:00:00Z"), true, "page", "");
recordSnapshot(aged, "followers", [snapPerson("1000002", "user_02")], Date.parse("2020-02-01T00:00:00Z"), true, "page", "");
recordSnapshot(aged, "followers", [snapPerson("1000003", "user_03")], Date.parse("2020-03-01T00:00:00Z"), true, "page", "");
recordSnapshot(aged, "followers", [snapPerson("1000004", "user_04")], Date.parse("2026-10-01T00:00:00Z"), false, "page", "");
prune(aged, Date.parse("2026-10-22T00:00:00Z"));
const agedComplete = aged.snapshots.filter(function (snap) { return snap.complete; }).map(function (snap) { return snap.people[0].handle; }).sort();
check(agedComplete.join(",") === "user_02,user_03", "过期后仍留下最近两份完整快照");
check(aged.snapshots.some(function (snap) { return !snap.complete && snap.people[0].handle === "user_04"; }), "保留期内的未完整快照还在");

const keepStore = emptyStore();
keepStore.prefs.owner = "demo_owner";
keepStore.meta.sawFollowing = true;
keepStore.meta.sawFollowers = true;
keepStore.following["id:1000002"] = {id: "1000002", handle: "user_02", name: "", verified: false, followers: 0, seen: 1};
keepStore.followers["id:1000001"] = {id: "1000001", handle: "user_01", name: "", verified: false, followers: 0, seen: 1};
addKeep(keepStore, {id: "1000002", handle: "user_02"});
const keptBack = fan.notFollowedBack(toEngineData(keepStore, "demo_owner", fan.repliesFromTweets), []);
check(keptBack.ready && keptBack.items.length === 0, "保留名单里的人不进没回关");
const keptRound = importBackup(exportBackup(keepStore, Date.parse("2026-10-22T00:00:00Z")));
check(keptRound.keepHandles.user_02 === 1 && keptRound.keepEntries.length === 1, "备份带着保留名单");
removeKeep(keepStore, "user_02");
const returned = fan.notFollowedBack(toEngineData(keepStore, "demo_owner", fan.repliesFromTweets), []);
check(returned.items.length === 1 && returned.items[0].handle === "user_02", "移出保留名单后又出现在没回关");
addKeep(keepStore, "user_08");
applyImported(keepStore, fan.loadTexts([{name: "保留名单.txt", text: "user_09\n", kind: "keep"}]), "demo_owner", Date.parse("2026-10-22T00:00:00Z"));
check(keepStore.keepHandles.user_08 === 1 && keepStore.keepHandles.user_09 === 1, "导入保留名单只追加，不擦掉面板里的");

const mergeStore = emptyStore();
mergeStore.prefs.owner = "demo_owner";
mergeStore.posts["555"] = {id: "555", uid: "1000004", handle: "user_04", name: "", verified: false, replyTo: "1", replyToHandle: "demo_owner", conv: "1", ts: "2026-10-19T00:00:00.000Z", text: "已有", src: "search", seen: 1};
const tweetFile = JSON.stringify([{id: "555", screen_name: "user_04", full_text: "导出里的另一段", created_at: "2026-10-19T00:00:00.000Z", in_reply_to: "1", in_reply_to_screen_name: "demo_owner"}]);
const likeFile = JSON.stringify([{account: "user_06", post_id: "9", direction: "in", post_created_at: "2026-10-01", first_observed_at: "2026-10-02"}]);
applyImported(mergeStore, fan.loadTexts([
  {name: "用户推文.json", text: tweetFile, kind: "tweets", owner: "demo_owner"},
  {name: "likes.json", text: likeFile, kind: "likes"}
]), "demo_owner", Date.parse("2026-10-22T00:00:00Z"));
check(Object.keys(mergeStore.posts).length === 1 && mergeStore.posts["555"].src === "search", "导入的帖子和已记下的按编号合成一条");
const mergedRows = toEngineData(mergeStore, "demo_owner", fan.repliesFromTweets).rows;
check(mergedRows.some(function (row) { return row.type === "like" && row.account === "user_06"; }), "点赞留在打分用的行里");
check(looksLikeBackup(exportBackup(mergeStore, Date.parse("2026-10-22T00:00:00Z"))) === true, "备份文件能被认出来");
recordSnapshot(mergeStore, "followers", [snapPerson("1000002", "user_02")], 1792582202463, true, "export", "twitter-关注者-1792582202463.json");
recordSnapshot(mergeStore, "followers", [snapPerson("1000004", "user_04")], 1792627200000, true, "page", "");
const dated = fan.followDiff(snapshotDiffInput(mergeStore));
check(dated.unfollowed_me[0].handle === "user_02" && dated.new_followers[0].handle === "user_04", "旧导出和今天的采集按文件时间对比");
const datedRound = importBackup(exportBackup(mergeStore, Date.parse("2026-10-22T00:00:00Z")));
check(datedRound.snapshots.filter(function (snap) { return snap.complete; }).length === 2, "快照能随备份导回");
check(built.indexOf("导入导出文件") >= 0 && built.indexOf("☆ 保留") >= 0 && built.indexOf(SNAPSHOT_WAITING) >= 0, "安装文件里有导入、保留和对比提示");
check(built.indexOf("批量取关") < 0 && built.indexOf("取关选中") < 0, "安装文件里没有取关按钮");
check(built.indexOf('["keep", "保留名单"]') >= 0, "导入可以把文件认成保留名单");

const blueStore = emptyStore();
blueStore.prefs.owner = "demo_owner";
applyCapture(blueStore, {kind: "blue-followers", skip: "", users: [{id: "1", handle: "user_01"}]}, 1);
applyCapture(blueStore, {kind: "followers", skip: "", users: [{id: "2", handle: "user_02"}]}, 2);
const blueReport = coverageReport(blueStore, "demo_owner", "UTC");
check(blueReport.blueFollowers === 1 && blueReport.followers === 2, "认证粉丝单独计数，普通粉丝仍在总数里");
check(progressText(blueReport.blueFollowers, 0) === "已记 1 / 总数待核实", "认证粉丝没有公开总数");
const blueRound = importBackup(exportBackup(blueStore, 1));
check(coverageReport(blueRound, "demo_owner", "UTC").blueFollowers === 1, "备份保留认证粉丝标记");
check(!("autoRead" in emptyStore().prefs), "自动读取不写入本地偏好");

check(autoReadGapMs(0) === AUTO_READ_GAP_MIN_MS && autoReadGapMs(1) === AUTO_READ_GAP_MAX_MS, "滚动间隔在 1 到 2 秒");
check(AUTO_READ_GAP_MIN_MS === 1000 && AUTO_READ_GAP_MAX_MS === 2000 && AUTO_READ_MAX_SCREENS >= 200, "滚动单次上限够读大约 2000 人");
check(autoReadGapMs(0.5) >= AUTO_READ_GAP_MIN_MS && autoReadGapMs(0.5) <= AUTO_READ_GAP_MAX_MS, "中间的随机数也落在间隔里");
check(autoReadBlockReason("超出速率限制。请稍等片刻") === "看到限流提示，已停止，不会自动重试", "限流文案会让自动读取停下");
check(autoReadBlockReason("Something went wrong. Try reloading.") === "看到页面报错，已停止，不会自动重试", "页面报错会让自动读取停下");
check(autoReadBlockReason("普通一条帖子，没有速率这两个字连在接口外") === "", "普通正文不当成报错");
const idleReader = createAutoReader();
check(idleReader.phase() === "off" && idleReader.tick(1000, {pageKind: "followers", count: 1, unit: 0}).action === "idle", "没点启动时不会滚动");
idleReader.openConfirm();
check(idleReader.start(1000, "followers", 0).ok === false, "没勾选不能开始");
check(idleReader.tick(1000, {pageKind: "followers", count: 0, unit: 0}).action === "idle", "只打开提示时也不滚动");
idleReader.setAcknowledged(true);
check(idleReader.start(1000, "", 0).ok === false, "不在自己的名单页不能开始");
check(idleReader.start(1000, "followers", 0).ok === true, "勾选后可以开始");
const blocked = idleReader.tick(1000, {pageKind: "followers", count: 0, blocked: "看到限流提示，已停止，不会自动重试", unit: 0});
check(blocked.action === "stop" && idleReader.phase() === "off", "限流立刻停下");
check(idleReader.tick(5000, {pageKind: "followers", count: 9, unit: 0}).action === "idle", "停下后不自动重试");
const knownReader = createAutoReader();
knownReader.openConfirm();
knownReader.setAcknowledged(true);
knownReader.start(0, "blue-followers", 100);
let knownScrolls = 0;
let knownStopped = "";
for (let i = 0; i < 12; i++) {
  const step = knownReader.tick(i * 1500, {
    pageKind: "blue-followers",
    count: 100,
    visibleKey: "user_" + i + "\nuser_" + (i + 1),
    moved: true,
    atBottom: false,
    unit: 0
  });
  if (step.action === "stop") { knownStopped = step.reason; break; }
  knownScrolls += 1;
}
check(knownScrolls === 12 && knownStopped === "" && knownReader.phase() === "running", "刚开始的十几屏，已记过的人换到屏幕上仍继续滚");
const flatReader = createAutoReader();
flatReader.openConfirm();
flatReader.setAcknowledged(true);
flatReader.start(0, "blue-followers", 1005);
let flatScrolls = 0;
let flatReason = "";
for (let i = 0; i < 40; i++) {
  const step = flatReader.tick(i * 1000, {
    pageKind: "blue-followers",
    count: 1005,
    expected: 0,
    visibleKey: "seen_" + i,
    moved: true,
    atBottom: false,
    unit: 0
  });
  if (step.action === "stop") { flatReason = step.reason; break; }
  flatScrolls += 1;
}
check(flatReason.indexOf("已记数长时间没有增加") >= 0 && flatScrolls === AUTO_READ_FLAT_SCREENS - 1 && flatReader.phase() === "off", "已记数不涨、画面一直在换，大约 30 屏后停");
check(flatReader.tick(999999, {pageKind: "blue-followers", count: 1006, visibleKey: "seen_x", moved: true, atBottom: false, unit: 0}).action === "idle", "已记数不涨停下后保持关闭");
const flatTime = createAutoReader();
flatTime.openConfirm();
flatTime.setAcknowledged(true);
flatTime.start(0, "followers", 100);
flatTime.tick(0, {pageKind: "followers", count: 100, visibleKey: "a", moved: true, atBottom: false, unit: 0});
const timed = flatTime.tick(AUTO_READ_FLAT_MS, {pageKind: "followers", count: 100, visibleKey: "b", moved: true, atBottom: false, unit: 0});
check(timed.action === "stop" && timed.reason.indexOf("已记数长时间没有增加") >= 0, "已记数约 1 分钟不增加就停");
const nearDone = createAutoReader();
nearDone.openConfirm();
nearDone.setAcknowledged(true);
nearDone.start(0, "following", 95);
const nearly = nearDone.tick(1000, {pageKind: "following", count: 95, expected: 100, visibleKey: "c", moved: true, atBottom: false, unit: 0});
check(nearly.action === "stop" && nearly.reason.indexOf("差不多了") >= 0, "已记人数接近总数就停");
const bottomReader = createAutoReader();
bottomReader.openConfirm();
bottomReader.setAcknowledged(true);
bottomReader.start(0, "followers", 100);
bottomReader.tick(0, {pageKind: "followers", count: 100, visibleKey: "user_a", moved: true, atBottom: false, unit: 0});
let bottomReason = "";
for (let i = 0; i < 8; i++) {
  const step = bottomReader.tick(1000 + i * 1000, {
    pageKind: "followers",
    count: 100,
    visibleKey: "user_a",
    moved: false,
    atBottom: true,
    unit: 0
  });
  if (step.action === "stop") { bottomReason = step.reason; break; }
}
check(bottomReason.indexOf("已到列表底") >= 0 && bottomReader.phase() === "off", "到底且不再加载才停");
check(bottomReader.tick(20000, {pageKind: "followers", count: 100, visibleKey: "user_b", moved: true, atBottom: false, unit: 0}).action === "idle", "停下后保持关闭");
const stuckReader = createAutoReader();
stuckReader.openConfirm();
stuckReader.setAcknowledged(true);
stuckReader.start(0, "following", 3);
stuckReader.tick(0, {pageKind: "following", count: 3, visibleKey: "user_a", moved: true, atBottom: false, unit: 0});
let stuckReason = "";
for (let i = 0; i < AUTO_READ_DRY_LIMIT + 2; i++) {
  const step = stuckReader.tick(1000 + i * 1000, {
    pageKind: "following",
    count: 3,
    visibleKey: "user_a",
    moved: false,
    atBottom: false,
    unit: 0
  });
  if (step.action === "stop") { stuckReason = step.reason; break; }
}
check(stuckReason.indexOf("页面没有继续加载") >= 0, "滚不动且画面不变就说明没有继续加载");
const capReader = createAutoReader();
capReader.openConfirm();
capReader.setAcknowledged(true);
capReader.start(0, "followers", 0);
let scrolls = 0;
let capNow = 0;
let capCount = 0;
for (let i = 0; i < 300; i++) {
  capCount += 1;
  const step = capReader.tick(capNow, {pageKind: "followers", count: capCount, unit: 0, stuck: false});
  if (step.action !== "scroll") break;
  scrolls += 1;
  capNow += 1000;
}
check(scrolls === AUTO_READ_MAX_SCREENS && capReader.phase() === "off", "单次最多 220 屏");
const switched = createAutoReader();
switched.openConfirm();
switched.setAcknowledged(true);
switched.start(0, "followers", 1);
const left = switched.tick(1000, {pageKind: "following", count: 2, unit: 0});
check(left.action === "stop" && left.reason.indexOf("不在刚才") >= 0, "离开刚才那份自己的名单就停");
check(fan.revisitText({O_raw: 2, I_raw: 1}) === "50%", "回访率是对方回复除以我发出的");
check(fan.revisitText({O_raw: 0, I_raw: 3}) === "—", "没有我发出的次数时不写 0%");
check(fan.revisitText({I_raw: 3}) === "—", "缺分母时不写 0%");
check(fan.revisitText({O_raw: 4, I_raw: 0}) === "0%", "我发过、对方没回，是 0%");
const maskedFacts = fan.boardHtml([{account: "user_01", tier: "银牌", status: "ok", score: 40, stars: 3, O_raw: 2, I_raw: 1, raw: 3, rounds: 1}], {masked: true});
check(maskedFacts.indexOf("user_01") < 0 && maskedFacts.indexOf("回访 50%") >= 0, "打码后账号名隐藏，数据仍显示");
check(maskedFacts.indexOf("重点维护") < 0 && maskedFacts.indexOf("建议动作") < 0, "名单不写建议");
check(built.includes("更多") && built.includes("一键打码") && built.includes("全屏") && built.includes("查看风险并决定是否开启"), "主界面留打码和全屏，其余收进更多");
check(built.includes("脚本自己连续请求") && built.includes("风险比滚动更高"), "风险提示写明快速模式是自己请求列表");
const listUrl = "https://x.com/i/api/graphql/capturedHash/Following?variables=" + encodeURIComponent(JSON.stringify({userId: "1", count: 20, cursor: "old"})) + "&features=" + encodeURIComponent(JSON.stringify({responsive: true}));
check(isOwnListApiUrl(listUrl, "Following") && !isOwnListApiUrl(listUrl, "Followers"), "只认自己捕获到的关注或粉丝接口");
const blueUrl = "https://x.com/i/api/graphql/capturedHash/BlueVerifiedFollowers?variables=" + encodeURIComponent(JSON.stringify({userId: "1", count: 20}));
check(isOwnListApiUrl(blueUrl, "BlueVerifiedFollowers"), "认证粉丝页的列表请求也能捕获");
const bluePage = buildListPageRequest({op: "BlueVerifiedFollowers", url: blueUrl, method: "GET", body: ""}, "next-blue");
check(bluePage && bluePage.url.indexOf("BlueVerifiedFollowers") >= 0 && JSON.parse(decodeURIComponent(bluePage.url.split("variables=")[1].split("&")[0])).cursor === "next-blue", "认证粉丝沿用捕获到的请求翻页");
const blueHookPage = makePage();
const blueIds = [];
installHooks(blueHookPage, function (url, text, body, listId) { if (listId) blueIds.push(String(listId)); });
const blueXhr = new blueHookPage.XMLHttpRequest();
blueXhr.open("GET", blueUrl);
blueXhr.responseText = "{}";
blueXhr.send(null);
blueXhr.listeners.load.forEach(function (fn) { fn(); });
check(blueIds.length === 1 && blueHookPage.__fanAuditKeepListTemplate(blueIds[0]) === true && blueHookPage.__fanAuditHasListTemplate("BlueVerifiedFollowers") === true, "认证粉丝页的请求能被捕获");
check(blueHookPage.__fanAuditHasListTemplate("Followers") !== true, "认证粉丝请求不会当成普通粉丝");
check(!isOwnListApiUrl("https://x.com/i/api/graphql/capturedHash/FavoriteTweet", ""), "写接口不在快速读取里");
const firstPage = buildListPageRequest({op: "Following", url: listUrl, method: "GET", body: ""}, "");
check(firstPage && firstPage.url.indexOf("capturedHash") >= 0 && firstPage.url.indexOf("Bearer") < 0, "下一页沿用捕获到的接口编号，不带令牌");
const firstVars = JSON.parse(decodeURIComponent(firstPage.url.split("variables=")[1].split("&")[0]));
check(firstVars.count === FAST_READ_PAGE_SIZE && firstVars.cursor == null && firstVars.userId === "1", "第一页每页 100 人并且从名单开头读");
const secondPage = buildListPageRequest({op: "Following", url: listUrl, method: "GET", body: ""}, "cursor-2");
const secondVars = JSON.parse(decodeURIComponent(secondPage.url.split("variables=")[1].split("&")[0]));
check(secondVars.cursor === "cursor-2" && secondVars.count === 100, "下一页带上游标");
check(buildListPageRequest({op: "Followers", url: listUrl, method: "GET", body: ""}, "") == null, "关注请求不能拿去读粉丝");
check(bottomCursor({data: {user: {result: {timeline: {timeline: {instructions: [{entries: [{entryId: "cursor-bottom-1", content: {cursorType: "Bottom", value: "NEXT"}}]}]}}}}}}) === "NEXT", "从时间线里取底部游标");
check(bottomCursor({data: {}}) === "", "没有游标就停");
check(fastReadStopReason(429, "5").indexOf("429") >= 0, "429 立刻停");
check(fastReadStopReason(500, "").indexOf("500") >= 0, "错误状态码立刻停");
check(fastReadStopReason(200, String(FAST_READ_REMAINING_FLOOR)).indexOf("接近 0") >= 0, "剩余额度接近 0 立刻停");
check(fastReadStopReason(200, "20") === "", "额度还够就继续");
check(fastPageStopReason(10, 10, "c1", "c2") === "这一页没有新账号，已停止", "重复页没有新账号就停");
check(fastPageStopReason(10, 10, "", "") === "这一页没有新账号，也没有下一页，已停止", "空页没有下一页就停");
check(fastPageStopReason(10, 12, "c1", "c1") === "游标没有变化，已停止", "游标不变就停");
check(fastPageStopReason(10, 12, "c1", "c2") === "", "有新账号并且游标前进才继续");
const fastIdle = createFastReader();
check(fastIdle.notePage().action === "stop", "没点开始不会发快速请求");
check(fastIdle.start().ok === true, "快速读取可以开始");
let fastPages = 0;
for (let i = 0; i < 200; i++) {
  const step = fastIdle.notePage();
  if (step.action !== "continue") break;
  fastPages += 1;
}
check(fastPages === FAST_READ_MAX_PAGES && fastIdle.running() === false, "快速读取单次最多 120 页");
check(fastIdle.notePage().action === "stop", "到上限后不自动再请求");
const replayPage = makePage();
replayPage.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  this.sentHeaders = this.sentHeaders || {};
  this.sentHeaders[name] = value;
};
let replayInit = null;
replayPage.fetch = function (input, init) {
  replayPage.fetchCalls += 1;
  replayInit = init;
  return Promise.resolve({
    status: 200,
    ok: true,
    headers: {get: function (name) { return name === "x-rate-limit-remaining" ? "9" : ""; }},
    text: function () { return Promise.resolve("{\"data\":{}}"); },
    clone: function () { return {text: function () { return Promise.resolve("{\"data\":{}}"); }}; }
  });
};
const replaySeen = [];
installHooks(replayPage, function (url, text, body, listId) { replaySeen.push({url: url, listId: listId}); });
const replayXhr = new replayPage.XMLHttpRequest();
replayXhr.open("GET", listUrl);
replayXhr.setRequestHeader("authorization", "Bearer test-token");
replayXhr.setRequestHeader("cookie", "ct0=secret");
replayXhr.responseText = "{\"data\":{}}";
replayXhr.send(null);
replayXhr.listeners.load.forEach(function (fn) { fn(); });
check(replaySeen.length === 1 && replaySeen[0].listId, "列表请求带一个内存编号");
check(JSON.stringify(replaySeen[0]).indexOf("test-token") < 0 && JSON.stringify(replaySeen[0]).indexOf("secret") < 0, "响应事件里不带令牌或 cookie");
check(replayPage.__fanAuditKeepListTemplate(replaySeen[0].listId) === true, "确认是自己的名单后才留下请求");
const exposed = replayPage.__fanAuditListTemplate("Following");
check(exposed && exposed.url.indexOf("capturedHash") >= 0 && exposed.headers == null, "交出去的模板没有请求头");
const replayReq = buildListPageRequest(exposed, "");
const replayResult = await replayPage.__fanAuditFetchList("Following", replayReq.url, replayReq.method, replayReq.body);
check(replayResult.status === 200 && replayResult.remaining === "9", "快速读取走页面原来的 fetch");
check(replayInit && replayInit.headers.authorization === "Bearer test-token" && replayInit.headers.cookie == null, "复用页面设置过的令牌，不带 cookie 头");
check(replayPage.__fanAuditFetchList("Followers", replayReq.url, "GET", "").then, "别的名单没有捕获到就不会发");
const wrong = await replayPage.__fanAuditFetchList("FavoriteTweet", "https://x.com/i/api/graphql/x/FavoriteTweet", "POST", "{}");
check(wrong.status === 0, "写接口直接拒绝");

if (failed) {
  console.error(failed + " checks failed");
  process.exit(1);
}
console.log("userscript checks ok");
