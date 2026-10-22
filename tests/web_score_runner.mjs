import fs from "fs";
import path from "path";
import vm from "vm";
import {fileURLToPath} from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const match = html.match(/<script id="fan-audit-engine">([\s\S]*?)<\/script>/);
if (!match) throw new Error("找不到打分脚本");
const sandbox = {
  console, Intl, Date, Math, Object, Array, String, Number, RegExp, JSON, isNaN, parseInt
};
sandbox.globalThis = sandbox;
vm.runInNewContext(match[1], sandbox, {filename: "web/index.html"});
const fan = sandbox.FanAudit;
const dir = path.join(root, "sample_data");
function text(name) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}
if (process.argv[2] === "board") {
  const spec = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  process.stdout.write(JSON.stringify({
    html: fan.boardHtml(spec.rows, spec.options || {}),
    empty: fan.jumpPlan(0),
    some: fan.jumpPlan(4)
  }));
  process.exit(0);
}
function partFrom(job) {
  const file = job.file ? (path.isAbsolute(job.file) ? job.file : path.join(root, job.file)) : "";
  return {
    name: job.name, text: job.text != null ? job.text : fs.readFileSync(file, "utf8"),
    owner: job.owner || "", kind: job.kind || ""
  };
}
if (process.argv[2] === "notback") {
  const spec = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const parts = spec.parts.map(partFrom);
  const data = fan.loadTexts(parts);
  const opt = Object.assign({end: "2026-10-19", days: 30, gapsAreEmpty: true}, spec.options || {});
  const result = spec.skipAnalyze ? {rows: spec.rows || []} : fan.analyze(data, opt);
  const info = fan.notFollowedBack(data, result.rows);
  process.stdout.write(JSON.stringify({
    info: info,
    accounts: (result.rows || []).map(function (row) { return row.account; }),
    masked: fan.notFollowedBackHtml(info, {masked: true, rows: result.rows || []}),
    open: fan.notFollowedBackHtml(info, {masked: false, rows: result.rows || []}),
    kinds: parts.map(function (part) { return part.kind || fan.fileKind(part.name, part.text); })
  }));
  process.exit(0);
}
if (process.argv[2] === "diff") {
  const spec = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const parts = spec.parts.map(function (job) {
    const file = path.isAbsolute(job.file) ? job.file : path.join(root, job.file);
    return {name: job.name, text: fs.readFileSync(file, "utf8"), owner: job.owner || "", kind: job.kind || ""};
  });
  const data = fan.loadTexts(parts);
  const diff = fan.followDiff(data);
  process.stdout.write(JSON.stringify({
    diff: diff,
    masked: fan.followDiffHtml(diff, {masked: true, rows: spec.rows || []}),
    open: fan.followDiffHtml(diff, {masked: false, rows: spec.rows || []}),
    kinds: parts.map(function (part) { return fan.fileKind(part.name, part.text); }),
    followers: Object.keys(data.followers).sort(),
    following: Object.keys(data.following).sort()
  }));
  process.exit(0);
}
if (process.argv[2] === "kinds") {
  const jobs = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const parts = jobs.map(function (job) {
    const file = path.isAbsolute(job.file) ? job.file : path.join(root, job.file);
    return {name: job.name, text: fs.readFileSync(file, "utf8"), owner: job.owner || ""};
  });
  const data = fan.loadTexts(parts);
  process.stdout.write(JSON.stringify({
    kinds: parts.map(function (part) { return fan.fileKind(part.name, part.text); }),
    following: Object.keys(data.following).sort(),
    followers: Object.keys(data.followers).sort(),
    tweetIds: data.rows.map(function (row) { return row.tweet_id; }).filter(Boolean).sort(),
    needsChoice: data.needsChoice.map(function (item) { return item.name; })
  }));
  process.exit(0);
}
if (process.argv[2] === "tweets" || process.argv[2] === "owner") {
  const records = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/twe_tweets.json"), "utf8"));
  if (process.argv[2] === "owner") {
    process.stdout.write(JSON.stringify({owner: fan.inferOwner(records)}));
  } else {
    const rows = fan.repliesFromTweets(records, process.argv[3] || "");
    process.stdout.write(JSON.stringify(rows.map(function (row) {
      return {
        tweet_id: row.tweet_id, created_at: row.ts, direction: row.direction, account: row.account,
        in_reply_to_status_id: row.in_reply_to_status_id, conversation_id: row.conversation_id, parent_kind: row.parent_kind
      };
    })));
  }
  process.exit(0);
}
const data = fan.loadTexts([
  {name: "replies.csv", text: text("replies.csv")},
  {name: "following.csv", text: text("following.csv")},
  {name: "followers.csv", text: text("followers.csv")},
  {name: "likes.csv", text: text("likes.csv")},
  {name: "profiles.csv", text: text("profiles.csv")}
]);
const end = process.argv[2];
const days = Number(process.argv[3]);
const allDays = process.argv[4] === "1";
const result = fan.analyze(data, {end: end, days: days, allDays: allDays, gapsAreEmpty: true});
const keys = ["account", "tier", "status", "score", "stars", "O", "I", "O_raw", "I_raw", "rounds", "sub_days", "P", "B", "R", "action", "priority", "mutual", "verified"];
const rows = result.rows.map(function (row) {
  const out = {};
  keys.forEach(function (key) { out[key] = row[key] == null ? null : row[key]; });
  return out;
});
process.stdout.write(JSON.stringify({
  config: fan.CONFIG,
  meta: result.meta,
  rows: rows
}));
