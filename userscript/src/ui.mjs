import { EMPTY_GUIDE, RETENTION_DAYS, BOARD_CSS, emptyStore, normalizeStore, prune, parseCapture, applyCapture, coverageReport, toEngineData, contextProblems, installHooks, pageHookProgram, exportBackup, importBackup, standaloneHtml, norm, operationName, classifyUrl, listKindFromPath, userFromVisible, diagnosticsCopy, sameRealm } from "./logic.mjs";

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
  var pending = [];
  var flushing = false;
  var diag = {hook: "no", world: "unknown", sameRealm: false, pageApp: false, graphqlSeen: 0, matched: {}, unmatched: [], domAccepted: 0, skips: {}, skipsByOp: {}};

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
    if (applyCapture(store, {kind: kind, skip: "", posts: [], users: users}, Date.now())) {
      var after = Object.keys(bucket).length;
      if (after > before) diag.domAccepted += after - before;
      scheduleSave();
      updateBadge();
      if (panelOpen) render();
    }
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
  function ingest(url, text, body, countTraffic) {
    if (countTraffic) noteTraffic(url);
    var owner = currentOwner();
    var captured = parseCapture(url, text, {owner: owner, body: body, pageKind: listKindFromPath(location.pathname, owner), pagePath: location.pathname});
    if (captured.skip) {
      diag.skips[captured.skip] = (diag.skips[captured.skip] || 0) + 1;
      var skipOp = captured.op || operationName(url) || "unknown";
      if (!diag.skipsByOp[skipOp]) diag.skipsByOp[skipOp] = {};
      diag.skipsByOp[skipOp][captured.skip] = (diag.skipsByOp[skipOp][captured.skip] || 0) + 1;
    }
    if (captured.skip === "还不知道你的用户名" && text && pending.length < 20 && String(text).length < 1500000) {
      pending.push({url: url, text: text, body: body || ""});
    }
    if (applyCapture(store, captured, Date.now())) scheduleSave();
    updateBadge();
    if (panelOpen) render();
    if (!flushing && currentOwner()) flushPending();
  }
  function flushPending() {
    if (flushing || !currentOwner() || !pending.length) return;
    flushing = true;
    var batch = pending.splice(0, pending.length);
    try {
      batch.forEach(function (item) { ingest(item.url, item.text, item.body, false); });
    } finally {
      flushing = false;
    }
  }
  function onResponse(url, text, body) {
    ingest(url, text, body, true);
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
      onResponse(String(detail.url || ""), String(detail.text || ""), String(detail.body || ""));
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
      "#scroller{position:relative;overflow:auto;padding:14px 14px 8px;max-height:min(78vh,760px)}",
      "#scroller h1{font-size:18px}",
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
      ".miss{color:#9CA3AF}"
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
    var lead = el("p", "privacy", "只被动记录你正在浏览时页面已经收到的内容。脚本自己不发请求，也不会点赞、关注、取关或发帖。");
    var diagLine = el("p", "muted");
    diagLine.id = "diag";
    var copyDiag = el("button", "ctrl", "复制诊断");
    copyDiag.type = "button";
    copyDiag.id = "copy-diag";
    var maskBtn = el("button", "ctrl", "一键打码");
    maskBtn.type = "button";
    maskBtn.id = "mask";
    var row1 = el("div", "row");
    row1.appendChild(maskBtn);
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

    var row2 = el("div", "row");
    function modeButton(mode, label) {
      var button = el("button", "ctrl", label);
      button.type = "button";
      button.setAttribute("data-mode", mode);
      button.addEventListener("click", function () {
        store.prefs.mode = mode;
        scheduleSave();
        render();
      });
      row2.appendChild(button);
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
    row3.appendChild(delBtn);
    row3.appendChild(exportBtn);
    row3.appendChild(importBtn);
    row3.appendChild(downloadBtn);
    var file = el("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.hidden = true;

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
    scroller.appendChild(diagLine);
    scroller.appendChild(copyDiag);
    scroller.appendChild(row1);
    scroller.appendChild(row2);
    scroller.appendChild(row3);
    scroller.appendChild(file);
    scroller.appendChild(tzLine);
    scroller.appendChild(warnings);
    scroller.appendChild(coverage);
    scroller.appendChild(status);
    scroller.appendChild(results);
    scroller.appendChild(footer);
    ui = {owner: owner, tz: tz, maskBtn: maskBtn, shadow: shadow, scroller: scroller, results: results, warnings: warnings, coverage: coverage, status: status, tzLine: tzLine, launcher: launcher, badge: badge, panel: panel, diagLine: diagLine};

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
      store.prefs.owner = norm(owner.value);
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
      if (!confirm("删除本机保存的全部采集数据（" + total + " 条）？删掉之后不能恢复。打码和时区会保留。")) return;
      var prefs = store.prefs;
      store = emptyStore();
      store.prefs = prefs;
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
    setTimeout(function () { currentOwner(); flushPending(); scanCells(); updateBadge(); if (panelOpen) render(); }, 1000);
    setTimeout(function () { currentOwner(); flushPending(); scanCells(); updateBadge(); if (panelOpen) render(); }, 5000);
    try {
      page && page.addEventListener("pagehide", persist);
    } catch (err) {}
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && panelOpen) {
        panelOpen = false;
        panel.hidden = true;
      }
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
    box.appendChild(el("p", "sub", "采集清单（点按钮在当前页打开，再手动往下翻。脚本不自己发请求。）"));
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
    row("关注列表", home ? home + "/following" : "", !!report.sawFollowing, report.sawFollowing ? (report.following + " 人") : "");
    row("粉丝列表", home ? home + "/followers" : "", !!report.sawFollowers, report.sawFollowers ? (report.followers + " 人") : "");
    row("认证粉丝", home ? home + "/verified_followers" : "", !!report.sawBlueFollowers, report.sawBlueFollowers ? "已采集" : "");
    row("主页回复", home ? home + "/with_replies" : "", replies, replies ? (report.srcCount.replies + " 条 / " + report.srcDays.replies + " 天") : "");
    box.appendChild(el("p", "warn", "别人回我是搜索页，别一次翻太久。X 会限流，被限了就停下来等一等再翻。脚本不会替你滚动，也不会自己发请求。"));
    return box;
  }

  function updateBadge() {
    if (!ui.badge) return;
    var total = Object.keys(store.posts).length + Object.keys(store.following).length + Object.keys(store.followers).length;
    ui.badge.textContent = total ? " " + total : "";
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
      var extras = [];
      if (back) extras.push({id: "not-followed-back", count: back.ready ? String(back.items.length) : "—", label: "没回关"});
      var fragment = FanAudit.boardHtml(result.rows, {masked: !!store.prefs.masked, open: openTiers, extras: extras, interactionReady: result.meta.interactionReady !== false, interactionNote: result.meta.interactionNote || ""});
      if (back) fragment += FanAudit.notFollowedBackHtml(back, {masked: !!store.prefs.masked, rows: result.rows});
      return {result: result, fragment: fragment, owner: owner};
    } catch (err) {
      return {error: err && err.message ? err.message : "时区无效，请填 IANA 名称，例如 Asia/Shanghai"};
    }
  }

  function render() {
    if (!ui.results) return;
    if (ui.diagLine) {
      var matched = Object.keys(diag.matched).map(function (key) { return key + " " + diag.matched[key]; }).join("、") || "无";
      var unmatched = diag.unmatched.join("、") || "无";
      var skipBits = [];
      Object.keys(diag.skipsByOp).sort().forEach(function (op) {
        var reasons = diag.skipsByOp[op] || {};
        Object.keys(reasons).sort().forEach(function (reason) {
          if (skipBits.length >= 6) return;
          skipBits.push(op + " " + reason + " " + reasons[reason]);
        });
      });
      var ownerNow = norm(store.prefs.owner);
      var hookLabel = (diag.hook === "page" || diag.hook === "page-script") ? "已装" : "没装上";
      ui.diagLine.textContent = "诊断：钩子" + hookLabel + "（" + diag.hook + "，世界 " + diag.world + (diag.sameRealm ? "，同一环境" : "，隔离环境") + "）"
        + " · GraphQL " + diag.graphqlSeen
        + " · 匹配 " + matched
        + " · 未识别 " + unmatched
        + " · 跳过 " + (skipBits.join("、") || "无")
        + " · 用户名 " + (ownerNow || "未识别")
        + " · 页面格子新记 " + diag.domAccepted;
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
        ? "名单还是空的。请确认打开的是你自己的关注、粉丝或主页回复页，再手动往下翻。上面的诊断能看出钩子有没有接到请求。默认保留 " + RETENTION_DAYS + " 天。"
        : "如果用户名是空的，先打开自己的主页，或在上面填上，再手动往下翻。默认保留 " + RETENTION_DAYS + " 天。"));
    }
    ui.coverage.appendChild(captureChecklist(norm(ui.owner.value), report));
    if (!empty) {
      ui.coverage.appendChild(el("p", "sub", "数据完整度（按当前时区算天数）"));
      ui.coverage.appendChild(el("p", "muted", "别人回我：" + report.inbound + " 条，覆盖 " + report.inboundDays + " 天。搜索记下 " + report.srcCount.search + " 条（" + report.srcDays.search + " 天），帖子详情 " + report.srcCount.detail + " 条（" + report.srcDays.detail + " 天）。"));
      ui.coverage.appendChild(el("p", "muted", "我发出的回复：" + report.outbound + " 条，覆盖 " + report.outboundDays + " 天。主页回复页 " + report.srcCount.replies + " 条（" + report.srcDays.replies + " 天），主页帖子页 " + report.srcCount.originals + " 条（" + report.srcDays.originals + " 天）。"));
      ui.coverage.appendChild(el("p", "muted", "正在关注：" + report.following + " 人" + (report.sawFollowing ? "（已打开过列表）" : "（还没打开过列表）") + "。关注者：" + report.followers + " 人" + (report.sawFollowers ? "（已打开过普通粉丝列表）" : "（还没打开过普通粉丝列表）") + (report.sawBlueFollowers ? "，另看到过认证粉丝。" : "。")));
      if (report.sawBlueFollowers && !report.sawFollowers) {
        ui.coverage.appendChild(el("p", "warn", "关注者目前只来自认证粉丝列表，普通粉丝还没记到，没回关会偏多。请再打开普通粉丝页往下翻。"));
      }
      if (!report.inboundDays) {
        ui.coverage.appendChild(el("p", "warn", "还没记到「别人回我」。金银牌会偏少。可以自己打开搜索 to:你的用户名（选最新）往下翻，或点开自己的帖子。"));
      }
      ui.coverage.appendChild(el("p", "muted", "名单是这段时间翻到的页面累加的，默认保留 " + RETENTION_DAYS + " 天。要重计请先全部删除，再重新往下翻。脚本不会自动滚动。"));
    }
    if (!norm(ui.owner.value)) {
      ui.results.innerHTML = "";
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
    updateBadge();
  }

  var scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = 0; scanCells(); }, 400);
  }
  try {
    var observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {childList: true, subtree: true});
  } catch (err) {}
  setInterval(scanCells, 2000);

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
}

if (typeof document !== "undefined") boot();
