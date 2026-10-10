(function () {
  "use strict";

  // =====================================================================
  // helpers
  // =====================================================================
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function icon(name) { return '<svg><use href="#i-' + name + '"/></svg>'; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function haptic() { try { if (window.VizioBridge && VizioBridge.haptic) VizioBridge.haptic(); } catch (e) {} }

  function getJSON(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function setJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  // =====================================================================
  // data
  // =====================================================================
  var SERVICES = [
    { id: "Paramount+", label: "Paramount+", short: "P+", color: "#0064ff" },
    { id: "Max", label: "Max", short: "M", color: "#4b2bff" },
    { id: "Netflix", label: "Netflix", short: "N", color: "#e50914" },
    { id: "Hulu", label: "Hulu", short: "H", color: "#1ce783" },
    { id: "Disney+", label: "Disney+", short: "D+", color: "#113ccf" },
    { id: "Prime Video", label: "Prime Video", short: "PV", color: "#00a8e1" },
    { id: "Peacock", label: "Peacock", short: "Pk", color: "#f5b700" },
    { id: "YouTube", label: "YouTube", short: "YT", color: "#ff0033" },
    { id: "Other", label: "Other", short: "•", color: "#6b7280" }
  ];
  function service(id) {
    return SERVICES.find(function (s) { return s.id === id; }) || { id: id, label: id, short: "•", color: "#6b7280" };
  }

  function getTv() { return getJSON("remotetv.tvConfig", { ip: "", port: 0, authToken: "", paired: false, name: "" }); }
  function setTv(c) { setJSON("remotetv.tvConfig", c); renderTvChip(); }
  function getShows() { return getJSON("remotetv.shows", []); }
  function setShows(l) { setJSON("remotetv.shows", l); }
  function getApps() { return getJSON("remotetv.appConfigs", {}); }
  function setApps(a) { setJSON("remotetv.appConfigs", a); }

  function updateShow(id, fn) {
    var list = getShows();
    var s = list.find(function (x) { return x.id === id; });
    if (s) { fn(s); setShows(list); }
    return s;
  }

  // =====================================================================
  // nightly auto-advance
  // A "TV day" starts at 4 AM, so watching at 1 AM still counts as that night.
  // =====================================================================
  var DAY_START_HOUR = 4;
  function tvDay(date) {
    var t = new Date((date || new Date()).getTime() - DAY_START_HOUR * 3600e3);
    return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 864e5);
  }

  /** Bumps episodes for nights that have passed. Returns a list of changes for the undo toast. */
  function applyAutoAdvance() {
    var today = tvDay();
    var list = getShows();
    var changes = [];
    var dirty = false;
    list.forEach(function (s) {
      if (!s.auto || s.auto === "off") return;
      if (s.lastDay == null) { s.lastDay = today; dirty = true; return; }
      if (today <= s.lastDay) return;
      var bump = 0;
      if (s.auto === "nightly") {
        bump = today - s.lastDay;
      } else if (s.auto === "watched") {
        var last = s.lastDay;
        bump = (s.playedDays || []).filter(function (d) { return d >= last && d < today; }).length;
        s.playedDays = (s.playedDays || []).filter(function (d) { return d >= today; });
      }
      if (bump > 0) {
        changes.push({ id: s.id, name: s.name, from: s.episode, to: s.episode + bump });
        s.episode += bump;
      }
      s.lastDay = today;
      dirty = true;
    });
    if (dirty) setShows(list);
    return changes;
  }

  function checkAutoAdvance() {
    var changes = applyAutoAdvance();
    renderShows();
    if (!changes.length) return;
    var msg = changes.length === 1
      ? changes[0].name + " moved to episode " + changes[0].to
      : changes.length + " shows moved to their next episode";
    toast(msg, {
      action: "Undo",
      duration: 6000,
      onAction: function () {
        var list = getShows();
        changes.forEach(function (c) {
          var s = list.find(function (x) { return x.id === c.id; });
          if (s) s.episode = c.from;
        });
        setShows(list);
        renderShows();
      }
    });
  }

  // =====================================================================
  // native bridge -> TV
  // =====================================================================
  var pending = {};
  window.__nativeCb = function (id, json) {
    var cb = pending[id];
    delete pending[id];
    if (!cb) return;
    var res;
    try { res = JSON.parse(json); } catch (e) { res = { ok: false, error: "Bad response from app: " + json }; }
    cb(res);
  };
  function hasBridge() { return typeof window.VizioBridge !== "undefined"; }

  function rawRequest(host, method, path, body, token, timeout) {
    return new Promise(function (resolve) {
      if (!hasBridge()) { resolve({ ok: false, error: "Not running inside the app." }); return; }
      var id = uid();
      pending[id] = resolve;
      VizioBridge.requestAsync(id, host, method, path, body ? JSON.stringify(body) : "", token || "", timeout || 5000);
    });
  }

  /** Vizio answers HTTP 200 even for errors; the real result is in STATUS.RESULT. */
  function normalize(res) {
    if (res.body) { try { res.json = JSON.parse(res.body); } catch (e) {} }
    var result = res.json && res.json.STATUS && res.json.STATUS.RESULT;
    if (res.ok && result && String(result).toUpperCase() !== "SUCCESS") {
      res.ok = false;
      res.error = String(result).replace(/_/g, " ").toLowerCase();
      res.vizioResult = String(result).toUpperCase();
    }
    return res;
  }

  var PORTS = [7345, 9000]; // newer firmware uses 7345, older 9000

  async function tvCall(method, path, body, opts) {
    opts = opts || {};
    var cfg = getTv();
    if (!cfg.ip) return { ok: false, error: "No TV set up yet.", noTv: true };
    var ports = cfg.port ? [cfg.port] : PORTS.slice();
    if (cfg.port && !opts.noFallback) PORTS.forEach(function (p) { if (p !== cfg.port) ports.push(p); });
    var res;
    for (var i = 0; i < ports.length; i++) {
      res = normalize(await rawRequest(cfg.ip + ":" + ports[i], method, path, body, cfg.authToken, opts.timeout));
      if (res.status) { // reached something
        if (ports[i] !== cfg.port) { var c = getTv(); c.port = ports[i]; setTv(c); }
        return res;
      }
    }
    return res;
  }

  function describeError(res) {
    if (res.noTv) return "Set up your TV first.";
    if (res.vizioResult && /AUTH/.test(res.vizioResult)) return "The TV doesn't recognise this phone any more. Pair again in Settings.";
    if (!res.status) return "Couldn't reach the TV. Make sure it's plugged in and your phone is on the same WiFi.";
    return res.error || ("TV replied with error " + res.status);
  }

  var KEYS = {
    pow_on: [11, 1], pow_off: [11, 0], pow_toggle: [11, 2],
    vol_up: [5, 1], vol_down: [5, 0], mute_toggle: [5, 4],
    up: [3, 8], down: [3, 0], left: [3, 1], right: [3, 7], ok: [3, 2],
    back: [4, 0], menu: [4, 8], home: [4, 15],
    input_next: [7, 1], exit: [9, 0],
    play: [2, 3], pause: [2, 2], ffwd: [2, 0], rewind: [2, 1]
  };
  function sendKey(name) {
    var k = KEYS[name];
    return tvCall("PUT", "/key_command/", { KEYLIST: [{ CODESET: k[0], CODE: k[1], ACTION: "KEYPRESS" }] });
  }

  function readPowerOn(res) {
    if (!res.ok || !res.json) return null;
    var item = (res.json.ITEMS && res.json.ITEMS[0]) || res.json.ITEM;
    if (!item) return null;
    return Number(item.VALUE) !== 0;
  }

  // =====================================================================
  // toast
  // =====================================================================
  var toastTimer;
  function hideToast() { $("#toast").classList.remove("show"); document.body.classList.remove("toast-on"); }
  function toast(text, opts) {
    opts = opts || {};
    var el = $("#toast"), act = $("#toastAction");
    $("#toastText").textContent = text;
    el.classList.toggle("bad", !!opts.bad);
    act.classList.toggle("hidden", !opts.action);
    act.textContent = opts.action || "";
    act.onclick = function () { hideToast(); if (opts.onAction) opts.onAction(); };
    el.classList.add("show");
    document.body.classList.add("toast-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.duration || 3200);
  }

  // =====================================================================
  // navigation
  // =====================================================================
  var TITLES = { watch: "Watch", remote: "Remote", settings: "Settings" };
  var current = "watch";
  function showScreen(name) {
    current = name;
    $$(".screen").forEach(function (el) { el.classList.toggle("hidden", el.id !== "screen-" + name); });
    $$(".tab").forEach(function (el) { el.classList.toggle("active", el.dataset.screen === name); });
    $("#screenTitle").textContent = TITLES[name];
    $("#fab").classList.toggle("hidden", name !== "watch" || getShows().length === 0);
    if (name === "settings") renderSettings();
    window.scrollTo(0, 0);
  }
  $$(".tab").forEach(function (b) { b.addEventListener("click", function () { haptic(); showScreen(b.dataset.screen); }); });
  $("#tvChip").addEventListener("click", function () {
    var cfg = getTv();
    if (!cfg.paired) openOnboarding(cfg.ip ? "pair" : "find"); else showScreen("settings");
  });
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-action='add-show']");
    if (a) { haptic(); openShowSheet(null); }
  });

  function renderTvChip() {
    var cfg = getTv(), chip = $("#tvChip");
    chip.className = "tv-chip " + (!cfg.ip ? "" : cfg.paired ? "ok" : "warn");
    $("#tvChipText").textContent = !cfg.ip ? "Set up TV" : cfg.paired ? (cfg.name || "TV connected") : "Finish pairing";
  }

  // =====================================================================
  // sheet
  // =====================================================================
  var sheetOnClose = null;
  function openSheet(html, onClose) {
    $("#sheetBody").innerHTML = html;
    $("#scrim").classList.remove("hidden");
    var s = $("#sheet");
    s.setAttribute("aria-hidden", "false");
    requestAnimationFrame(function () { s.classList.add("open"); });
    sheetOnClose = onClose || null;
    return $("#sheetBody");
  }
  function closeSheet() {
    var s = $("#sheet");
    if (!s.classList.contains("open")) return false;
    s.classList.remove("open");
    s.setAttribute("aria-hidden", "true");
    $("#scrim").classList.add("hidden");
    var cb = sheetOnClose; sheetOnClose = null;
    if (cb) cb();
    return true;
  }
  $("#scrim").addEventListener("click", closeSheet);

  // =====================================================================
  // WATCH
  // =====================================================================
  function renderShows() {
    var shows = getShows();
    var wrap = $("#showList");
    $("#watchEmpty").classList.toggle("hidden", shows.length > 0);
    $("#fab").classList.toggle("hidden", current !== "watch" || shows.length === 0);
    var apps = getApps();

    wrap.innerHTML = shows.map(function (s, i) {
      var svc = service(s.service);
      var linked = !!apps[s.service];
      var status = s.auto === "nightly" ? icon("moon") + "Next ep. tomorrow"
        : s.auto === "watched" ? icon("moon") + "+1 after nights you watch" : "";
      return '' +
        '<article class="show" data-id="' + s.id + '" style="--brand:' + svc.color + ';animation-delay:' + (i * 40) + 'ms">' +
          '<div class="show-top">' +
            '<div class="show-info">' +
              '<div class="service-tag"><i></i>' + esc(svc.label) + '</div>' +
              '<h3 class="show-name">' + esc(s.name) + '</h3>' +
            '</div>' +
            '<button class="more-btn" data-act="edit" aria-label="Edit">' + icon("dots") + '</button>' +
          '</div>' +
          '<div class="show-mid">' +
            '<div class="upnext">' +
              '<div class="upnext-label">You\'re on</div>' +
              '<div class="upnext-val"><b>S' + s.season + '<span>·</span>E' + s.episode + '</b></div>' +
              (status ? '<div class="auto-badge">' + status + '</div>' : '') +
            '</div>' +
            '<button class="play-btn" data-act="play" aria-label="Open ' + esc(svc.label) + ' on TV">' + icon("play") + '</button>' +
          '</div>' +
          '<div class="show-bar">' +
            '<div class="stepper">' +
              '<button data-act="ep-" aria-label="Previous episode">' + icon("minus") + '</button>' +
              '<span>EP</span>' +
              '<button data-act="ep+" aria-label="Next episode">' + icon("plus") + '</button>' +
            '</div>' +
            '<button class="chip-btn" data-act="season">Next season</button>' +
            '<div class="show-status">' + (linked ? "Opens " + esc(svc.label) : "Tap ▶ to link app") + '</div>' +
          '</div>' +
        '</article>';
    }).join("");
  }

  $("#showList").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var id = btn.closest(".show").dataset.id;
    var show = getShows().find(function (s) { return s.id === id; });
    if (!show) return;
    haptic();
    switch (btn.dataset.act) {
      case "play": playShow(show, btn); break;
      case "edit": openShowSheet(show); break;
      case "ep+": updateShow(id, function (s) { s.episode += 1; }); renderShows(); break;
      case "ep-": updateShow(id, function (s) { s.episode = Math.max(1, s.episode - 1); }); renderShows(); break;
      case "season":
        var prev = { season: show.season, episode: show.episode };
        updateShow(id, function (s) { s.season += 1; s.episode = 1; });
        renderShows();
        toast(show.name + ": season " + (show.season + 1) + ", episode 1", {
          action: "Undo",
          onAction: function () { updateShow(id, function (s) { s.season = prev.season; s.episode = prev.episode; }); renderShows(); }
        });
        break;
    }
  });

  async function playShow(show, btn) {
    var cfg = getTv();
    if (!cfg.paired) { openOnboarding(cfg.ip ? "pair" : "find"); return; }
    var app = getApps()[show.service];
    if (!app) { openLinkSheet(show.service, function () { playShow(show, btn); }); return; }
    if (btn.classList.contains("busy")) return;

    var svc = service(show.service);
    btn.classList.add("busy");
    try {
      var power = await tvCall("GET", "/state/device/power_mode", null, { timeout: 4000 });
      if (!power.status) {
        toast("Couldn't reach the TV. If it's fully off, turn on Quick Start: TV Menu → System → Power Mode.", { bad: true, duration: 6000 });
        return;
      }
      if (readPowerOn(power) === false) {
        toast("Turning on the TV…");
        await sendKey("pow_on");
        await delay(5000);
      }
      toast("Opening " + svc.label + "…");
      var res = await tvCall("PUT", "/app/launch", { VALUE: { APP_ID: app.APP_ID, NAME_SPACE: app.NAME_SPACE, MESSAGE: app.MESSAGE } });
      if (!res.ok) { toast("Couldn't open " + svc.label + ": " + describeError(res), { bad: true, duration: 5000 }); return; }
      updateShow(show.id, function (s) {
        var d = tvDay();
        s.playedDays = (s.playedDays || []).filter(function (x) { return x !== d; }).concat([d]);
      });
      toast(svc.label + " is opening. Pick S" + show.season + " E" + show.episode + " from Continue Watching.", { duration: 4500 });
    } finally {
      btn.classList.remove("busy");
    }
  }

  // ---------- add / edit show ----------
  function openShowSheet(show) {
    var isNew = !show;
    var s = show || { name: "", service: "Paramount+", season: 1, episode: 1, auto: "nightly" };
    var sel = s.service;
    var auto = s.auto || "off";

    var body = openSheet(
      '<h2>' + (isNew ? "Add a show" : "Edit show") + '</h2>' +
      '<p class="lead">' + (isNew ? "Play will turn on the TV and open its app." : "") + '</p>' +
      '<div class="field"><label>Show name</label><input class="input" id="fName" placeholder="e.g. Tulsa King" value="' + esc(s.name) + '" maxlength="60"></div>' +
      '<div class="field"><label>Watch it on</label><div class="service-grid" id="fSvc">' +
        SERVICES.map(function (x) {
          return '<button class="service-opt' + (x.id === sel ? " sel" : "") + '" data-svc="' + esc(x.id) + '" style="--brand:' + x.color + '">' + esc(x.label) + '</button>';
        }).join("") +
      '</div></div>' +
      '<div class="field"><label>You\'re on</label><div class="two">' +
        numField("fSeason", "Season", s.season) + numField("fEp", "Episode", s.episode) +
      '</div></div>' +
      '<div class="field"><label>Move to next episode automatically</label><div class="seg" id="fAuto">' +
        segOpt("nightly", "Every night", "+1 episode each morning", auto) +
        segOpt("watched", "Only nights I watch", "+1 the morning after you tap Play", auto) +
        segOpt("off", "Off", "I'll update it myself", auto) +
      '</div></div>' +
      '<div class="sheet-actions">' +
        '<button class="btn primary big block" id="fSave">' + (isNew ? "Add show" : "Save") + '</button>' +
        (isNew ? '' : '<button class="btn danger block" id="fDelete">Delete show</button>') +
      '</div>'
    );

    $$("#fSvc .service-opt", body).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic(); sel = b.dataset.svc;
        $$("#fSvc .service-opt", body).forEach(function (x) { x.classList.toggle("sel", x === b); });
      });
    });
    $$("#fAuto .seg-opt", body).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic(); auto = b.dataset.val;
        $$("#fAuto .seg-opt", body).forEach(function (x) { x.classList.toggle("sel", x === b); });
      });
    });
    wireNumFields(body);
    if (isNew) setTimeout(function () { $("#fName").focus(); }, 350);

    $("#fSave").addEventListener("click", function () {
      var name = $("#fName").value.trim();
      if (!name) { $("#fName").focus(); toast("Give the show a name"); return; }
      var season = Math.max(1, parseInt($("#fSeason").value, 10) || 1);
      var ep = Math.max(1, parseInt($("#fEp").value, 10) || 1);
      var list = getShows();
      if (isNew) {
        list.push({ id: uid(), name: name, service: sel, season: season, episode: ep, auto: auto, lastDay: tvDay(), playedDays: [] });
      } else {
        var t = list.find(function (x) { return x.id === show.id; });
        if (t) {
          if (t.auto !== auto) t.lastDay = tvDay();
          t.name = name; t.service = sel; t.season = season; t.episode = ep; t.auto = auto;
        }
      }
      setShows(list);
      closeSheet();
      renderShows();
      haptic();
      if (isNew) toast(name + " added");
    });

    if (!isNew) {
      $("#fDelete").addEventListener("click", function () {
        var list = getShows();
        var idx = list.findIndex(function (x) { return x.id === show.id; });
        var removed = list.splice(idx, 1)[0];
        setShows(list);
        closeSheet();
        renderShows();
        toast(removed.name + " deleted", {
          action: "Undo",
          onAction: function () { var l = getShows(); l.splice(idx, 0, removed); setShows(l); renderShows(); }
        });
      });
    }
  }

  function numField(id, label, val) {
    return '<div><div class="num-cap">' + label + '</div><div class="num-field" aria-label="' + label + '">' +
      '<button data-num="' + id + '" data-d="-1">' + icon("minus") + '</button>' +
      '<input id="' + id + '" type="number" inputmode="numeric" min="1" value="' + val + '">' +
      '<button data-num="' + id + '" data-d="1">' + icon("plus") + '</button>' +
    '</div></div>';
  }
  function wireNumFields(root) {
    $$("[data-num]", root).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic();
        var inp = $("#" + b.dataset.num);
        inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + Number(b.dataset.d));
      });
    });
  }
  function segOpt(val, title, sub, cur) {
    return '<button class="seg-opt' + (val === cur ? " sel" : "") + '" data-val="' + val + '"><span class="radio"></span><span><b>' + title + '</b><small>' + sub + '</small></span></button>';
  }

  // ---------- link a streaming app ----------
  function openLinkSheet(serviceId, then) {
    var svc = service(serviceId);
    var body = openSheet(
      '<h2>Link ' + esc(svc.label) + '</h2>' +
      '<p class="lead">This only needs doing once. It shows the app which streaming app to open.</p>' +
      '<ol class="steps">' +
        '<li><span>Using your normal TV remote, <b>open ' + esc(svc.label) + '</b> on the TV.</span></li>' +
        '<li><span>When it\'s on screen, tap the button below.</span></li>' +
      '</ol>' +
      '<div class="note">Play opens ' + esc(svc.label) + '. Your show is usually first in its Continue Watching row.</div>' +
      '<div class="status-msg" id="linkMsg"></div>' +
      '<div class="sheet-actions">' +
        '<button class="btn primary big block" id="linkGo">' + icon("link") + esc(svc.label) + ' is open — link it</button>' +
        '<button class="btn ghost block" id="linkCancel">Not now</button>' +
      '</div>'
    );
    $("#linkCancel").addEventListener("click", closeSheet);
    $("#linkGo").addEventListener("click", async function () {
      var b = this;
      b.disabled = true;
      setMsg("linkMsg", "Checking what's open on the TV…");
      var res = await tvCall("GET", "/app/current", null);
      b.disabled = false;
      var item = res.ok && res.json && res.json.ITEM;
      var val = item && (item.VALUE || item);
      if (!val || val.APP_ID == null) {
        setMsg("linkMsg", res.ok ? "No app seems to be open. Open " + svc.label + " on the TV and try again." : describeError(res), "bad");
        return;
      }
      var apps = getApps();
      apps[serviceId] = { APP_ID: val.APP_ID, NAME_SPACE: val.NAME_SPACE, MESSAGE: val.MESSAGE != null ? val.MESSAGE : null };
      setApps(apps);
      haptic();
      closeSheet();
      renderShows();
      if (current === "settings") renderSettings();
      toast(svc.label + " linked");
      if (then) then();
    });
  }

  function setMsg(id, text, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "status-msg" + (cls ? " " + cls : "");
  }

  // =====================================================================
  // REMOTE
  // =====================================================================
  var lastKeyErr = 0;
  async function pressKey(name, el) {
    var res = await sendKey(name);
    if (!res.ok) {
      el.classList.add("flash-bad");
      setTimeout(function () { el.classList.remove("flash-bad"); }, 400);
      if (Date.now() - lastKeyErr > 4000) {
        lastKeyErr = Date.now();
        var cfg = getTv();
        toast(!cfg.paired ? "Set up your TV first (tap the chip at the top)." : describeError(res), { bad: true });
      }
    }
  }

  $$("[data-key]").forEach(function (el) {
    var repeatTimer, startTimer;
    function stop() { clearTimeout(startTimer); clearInterval(repeatTimer); }
    el.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      haptic();
      pressKey(el.dataset.key, el);
      if (el.hasAttribute("data-repeat")) {
        startTimer = setTimeout(function () {
          repeatTimer = setInterval(function () { haptic(); pressKey(el.dataset.key, el); }, 160);
        }, 450);
      }
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { el.addEventListener(ev, stop); });
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  });

  // =====================================================================
  // SETTINGS
  // =====================================================================
  function renderSettings() {
    var cfg = getTv();
    var tvCard = $("#tvCard");
    var state = !cfg.ip ? "Not set up" : cfg.paired ? "Paired · " + cfg.ip : "Not paired yet · " + cfg.ip;
    tvCard.innerHTML =
      '<div class="tv-hero"><div class="ri-icon">' + icon("tv") + '</div><div class="ri-main">' +
        '<div class="ri-title">' + esc(cfg.name || "Vizio TV") + '</div>' +
        '<div class="ri-sub' + (cfg.paired ? " good" : "") + '">' + esc(state) + '</div></div></div>' +
      '<div class="btn-row">' +
        (cfg.paired
          ? '<button class="btn" id="sTest">Test connection</button><button class="btn" id="sRepair">Pair again</button>'
          : '<button class="btn primary" id="sSetup">' + (cfg.ip ? "Finish pairing" : "Set up TV") + '</button>') +
      '</div>' +
      (cfg.ip ? '<div class="btn-row" style="margin-top:10px"><button class="btn ghost" id="sChange">Use a different TV</button></div>' : '') +
      '<div class="status-msg" id="sMsg"></div>';

    var on = function (id, fn) { var el = document.getElementById(id); if (el) el.addEventListener("click", function () { haptic(); fn(); }); };
    on("sSetup", function () { openOnboarding(cfg.ip ? "pair" : "find"); });
    on("sRepair", function () { openOnboarding("pair"); });
    on("sChange", function () { openOnboarding("find"); });
    on("sTest", async function () {
      setMsg("sMsg", "Checking…");
      var res = await tvCall("GET", "/state/device/power_mode", null);
      if (!res.status) return setMsg("sMsg", describeError(res), "bad");
      var p = readPowerOn(res);
      setMsg("sMsg", "Connected. The TV is " + (p === false ? "in standby." : "on."), "ok");
    });

    var apps = getApps();
    var used = {};
    getShows().forEach(function (s) { used[s.service] = true; });
    var ids = SERVICES.map(function (s) { return s.id; }).filter(function (id) { return used[id] || apps[id]; });
    if (!ids.length) {
      $("#appList").innerHTML = '<div class="row-item"><div class="ri-main"><div class="ri-sub">Apps show up here once you add a show.</div></div></div>';
      return;
    }
    $("#appList").innerHTML = ids.map(function (id) {
      var svc = service(id), ok = !!apps[id];
      return '<div class="row-item"><div class="ri-icon" style="background:' + svc.color + '">' + esc(svc.short) + '</div>' +
        '<div class="ri-main"><div class="ri-title">' + esc(svc.label) + '</div>' +
        '<div class="ri-sub' + (ok ? " good" : "") + '">' + (ok ? "Linked" : "Not linked yet") + '</div></div>' +
        '<button class="pill-btn' + (ok ? "" : " accent") + '" data-link="' + esc(id) + '">' + (ok ? "Re-link" : "Link") + '</button></div>';
    }).join("");
    $$("[data-link]", $("#appList")).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic();
        if (!getTv().paired) { openOnboarding("find"); return; }
        openLinkSheet(b.dataset.link);
      });
    });
  }

  // =====================================================================
  // ONBOARDING (find TV -> pair)
  // =====================================================================
  var ob = { step: "welcome", found: null, scanning: false, pair: null };
  var OB_ORDER = ["welcome", "find", "pair", "done"];

  function openOnboarding(step) {
    ob.step = step || "welcome";
    $("#onboard").classList.remove("hidden");
    renderOnboarding();
  }
  function closeOnboarding() {
    setJSON("remotetv.onboarded", true);
    $("#onboard").classList.add("hidden");
    renderTvChip();
    renderShows();
    if (current === "settings") renderSettings();
  }

  function renderOnboarding() {
    var el = $("#onboard");
    var idx = OB_ORDER.indexOf(ob.step);
    var dots = '<div class="ob-dots">' + [0, 1, 2].map(function (i) { return '<i class="' + (i === Math.min(idx, 2) ? "on" : "") + '"></i>'; }).join("") + '</div>';
    var skip = ob.step !== "done" ? '<button class="link-btn" id="obSkip">' + (ob.step === "welcome" ? "Skip" : "Close") + '</button>' : '<span></span>';
    var html = '<div class="ob-top">' + dots + skip + '</div><div class="ob-body">';

    if (ob.step === "welcome") {
      html +=
        '<div class="ob-art">' + icon("play") + '</div>' +
        '<h1>One tap to start your show</h1>' +
        '<p class="lead">This app turns on your Vizio TV and opens the right streaming app. First, let\'s connect to your TV. It takes about a minute.</p>' +
        '<div class="ob-actions"><button class="btn primary big block" id="obNext">Get started</button></div>';
    } else if (ob.step === "find") {
      html +=
        '<div class="ob-art">' + icon("search") + '</div>' +
        '<h1>Find your TV</h1>' +
        '<p class="lead">Make sure the TV is on and your phone is on the same WiFi.</p>';
      if (ob.scanning) {
        html += '<div class="scanning"><div class="spinner"></div>Looking for TVs on your WiFi…</div>';
      } else if (ob.found && ob.found.length) {
        html += '<div class="found-list">' + ob.found.map(function (f, i) {
          return '<button class="found" data-found="' + i + '"><div class="ri-icon">' + icon("tv") + '</div><div class="ri-main">' +
            '<div class="ri-title">' + esc(f.name || "Vizio TV") + '</div><div class="ri-sub">' + esc(f.ip) + '</div></div></button>';
        }).join("") + '</div>';
      } else if (ob.found) {
        html += '<div class="note" style="margin-bottom:18px">No TV found. Check the TV is on and try again, or type its IP address. You\'ll find it on the TV under Menu → Network → Network Connection.</div>';
      }
      html +=
        '<div class="ob-actions">' +
          (ob.scanning ? '' : '<button class="btn ' + (ob.found && ob.found.length ? "" : "primary ") + 'big block" id="obScan">' + icon("search") + (ob.found ? "Search again" : "Search for my TV") + '</button>') +
          '<details style="margin-top:6px"><summary class="link-btn" style="list-style:none;text-align:center">Enter IP address instead</summary>' +
            '<div style="display:flex;gap:10px;margin-top:10px"><input class="input" id="obIp" inputmode="decimal" placeholder="192.168.1.50" value="' + esc(getTv().ip) + '">' +
            '<button class="btn primary" id="obIpGo">Next</button></div></details>' +
        '</div>';
    } else if (ob.step === "pair") {
      html +=
        '<div class="ob-art">' + icon("link") + '</div>' +
        '<h1>Enter the PIN on your TV</h1>' +
        '<p class="lead" id="obPairLead">Asking the TV for a PIN…</p>' +
        '<input class="pin-input" id="obPin" inputmode="numeric" maxlength="6" placeholder="····" autocomplete="one-time-code">' +
        '<div class="status-msg" id="obMsg"></div>' +
        '<div class="ob-actions" style="margin-top:18px">' +
          '<button class="btn primary big block" id="obPair">Pair</button>' +
          '<button class="link-btn" id="obRetry">No PIN on the TV? Try again</button>' +
        '</div>';
    } else if (ob.step === "done") {
      html +=
        '<div class="ob-art" style="background:linear-gradient(135deg,#38d39f,#2bb3c0)">' + icon("check") + '</div>' +
        '<h1>You\'re connected</h1>' +
        '<p class="lead">Now add the shows you\'re watching. Each one gets a Play button that turns on the TV and opens its app.</p>' +
        '<div class="ob-actions"><button class="btn primary big block" id="obDone">' + (getShows().length ? "Done" : "Add my first show") + '</button></div>';
    }
    html += '</div>';
    el.innerHTML = html;

    var on = function (id, fn) { var b = document.getElementById(id); if (b) b.addEventListener("click", function () { haptic(); fn(); }); };
    on("obSkip", closeOnboarding);
    on("obNext", function () { ob.step = "find"; renderOnboarding(); if (!ob.found) startScan(); });
    on("obScan", startScan);
    on("obIpGo", function () {
      var ip = $("#obIp").value.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast("That doesn't look like an IP address"); return; }
      chooseTv({ ip: ip, port: 0, name: "" });
    });
    $$("[data-found]", el).forEach(function (b) {
      b.addEventListener("click", function () { haptic(); chooseTv(ob.found[Number(b.dataset.found)]); });
    });
    on("obPair", submitPin);
    on("obRetry", startPairing);
    on("obDone", function () { var add = !getShows().length; closeOnboarding(); if (add) openShowSheet(null); });

    var pin = $("#obPin");
    if (pin) {
      pin.addEventListener("keydown", function (e) { if (e.key === "Enter") submitPin(); });
      if (!ob.pair) startPairing();
      else $("#obPairLead").textContent = "A PIN should be showing on your TV screen.";
    }
  }

  function startScan() {
    if (!hasBridge()) { ob.found = []; renderOnboarding(); return; }
    ob.scanning = true; renderOnboarding();
    var id = uid();
    pending[id] = function (res) {
      ob.scanning = false;
      ob.found = (res.ok && res.found) || [];
      if (!res.ok) toast(res.error || "Search failed", { bad: true });
      if (ob.step === "find") {
        if (ob.found.length === 1) { chooseTv(ob.found[0]); return; }
        renderOnboarding();
      }
    };
    VizioBridge.scanAsync(id);
  }

  function chooseTv(f) {
    var c = getTv();
    if (c.ip !== f.ip) { c.authToken = ""; c.paired = false; }
    c.ip = f.ip; c.port = f.port || 0; c.name = f.name || c.name || "";
    setTv(c);
    ob.pair = null;
    ob.step = "pair";
    renderOnboarding();
  }

  async function startPairing() {
    ob.pair = null;
    var lead = $("#obPairLead");
    if (lead) lead.textContent = "Asking the TV for a PIN…";
    setMsg("obMsg", "");
    var deviceId = "remotetv-" + uid();
    var res = await tvCall("PUT", "/pairing/start", { DEVICE_NAME: "Remote app", DEVICE_ID: deviceId });
    if (ob.step !== "pair") return;
    if (!res.ok || !res.json || !res.json.ITEM) {
      if (lead) lead.textContent = "The TV didn't respond.";
      setMsg("obMsg", describeError(res) + (res.status ? "" : "\nIs the TV on? You can go back and pick a different TV."), "bad");
      return;
    }
    ob.pair = { deviceId: deviceId, token: res.json.ITEM.PAIRING_REQ_TOKEN, challenge: res.json.ITEM.CHALLENGE_TYPE || 1 };
    if (lead) lead.textContent = "A PIN is now showing on your TV screen.";
    var pin = $("#obPin"); if (pin) pin.focus();
  }

  async function submitPin() {
    var pin = ($("#obPin").value || "").trim();
    if (!ob.pair) { setMsg("obMsg", "Waiting for the TV. Tap \"Try again\" if no PIN appears.", "bad"); return; }
    if (!pin) { $("#obPin").focus(); return; }
    var b = $("#obPair"); b.disabled = true;
    setMsg("obMsg", "Pairing…");
    var res = await tvCall("PUT", "/pairing/pair", {
      DEVICE_ID: ob.pair.deviceId, CHALLENGE_TYPE: ob.pair.challenge,
      RESPONSE_VALUE: pin, PAIRING_REQ_TOKEN: ob.pair.token
    });
    b.disabled = false;
    var token = res.ok && res.json && res.json.ITEM && res.json.ITEM.AUTH_TOKEN;
    if (!token) {
      setMsg("obMsg", "That PIN didn't work. Check it, or tap Try again for a new one.", "bad");
      return;
    }
    var c = getTv();
    c.deviceId = ob.pair.deviceId; c.authToken = token; c.paired = true;
    setTv(c);
    ob.pair = null;
    haptic();
    ob.step = "done";
    renderOnboarding();
  }

  // =====================================================================
  // Android back button + resume
  // =====================================================================
  window.onAndroidBack = function () {
    if (closeSheet()) return true;
    if (!$("#onboard").classList.contains("hidden")) {
      var i = OB_ORDER.indexOf(ob.step);
      if (i > 0 && ob.step !== "done") { ob.step = OB_ORDER[i - 1]; renderOnboarding(); }
      else closeOnboarding();
      return true;
    }
    if (current !== "watch") { showScreen("watch"); return true; }
    return false;
  };
  window.onAppResume = function () { checkAutoAdvance(); };
  document.addEventListener("visibilitychange", function () { if (!document.hidden) checkAutoAdvance(); });

  // =====================================================================
  // boot
  // =====================================================================
  // Older versions stored shows without auto-advance info.
  (function migrate() {
    var list = getShows(), dirty = false;
    list.forEach(function (s) {
      if (!s.auto) { s.auto = "off"; dirty = true; }
      if (!s.season) { s.season = 1; dirty = true; }
      if (!s.episode) { s.episode = 1; dirty = true; }
    });
    if (dirty) setShows(list);
  })();

  renderTvChip();
  checkAutoAdvance();
  showScreen("watch");
  if (!getTv().paired && !getJSON("remotetv.onboarded", false)) openOnboarding("welcome");
})();
