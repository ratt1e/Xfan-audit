import fs from "fs";
import path from "path";
import vm from "vm";
import {fileURLToPath} from "url";
import {
  EMPTY_GUIDE, RETENTION_DAYS, classifyUrl, textForStore, snippet, parseCapture, applyCapture,
  emptyStore, coverageReport, toEngineData, prune, exportBackup, importBackup, contextProblems,
  installHooks, norm
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
quiet.listeners.load.forEach(function (fn) { fn(); });
check(seen.length === 1, "非白名单地址不读");
const fetchUrl = "https://x.com/i/api/graphql/hash/Followers";
page.bodies[fetchUrl] = JSON.stringify(sample.events[1].body);
await page.fetch(fetchUrl);
await new Promise(function (resolve) { setTimeout(resolve, 0); });
check(seen.length === 2, "fetch 兜底也能读到响应");
check(page.fetchCalls === 1, "fetch 兜底没有多打一次请求");
check(page.XMLHttpRequest.prototype.open === hooks.hookedOpen, "钩子挂在页面的 XMLHttpRequest 上");
const fine = contextProblems({page: page, hookedOpen: hooks.hookedOpen, sawPageApp: true});
check(fine.length === 0, "页面环境和钩子都在时自检通过");

const maskedNames = fan.boardHtml(result.rows, {masked: true});
check(maskedNames.split("tier-").length > 2, "分层卡片还在");

if (failed) {
  console.error(failed + " checks failed");
  process.exit(1);
}
console.log("userscript checks ok");
