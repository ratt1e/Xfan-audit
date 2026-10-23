import fs from "fs";
import path from "path";
import vm from "vm";
import {fileURLToPath} from "url";
import {
  EMPTY_GUIDE, RETENTION_DAYS, classifyUrl, textForStore, snippet, parseCapture, applyCapture,
  emptyStore, coverageReport, toEngineData, prune, exportBackup, importBackup, contextProblems,
  installHooks, pageHookProgram, norm, operationName, listKindFromPath, timelineKindFromPath, userFromVisible, diagnosticsCopy,
  pageContext, badgeText
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

const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const pageEngine = html.match(/<script id="fan-audit-engine">([\s\S]*?)<\/script>/)[1];
const fan = engineFrom(pageEngine, "web/index.html");

const builtPath = path.join(root, "userscript/fan-audit.user.js");
const built = fs.readFileSync(builtPath, "utf8");
const bundled = built.match(/\/\* FAN_ENGINE_START \*\/\n([\s\S]*?)\n\/\* FAN_ENGINE_END \*\//);
check(!!bundled, "构建产物里有打分引擎");
const bundledEngine = bundled[1].replace(/\}\)\(root\);$/, '})(typeof globalThis !== "undefined" ? globalThis : this);');
check(bundledEngine.trim() === pageEngine.trim(), "打包进去的引擎和 web/index.html 是同一份");
const fanBuilt = engineFrom("var root = {};\n" + bundled[1], "userscript/fan-audit.user.js");
check(typeof fanBuilt.analyze === "function", "打包引擎可以运行");

check(classifyUrl("https://x.com/i/api/graphql/abc/UserRepliesTimeline?variables=1") === "replies", "回复时间线");
check(classifyUrl("https://x.com/i/api/graphql/abc/BlueVerifiedFollowers") === "blue-followers", "认证粉丝不是普通粉丝");
check(classifyUrl("https://x.com/i/api/graphql/abc/HomeTimeline") === "", "首页时间线不收");
check(classifyUrl("https://x.com/i/api/graphql/abc/DirectMessages") === "", "私信不收");
check(built.includes("GM_xmlhttpRequest") === false, "不使用 GM_xmlhttpRequest");
check(!new RegExp("(^|\\n)\\s*//\\s*" + "@" + "connect\\b").test(built), "没有 connect 授权");
check(built.includes("document.cookie") === false, "不读 cookie");
check(built.includes("scrollBy") === false, "不自动滚动");
check(built.includes(EMPTY_GUIDE), "空状态文案在安装文件里");
const meta = "// " + "@";
check(built.includes(meta + "version      0.1.3"), "版本号");
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
check(built.indexOf("GM_openInTab") < 0 && built.indexOf("GM_xmlhttpRequest") < 0, "清单只是普通链接，脚本不自己打开也不自己请求");

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

if (failed) {
  console.error(failed + " checks failed");
  process.exit(1);
}
console.log("userscript checks ok");
