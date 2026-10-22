import {spawnSync} from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {fileURLToPath} from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.argv[2];
const script = fs.readFileSync(path.join(root, "userscript/fan-audit.user.js"), "utf8");
const guide = "刚安装还没有数据？依次打开你的关注列表、粉丝列表和主页回复页，手动往下滑几屏，脚本会自动记录。";
const html = `<!doctype html>
<meta charset="utf-8">
<title>fan-audit harness</title>
<body>
<script>
window.unsafeWindow = window;
window.webpackChunk_twitter_responsive_web = [];
window.GM_getValue = function () { return null; };
window.GM_setValue = function () {};
</script>
<script>
${script}
</script>
<script>
var host = document.getElementById("fan-audit-host");
var rootEl = document.documentElement;
if (!host || !host.shadowRoot) {
  rootEl.dataset.probe = "no-panel";
} else {
  host.shadowRoot.getElementById("launcher").click();
  var shadow = host.shadowRoot;
  var empty = shadow.getElementById("empty-guide");
  var footer = shadow.querySelector("footer");
  var mask = shadow.getElementById("mask");
  rootEl.setAttribute("data-guide", empty ? empty.textContent : "");
  rootEl.setAttribute("data-footer", footer ? footer.textContent : "");
  mask.click();
  rootEl.setAttribute("data-mask", mask.getAttribute("aria-pressed") || "");
  rootEl.setAttribute("data-masktext", mask.textContent || "");
  rootEl.setAttribute("data-probe", "ok");
}
</script>
</body>`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fan-audit-chrome-"));
const file = path.join(dir, "harness.html");
fs.writeFileSync(file, html);
const run = spawnSync(chrome, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--user-data-dir=" + path.join(dir, "profile"),
  "--dump-dom",
  "file://" + file
], {encoding: "utf8", timeout: 90000});
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(run.status || 1);
}
const dom = run.stdout;
function attr(name) {
  const match = dom.match(new RegExp("data-" + name + "=\"([^\"]*)\""));
  return match ? match[1] : "";
}
const probe = attr("probe");
const gotGuide = attr("guide");
const footer = attr("footer");
const mask = attr("mask");
const maskText = attr("masktext");
if (probe !== "ok") {
  console.error(dom.slice(0, 1500));
  console.error("panel probe", probe || "missing");
  process.exit(1);
}
if (gotGuide !== guide) {
  console.error("guide", gotGuide);
  process.exit(1);
}
if (footer !== "fan-audit（油猴版）· GitHub 开源") {
  console.error("footer", footer);
  process.exit(1);
}
if (mask !== "true" || maskText.indexOf("已开") < 0) {
  console.error("mask", mask, maskText);
  process.exit(1);
}
console.log("browser panel ok");
