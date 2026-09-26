/* SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
 *
 * Socket events
 *   emit:    job:start {url, options:{maxDepth,maxPages,maxSizeMB,singlePage}}
 *            job:cancel
 *   consume: job:progress {pages, files, bytes, current}
 *            job:log      {level, message}
 *            job:done     {downloadUrl, id, pages, files, bytes, zipBytes, errors}
 *            job:error    {message}
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LOG_CAP = 300;
  const LEVEL_LABEL = { info: "INFO", warn: "WARN", warning: "WARN", error: "ERR", success: "OK", debug: "DBG" };
  const DEFAULT_TITLE = "SiteGrab — Download any website as a ZIP";

  // ---------- Theme ----------
  const themeBtn = $("theme-btn");
  function currentTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  themeBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("sitegrab:theme", next); } catch { /* ignore */ }
  });

  // ---------- Elements ----------
  const el = {
    conn: $("conn"), connLabel: $("conn-label"),
    form: $("grab-form"), url: $("url"), grabBtn: $("grab-btn"), formError: $("form-error"),
    adv: $("adv"), advMeta: $("adv-meta"),
    depth: $("depth"), depthOut: $("depth-out"), maxPages: $("maxPages"), maxSizeMB: $("maxSizeMB"), singlePage: $("singlePage"),
    job: $("job"), running: $("job-running"), done: $("job-done"), error: $("job-error"),
    host: $("job-host"), phase: $("job-phase"), cancelBtn: $("cancel-btn"), cancelLabel: $("cancel-label"),
    progress: $("progress"), progressFill: $("progress-fill"), tickerUrl: $("ticker-url"),
    statPages: $("stat-pages"), statFiles: $("stat-files"), statBytes: $("stat-bytes"), statTime: $("stat-time"),
    log: $("log"), logLines: $("log-lines"), logCount: $("log-count"),
    doneHost: $("done-host"), doneFilename: $("done-filename"), donePages: $("done-pages"), doneFiles: $("done-files"),
    doneBytes: $("done-bytes"), doneZip: $("done-zip"), doneTime: $("done-time"), doneErrors: $("done-errors"),
    downloadBtn: $("download-btn"), againBtn: $("again-btn"),
    errTitle: $("err-title"), errMsg: $("err-msg"), retryBtn: $("retry-btn"), errAgainBtn: $("err-again-btn"),
    announce: $("job-announce"),
  };

  // ---------- State ----------
  const state = {
    status: "idle",          // idle | running | done | error
    startedAt: 0,
    timer: null,
    logCount: 0,
    lastUrl: "",
    lastOptions: null,
    cancelling: false,
    cancelFallback: null,
    connected: false,
  };

  // ---------- Helpers ----------
  const num = (n) => (Number(n) || 0).toLocaleString("en-US");

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(h ? 2 : 1, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return url; }
  }

  function normalizeUrl(raw) {
    let v = (raw || "").trim();
    if (!v) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v;
    return v;
  }

  function validateUrl(v) {
    let u;
    try { u = new URL(v); } catch { return "That does not look like a valid URL."; }
    if (!/^https?:$/.test(u.protocol)) return "Only http:// and https:// addresses are supported.";
    if (!u.hostname || !u.hostname.includes(".") && u.hostname !== "localhost") return "Include a full hostname, like example.com.";
    return "";
  }

  function clamp(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // Animated number counter (tabular nums)
  const tweens = new Map();
  function setCounter(node, target, fmt = (v) => num(Math.round(v))) {
    const from = Number(node.dataset.value || 0);
    target = Number(target) || 0;
    if (target === from) return;
    node.dataset.value = String(target);
    if (REDUCED) { node.textContent = fmt(target); return; }
    if (tweens.has(node)) cancelAnimationFrame(tweens.get(node));
    const t0 = performance.now();
    const dur = 240;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(from + (target - from) * e);
      if (p < 1) tweens.set(node, requestAnimationFrame(step));
      else tweens.delete(node);
    };
    tweens.set(node, requestAnimationFrame(step));
  }

  function resetCounter(node, text) {
    if (tweens.has(node)) { cancelAnimationFrame(tweens.get(node)); tweens.delete(node); }
    node.dataset.value = "0";
    node.textContent = text;
  }

  function announce(msg) {
    el.announce.textContent = "";
    requestAnimationFrame(() => { el.announce.textContent = msg; });
  }

  // ---------- Options UI ----------
  function readOptions() {
    return {
      maxDepth: clamp(el.depth.value, 0, 5, 2),
      maxPages: clamp(el.maxPages.value, 1, 1000, 200),
      maxSizeMB: clamp(el.maxSizeMB.value, 1, 500, 100),
      singlePage: !!el.singlePage.checked,
    };
  }

  function syncOptionsUI() {
    const o = readOptions();
    el.depthOut.value = String(o.maxDepth);
    el.depthOut.textContent = String(o.maxDepth);
    el.singlePage.setAttribute("aria-checked", String(o.singlePage));
    el.advMeta.textContent = o.singlePage
      ? `single page · ${o.maxSizeMB} MB`
      : `depth ${o.maxDepth} · ${o.maxPages} pages · ${o.maxSizeMB} MB`;
    if (state.status !== "running") {
      el.depth.disabled = o.singlePage;
      el.maxPages.disabled = o.singlePage;
    }
  }

  ["input", "change"].forEach((evt) => {
    [el.depth, el.maxPages, el.maxSizeMB, el.singlePage].forEach((n) => n.addEventListener(evt, syncOptionsUI));
  });
  el.maxPages.addEventListener("blur", () => { el.maxPages.value = readOptions().maxPages; syncOptionsUI(); });
  el.maxSizeMB.addEventListener("blur", () => { el.maxSizeMB.value = readOptions().maxSizeMB; syncOptionsUI(); });

  try {
    const saved = JSON.parse(localStorage.getItem("sitegrab:opts") || "null");
    if (saved && typeof saved === "object") {
      if (saved.maxDepth != null) el.depth.value = clamp(saved.maxDepth, 0, 5, 2);
      if (saved.maxPages != null) el.maxPages.value = clamp(saved.maxPages, 1, 1000, 200);
      if (saved.maxSizeMB != null) el.maxSizeMB.value = clamp(saved.maxSizeMB, 1, 500, 100);
      if (saved.singlePage != null) el.singlePage.checked = !!saved.singlePage;
    }
  } catch { /* ignore */ }
  syncOptionsUI();

  function setFormEnabled(enabled) {
    el.form.setAttribute("aria-busy", String(!enabled));
    [el.url, el.grabBtn, el.depth, el.maxPages, el.maxSizeMB, el.singlePage].forEach((n) => { n.disabled = !enabled; });
    if (enabled) syncOptionsUI();
  }

  function showFormError(msg) {
    if (!msg) { el.formError.hidden = true; el.formError.textContent = ""; el.url.removeAttribute("aria-invalid"); return; }
    el.formError.textContent = msg;
    el.formError.hidden = false;
    el.url.setAttribute("aria-invalid", "true");
    el.url.focus();
  }
  el.url.addEventListener("input", () => showFormError(""));

  // ---------- Job panel ----------
  function setView(which) {
    el.job.hidden = false;
    el.job.dataset.state = which;
    el.running.hidden = which !== "running";
    el.done.hidden = which !== "done";
    el.error.hidden = which !== "error";
  }

  function startTimer() {
    stopTimer();
    state.startedAt = Date.now();
    el.statTime.textContent = "0:00";
    state.timer = setInterval(() => {
      el.statTime.textContent = formatDuration(Date.now() - state.startedAt);
    }, 1000);
  }
  function stopTimer() { if (state.timer) clearInterval(state.timer); state.timer = null; }

  function setProgress(ratio) {
    if (ratio == null) {
      el.progress.classList.add("is-indeterminate");
      el.progress.removeAttribute("aria-valuenow");
      el.progressFill.style.width = "";
      return;
    }
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    el.progress.classList.remove("is-indeterminate");
    el.progress.setAttribute("aria-valuenow", String(pct));
    el.progressFill.style.width = `${pct}%`;
  }

  function resetPanel() {
    resetCounter(el.statPages, "0");
    resetCounter(el.statFiles, "0");
    resetCounter(el.statBytes, "0 B");
    el.statTime.textContent = "0:00";
    el.tickerUrl.textContent = "—";
    el.tickerUrl.title = "";
    el.phase.textContent = "Starting";
    el.logLines.textContent = "";
    state.logCount = 0;
    el.logCount.textContent = "0";
    el.log.open = false;
    setProgress(null);
    el.progress.setAttribute("aria-valuetext", "Starting");
    el.cancelBtn.disabled = false;
    el.cancelLabel.textContent = "Cancel";
    state.cancelling = false;
    if (state.cancelFallback) { clearTimeout(state.cancelFallback); state.cancelFallback = null; }
  }

  function appendLog(level, message) {
    const line = document.createElement("span");
    line.className = "log-line";
    line.dataset.level = String(level || "info").toLowerCase();
    const ts = document.createElement("span");
    ts.className = "t";
    ts.textContent = formatDuration(Date.now() - state.startedAt);
    const lv = document.createElement("span");
    lv.className = "lvl";
    lv.textContent = LEVEL_LABEL[line.dataset.level] || line.dataset.level.slice(0, 4).toUpperCase();
    line.append(ts, lv, document.createTextNode(String(message ?? "")));

    const atBottom = el.logLines.scrollHeight - el.logLines.scrollTop - el.logLines.clientHeight < 24;
    el.logLines.appendChild(line);
    state.logCount++;
    while (el.logLines.childElementCount > LOG_CAP) el.logLines.removeChild(el.logLines.firstElementChild);
    el.logCount.textContent = num(state.logCount);
    if (atBottom) el.logLines.scrollTop = el.logLines.scrollHeight;
  }

  function beginJob(url, options) {
    state.status = "running";
    state.lastUrl = url;
    state.lastOptions = options;
    resetPanel();
    setView("running");
    startTimer();
    const host = hostOf(url);
    el.host.textContent = host;
    setFormEnabled(false);
    document.title = `Downloading ${host} — SiteGrab`;
    announce(`Started downloading ${host}.`);
    appendLog("info", `Starting ${url} (depth ${options.singlePage ? 0 : options.maxDepth}, max ${options.maxPages} pages, ${options.maxSizeMB} MB)`);
    socket.emit("job:start", { url, options });
    el.job.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }

  function finishJob(data) {
    state.status = "done";
    stopTimer();
    setView("done");
    const host = hostOf(state.lastUrl);
    const filename = `${host || "site"}.zip`;
    el.doneHost.textContent = host;
    el.doneFilename.textContent = filename;
    el.donePages.textContent = num(data.pages);
    el.doneFiles.textContent = num(data.files);
    el.doneBytes.textContent = formatBytes(data.bytes);
    el.doneZip.textContent = formatBytes(data.zipBytes);
    el.doneTime.textContent = formatDuration(Date.now() - state.startedAt);
    const errs = Array.isArray(data.errors) ? data.errors.length : Number(data.errors) || 0;
    el.doneErrors.textContent = num(errs);
    el.downloadBtn.href = data.downloadUrl || "#";
    el.downloadBtn.setAttribute("download", filename);
    setFormEnabled(true);
    document.title = `Ready: ${host} — SiteGrab`;
    announce(`Done. ${num(data.pages)} pages and ${num(data.files)} files packed into a ${formatBytes(data.zipBytes)} ZIP. Download is ready.`);
    el.downloadBtn.focus({ preventScroll: true });
  }

  function failJob(message, title) {
    if (state.status !== "running") return;
    state.status = "error";
    stopTimer();
    setView("error");
    el.errTitle.textContent = title || "Something went wrong";
    el.errMsg.textContent = friendlyError(message);
    setFormEnabled(true);
    document.title = DEFAULT_TITLE;
    announce(`Error: ${el.errMsg.textContent}`);
    el.retryBtn.focus({ preventScroll: true });
  }

  function friendlyError(msg) {
    const m = String(msg || "").trim();
    if (!m) return "Something went wrong on the server. Please try again.";
    if (/cancel/i.test(m)) return "The download was cancelled. Nothing was saved.";
    if (/rate|too many|limit.*hour/i.test(m)) return "You have reached the hourly limit. Please wait a while and try again.";
    if (/concurrent|busy|capacity/i.test(m)) return "The server is busy with other downloads. Please try again in a minute.";
    if (/private|localhost|loopback|internal|blocked|not allowed|forbidden host/i.test(m)) return "That address points to a private or internal network, which is blocked.";
    if (/dns|resolve|ENOTFOUND|getaddrinfo/i.test(m)) return "That host could not be found. Check the address.";
    if (/timeout|timed out|ETIMEDOUT/i.test(m)) return "The site took too long to respond. Try again or lower the depth.";
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  function backToIdle() {
    state.status = "idle";
    stopTimer();
    el.job.hidden = true;
    el.job.dataset.state = "idle";
    setFormEnabled(true);
    document.title = DEFAULT_TITLE;
    el.url.focus();
    el.url.select();
    window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  }

  // ---------- Form ----------
  const OFFLINE_MSG = "Not connected to the server yet. Try again in a moment.";

  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.status === "running") return;
    const url = normalizeUrl(el.url.value);
    const err = url ? validateUrl(url) : "Enter a website address first.";
    if (err) { showFormError(err); return; }
    if (!state.connected) { showFormError(OFFLINE_MSG); return; }
    showFormError("");
    el.url.value = url;
    const options = readOptions();
    try { localStorage.setItem("sitegrab:opts", JSON.stringify(options)); } catch { /* ignore */ }
    beginJob(url, options);
  });

  el.cancelBtn.addEventListener("click", () => {
    if (state.status !== "running" || state.cancelling) return;
    state.cancelling = true;
    el.cancelBtn.disabled = true;
    el.cancelLabel.textContent = "Cancelling";
    el.phase.textContent = "Cancelling";
    appendLog("warn", "Cancel requested");
    socket.emit("job:cancel");
    // If the server never answers, don't leave the UI stuck.
    state.cancelFallback = setTimeout(() => failJob("cancelled", "Cancelled"), 4000);
  });

  el.againBtn.addEventListener("click", backToIdle);
  el.errAgainBtn.addEventListener("click", backToIdle);
  el.retryBtn.addEventListener("click", () => {
    if (!state.lastUrl) return backToIdle();
    if (!state.connected) { backToIdle(); showFormError(OFFLINE_MSG); return; }
    beginJob(state.lastUrl, state.lastOptions || readOptions());
  });

  // ---------- Socket ----------
  function setConn(status, label) {
    el.conn.dataset.state = status;
    el.connLabel.textContent = label;
    state.connected = status === "online";
  }

  const hasIO = typeof window.io === "function";
  const socket = hasIO
    ? window.io({ transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelayMax: 5000 })
    : { emit() {}, on() {}, io: { on() {} } };

  if (!hasIO) {
    setConn("offline", "Offline");
    showFormError("The realtime client could not be loaded. Is the server running?");
  } else {
    setConn("connecting", "Connecting");
  }

  socket.on("connect", () => {
    setConn("online", "Connected");
    if (el.formError.textContent === OFFLINE_MSG) showFormError("");
  });

  socket.on("disconnect", (reason) => {
    setConn("offline", "Offline");
    if (state.status === "running") {
      appendLog("error", `Connection lost (${reason})`);
      failJob("The connection to the server was lost and the download stopped. Check your network and try again.", "Connection lost");
    }
  });

  socket.on("connect_error", () => setConn("connecting", "Reconnecting"));
  socket.io.on("reconnect_attempt", () => setConn("connecting", "Reconnecting"));

  socket.on("job:progress", (p = {}) => {
    if (state.status !== "running") return;
    setCounter(el.statPages, p.pages || 0);
    setCounter(el.statFiles, p.files || 0);
    setCounter(el.statBytes, p.bytes || 0, formatBytes);
    if (p.current) {
      const cur = String(p.current);
      if (el.tickerUrl.textContent !== cur) {
        el.tickerUrl.textContent = cur;
        el.tickerUrl.title = cur;
      }
    }
    const pages = Number(p.pages) || 0;
    const files = Number(p.files) || 0;
    const bytes = Number(p.bytes) || 0;
    const o = state.lastOptions || readOptions();

    // Determinate estimate: whichever limit is closest to being hit, capped at 95% until done.
    if (o.singlePage || pages === 0) {
      setProgress(null);
    } else {
      const r = Math.max(pages / o.maxPages, bytes / (o.maxSizeMB * 1024 * 1024));
      setProgress(Math.min(0.95, Math.max(0.03, r)));
    }

    el.phase.textContent = state.cancelling
      ? "Cancelling"
      : pages === 0 ? "Fetching the first page"
      : `Crawling · ${num(pages)} page${pages === 1 ? "" : "s"}, ${num(files)} file${files === 1 ? "" : "s"}`;
    el.progress.setAttribute("aria-valuetext", `${pages} pages, ${files} files, ${formatBytes(bytes)} downloaded`);
  });

  socket.on("job:log", (l = {}) => {
    if (state.status !== "running") return;
    appendLog(l.level, l.message);
  });

  socket.on("job:done", (d = {}) => {
    if (state.status !== "running") return;
    if (state.cancelFallback) { clearTimeout(state.cancelFallback); state.cancelFallback = null; }
    setProgress(1);
    setCounter(el.statPages, d.pages || 0);
    setCounter(el.statFiles, d.files || 0);
    appendLog("success", `Done: ${num(d.pages)} pages, ${num(d.files)} files, ZIP ${formatBytes(d.zipBytes)}`);
    finishJob(d);
  });

  socket.on("job:error", (e = {}) => {
    if (state.status !== "running") return;
    if (state.cancelFallback) { clearTimeout(state.cancelFallback); state.cancelFallback = null; }
    const msg = e && typeof e === "object" ? e.message : e;
    appendLog("error", msg || "Unknown error");
    failJob(msg, state.cancelling || /cancel/i.test(String(msg)) ? "Cancelled" : undefined);
  });

  // Warn before leaving mid-download (server cancels on disconnect)
  window.addEventListener("beforeunload", (e) => {
    if (state.status === "running") { e.preventDefault(); e.returnValue = ""; }
  });

  // Cmd/Ctrl+K focuses the URL field
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); el.url.focus(); el.url.select(); }
  });
})();
