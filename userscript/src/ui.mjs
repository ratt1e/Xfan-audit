import { EMPTY_GUIDE, RETENTION_DAYS, SNAPSHOT_WAITING, BOARD_CSS, emptyStore, normalizeStore, prune, parseCapture, applyCapture, coverageReport, toEngineData, snapshotDiffInput, recordSnapshot, exportTimeFromName, maybeSnapshot, addKeep, removeKeep, looksLikeBackup, headerListCount, headerVerifiedCount, applyImported, contextProblems, installHooks, pageHookProgram, exportBackup, importBackup, standaloneHtml, norm, operationName, classifyUrl, listKindFromPath, userFromVisible, diagnosticsCopy, sameRealm, pageContext, badgeText, progressText, AUTO_READ_RISK, AUTO_READ_ACK, AUTO_READ_MAX_SCREENS, FAST_READ_MAX_PAGES, autoReadGapMs, autoReadPageKind, autoReadCount, autoReadBlockReason, createAutoReader, buildListPageRequest, bottomCursor, fastReadStopReason, fastPageStopReason, createFastReader } from "./logic.mjs";

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
