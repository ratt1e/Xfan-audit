import fs from "fs";
import path from "path";
import {fileURLToPath} from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const invoke = '})(typeof globalThis !== "undefined" ? globalThis : this);';
let engine = fs.readFileSync(path.join(root, "engine/fan_audit_engine.js"), "utf8").replace(/\r\n/g, "\n").trim();
if (!engine.endsWith(invoke)) throw new Error("打分脚本结尾变了，构建脚本需要一起改");
engine = engine.slice(0, -invoke.length) + "})(root);";

function stripModule(src) {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+/gm, "")
    .trim();
}

const logic = stripModule(fs.readFileSync(path.join(here, "src/logic.mjs"), "utf8"));
const ui = stripModule(fs.readFileSync(path.join(here, "src/ui.mjs"), "utf8"));
const author = "ranger" + "_escape";
const raw = "https://raw.githubusercontent.com/ratt1e/Xfan-audit/main/userscript/fan-audit.user.js";

function at(name) {
  return "// @" + name;
}

const header = [
  "// ==UserScript==",
  at("name") + "         fan-audit 粉丝体检",
  at("namespace") + "    https://github.com/ratt1e/Xfan-audit",
  at("version") + "      0.5.0",
  at("description") + "  在 X 上边逛边记下公开回复和关注名单，也能导入导出的 JSON。默认只记你正在看的页面。可选自动读取默认关闭，由脚本请求自己的名单。本地排除只隐藏，不在 X 上操作。",
  at("author") + "       " + author,
  at("match") + "        *://x.com/*",
  at("match") + "        *://twitter.com/*",
  at("run-at") + "       document-start",
  at("sandbox") + "      raw",
  at("grant") + "        unsafeWindow",
  at("grant") + "        GM_getValue",
  at("grant") + "        GM_setValue",
  at("grant") + "        GM_addElement",
  at("updateURL") + "    " + raw,
  at("downloadURL") + "  " + raw,
  at("license") + "      MIT",
  at("noframes"),
  "// ==/UserScript=="
].join("\n");

const notice = `/*
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
 */`;

const bundled = `${header}\n${notice}\n(function () {\n"use strict";\nvar root = {};\n/* FAN_ENGINE_START */\n${engine}\n/* FAN_ENGINE_END */\nvar FanAudit = root.FanAudit;\n${logic}\n${ui}\n})();\n`;
const out = path.join(here, "fan-audit.user.js");
fs.writeFileSync(out, bundled);
if (!bundled.includes(author) || !bundled.includes(raw) || !bundled.includes("function parseCapture")) {
  throw new Error("构建结果缺了脚本头或解析函数");
}
process.stdout.write("wrote " + path.relative(root, out) + " (" + bundled.length + " bytes)\n");
