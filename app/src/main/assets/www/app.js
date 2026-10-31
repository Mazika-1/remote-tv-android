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
  // streaming apps
  // Launch codes are Vizio's own, as used by the pyvizio library (Home
  // Assistant's Vizio integration). Linking an app from the TV overrides them.
  // =====================================================================
  var SERVICES = [
    { id: "Max", label: "HBO Max", short: "M", color: "#4b2bff", app: { NAME_SPACE: 2, APP_ID: "128", MESSAGE: null } },
    { id: "Paramount+", label: "Paramount+", short: "P+", color: "#0064ff", app: { NAME_SPACE: 2, APP_ID: "37", MESSAGE: null } },
    { id: "Netflix", label: "Netflix", short: "N", color: "#e50914", app: { NAME_SPACE: 3, APP_ID: "1", MESSAGE: null } },
    { id: "Hulu", label: "Hulu", short: "H", color: "#1ce783", app: { NAME_SPACE: 2, APP_ID: "3", MESSAGE: null } },
    { id: "Disney+", label: "Disney+", short: "D+", color: "#113ccf", app: { NAME_SPACE: 2, APP_ID: "75", MESSAGE: null } },
    { id: "Prime Video", label: "Prime Video", short: "PV", color: "#00a8e1", app: { NAME_SPACE: 2, APP_ID: "4", MESSAGE: null } },
    { id: "Peacock", label: "Peacock", short: "Pk", color: "#f5b700", app: { NAME_SPACE: 2, APP_ID: "88", MESSAGE: null } },
    { id: "YouTube", label: "YouTube", short: "YT", color: "#ff0033", app: { NAME_SPACE: 5, APP_ID: "1", MESSAGE: null } },
    { id: "Other", label: "Other", short: "•", color: "#6b7280", app: null }
  ];
  function service(id) {
    return SERVICES.find(function (s) { return s.id === id; }) || { id: id, label: id, short: "•", color: "#6b7280", app: null };
  }
  function getLinked() { return getJSON("remotetv.appConfigs", {}); }
  function setLinked(a) { setJSON("remotetv.appConfigs", a); }
  function appFor(serviceId) { return getLinked()[serviceId] || service(serviceId).app; }

  // =====================================================================
  // TVs (several can be paired; one is active)
  // =====================================================================
  function getTvs() { return getJSON("remotetv.tvs", []); }
  function setTvs(l) { setJSON("remotetv.tvs", l); renderTvChip(); }
  function activeId() { return getJSON("remotetv.activeTv", null); }
  function setActive(id) {
    var changed = activeId() !== id;
    setJSON("remotetv.activeTv", id);
    renderTvChip();
    if (!changed) return;
    // Everything on screen now refers to the newly selected TV.
    if (typeof ready !== "undefined") ready = null;
    if (typeof volTarget !== "undefined") volTarget = null;
    if (typeof renderShows === "function" && document.getElementById("showList")) renderShows();
    if (typeof current !== "undefined" && current === "remote" && typeof refreshVolume === "function") { showVolume(null); refreshVolume(); }
    if (typeof current !== "undefined" && current === "settings") renderSettings();
  }
  /** Switching TVs while Play or recording is running would send the rest of it to the other TV. */
  function canSwitchTv() {
    if (playing || teach) { toast("Wait until the current Play finishes (or tap Stop) before switching TVs.", { bad: true }); return false; }
    return true;
  }
  function activeTv() {
    var tvs = getTvs(), id = activeId();
    return tvs.find(function (t) { return t.id === id; }) || tvs[0] || null;
  }
  function updateTv(id, fn) {
    var l = getTvs(), t = l.find(function (x) { return x.id === id; });
    if (t) { fn(t); setTvs(l); }
    return t;
  }
  function tvLabel(t) { return (t && (t.name || t.model)) || "Vizio TV"; }

  // =====================================================================
  // shows
  // =====================================================================
  function getShows() { return getJSON("remotetv.shows", []); }
  function setShows(l) { setJSON("remotetv.shows", l); }
  function findShow(id) { return getShows().find(function (s) { return s.id === id; }); }
  function updateShow(id, fn) {
    var list = getShows(), s = list.find(function (x) { return x.id === id; });
    if (s) { fn(s); setShows(list); }
    return s;
  }

  // ---------- nightly auto-advance (a "TV day" starts at 4 AM) ----------
  var DAY_START_HOUR = 4;
  function tvDay(date) {
    var t = new Date((date || new Date()).getTime() - DAY_START_HOUR * 3600e3);
    return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / 864e5);
  }
  /** Episodes to move forward per night (per show; new shows start from the Settings default). */
  function defaultPerNight() { return Math.max(1, Math.min(10, getJSON("remotetv.perNight", 1))); }
  function perNight(s) { return Math.max(1, Math.min(10, Number(s.perNight) || 1)); }

  function applyAutoAdvance() {
    var today = tvDay(), list = getShows(), changes = [], dirty = false;
    list.forEach(function (s) {
      if (!s.auto || s.auto === "off") return;
      if (s.lastDay == null) { s.lastDay = today; dirty = true; return; }
      if (today <= s.lastDay) return;
      var bump = 0;
      if (s.auto === "nightly") {
        bump = (today - s.lastDay) * perNight(s);
      } else if (s.auto === "watched") {
        var last = s.lastDay;
        bump = (s.playedDays || []).filter(function (d) { return d >= last && d < today; }).length * perNight(s);
        s.playedDays = (s.playedDays || []).filter(function (d) { return d >= today; });
      }
      if (bump > 0) { changes.push({ id: s.id, name: s.name, from: s.episode, to: s.episode + bump }); s.episode += bump; }
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
    toast(changes.length === 1 ? changes[0].name + " moved to episode " + changes[0].to
      : changes.length + " shows moved to their next episode", {
      action: "Undo", duration: 6000,
      onAction: function () {
        var list = getShows();
        changes.forEach(function (c) { var s = list.find(function (x) { return x.id === c.id; }); if (s) s.episode = c.from; });
        setShows(list); renderShows();
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

  // Recent requests, for "Copy details" in Fix connection.
  var reqLog = [];
  function logReq(entry) { reqLog.push(entry); if (reqLog.length > 40) reqLog.shift(); }

  function rawRequest(host, method, path, body, token, timeout) {
    return new Promise(function (resolve) {
      if (!hasBridge()) { resolve({ ok: false, error: "Not running inside the app." }); return; }
      var id = uid(), started = Date.now();
      pending[id] = function (res) {
        var r = {}; try { r = JSON.parse(JSON.stringify(res)); } catch (e) {}
        var result = r.error || ("HTTP " + r.status + (r.body ? " " + String(r.body).slice(0, 90) : ""));
        logReq(new Date(started).toTimeString().slice(0, 8) + " " + method + " " + host + path + " → " + result + " (" + (Date.now() - started) + "ms)");
        resolve(res);
      };
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

  /**
   * Every request to the selected TV goes through here. Before talking to it,
   * the app checks the TV at that address really is the one you picked
   * (routers can hand a TV's address to another device). If it isn't,
   * nothing is sent. opts.tv calls a specific TV instead and skips the check.
   */
  async function tvCall(method, path, body, opts) {
    opts = opts || {};
    if (opts.tv) return rawTvCall(method, path, body, opts);
    var tv = activeTv();
    // Remote buttons fail straight away while the TV is known to be unreachable,
    // instead of each press waiting ~20s and piling up behind the others.
    if (opts.fast && tv && isOffline(tv)) return { ok: false, error: unreachableMessage(tv), failedFast: true };
    if (!opts.noVerify) {
      var v = await verifyActive();
      if (!v.ok) { markHealth(tv, false); return { ok: false, error: v.error, wrongTv: true }; }
    }
    var res = await rawTvCall(method, path, body, opts);
    markHealth(tv, !!res.status);
    return res;
  }

  var health = {}; // tvId -> { ok, at }
  function markHealth(tv, ok) {
    if (!tv) return;
    var prev = health[tv.id];
    health[tv.id] = { ok: ok, at: Date.now() };
    if (!prev || prev.ok !== ok) renderTvChip();
  }
  function isOffline(tv) {
    var h = tv && health[tv.id];
    return !!h && !h.ok && Date.now() - h.at < 15000;
  }

  async function rawTvCall(method, path, body, opts) {
    opts = opts || {};
    var tv = opts.tv || activeTv();
    if (!tv || !tv.ip) return { ok: false, error: "No TV set up yet.", noTv: true };
    var ports = tv.port ? [tv.port] : [];
    PORTS.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); });
    var res;
    // A TV on WiFi can be slow to answer the first request after sitting idle,
    // so if we couldn't even connect, wait a moment and try again, more patiently.
    var tries = opts.noRetry ? 1 : 2;
    for (var attempt = 0; attempt < tries; attempt++) {
      if (attempt) await delay(800);
      var timeout = attempt ? Math.max(opts.timeout || 5000, 7000) : opts.timeout;
      for (var i = 0; i < ports.length; i++) {
        res = normalize(await rawRequest(tv.ip + ":" + ports[i], method, path, body, tv.authToken, timeout));
        if (res.status) { // reached something
          if (ports[i] !== tv.port) {
            tv.port = ports[i];
            if (tv.id) updateTv(tv.id, function (t) { t.port = ports[i]; });
          }
          return res;
        }
      }
      // Only retry when the request never got there (safe: it can't double-press a button).
      if (!/connect|unreachable|refused|no route|timed out/i.test(res.error || "") || /read timed out/i.test(res.error || "")) break;
    }
    return res;
  }

  // ---------- explaining why a TV can't be reached ----------
  function phoneNetwork() {
    try { return JSON.parse(VizioBridge.networkStatus()); } catch (e) { return null; }
  }
  function unreachableMessage(tv) {
    var name = tvLabel(tv), net = hasBridge() && VizioBridge.networkStatus ? phoneNetwork() : null;
    if (net && !net.wifi) return "Your phone isn't on WiFi right now (it may be using mobile data), so it can't reach " + name + ". Connect to the same WiFi as the TV.";
    var sub = function (ip) { return String(ip || "").split(".").slice(0, 3).join("."); };
    if (net && net.ip && tv && tv.ip && sub(net.ip) !== sub(tv.ip)) {
      return "Your phone is on a different WiFi network (" + sub(net.ip) + ".x) than " + name + " (" + sub(tv.ip) + ".x). Switch your phone to the TV's WiFi, or re-add the TV in Settings.";
    }
    return name + " didn't answer, and the app couldn't find it on your WiFi. If it's on, check it's connected to WiFi (TV Menu → Network). If it's off, turn on Quick Start (Menu → System → Power Mode) so the phone can wake it.";
  }

  // ---------- making sure it's the TV you picked ----------
  function identFrom(res) {
    var body = (res && res.body) || "";
    var sn = /"SERIAL_NUMBER"\s*:\s*"([^"]+)"/.exec(body);
    if (sn) return "sn:" + sn[1];
    var mn = /"MODEL_NAME"\s*:\s*"([^"]+)"/.exec(body), nm = /"(?:CAST_NAME|NAME)"\s*:\s*"([^"]+)"/.exec(body);
    return mn || nm ? "mn:" + (mn ? mn[1] : "") + "|" + (nm ? nm[1] : "") : null;
  }
  function modelFrom(res) {
    var mn = /"MODEL_NAME"\s*:\s*"([^"]+)"/.exec((res && res.body) || "");
    return mn ? mn[1] : "";
  }
  function isAuthErr(res) { return !!(res && res.vizioResult && /AUTH/.test(res.vizioResult)); }

  /** Who is at this address? {reached, ident, model, authBad} */
  async function probeTv(target) {
    var res = await rawTvCall("GET", "/state/device/deviceinfo", null, { tv: target, timeout: 2500 });
    return { reached: !!res.status, ident: identFrom(res), model: modelFrom(res), authBad: isAuthErr(res) };
  }
  /** Does this TV accept our pairing code? (Another TV won't.) */
  async function acceptsToken(target) {
    var res = await rawTvCall("GET", "/menu_native/dynamic/tv_settings/audio/volume", null, { tv: target, timeout: 2500 });
    return !!res.status && !isAuthErr(res);
  }
  function strongIdent(tv) { return !!(tv.ident && tv.ident.indexOf("sn:") === 0); }
  function looksLikeTv(tv, probe) {
    if (probe.authBad) return false;
    if (tv.ident && probe.ident) return probe.ident === tv.ident;
    if (tv.model && probe.model && tv.model.toUpperCase() !== probe.model.toUpperCase()) return false;
    return true;
  }

  var verifiedAt = {}, verifying = null, lastSearchFail = {};
  function verifyActive() {
    var tv = activeTv();
    if (!tv || !tv.ip || !tv.paired) return Promise.resolve({ ok: true });
    var key = tv.id + "@" + tv.ip;
    if (verifiedAt[key] && Date.now() - verifiedAt[key] < 180000) return Promise.resolve({ ok: true });
    if (!verifying) {
      verifying = verifyTv(tv).then(function (r) { verifying = null; if (r.ok && r.cache) verifiedAt[r.key || key] = Date.now(); return r; },
        function () { verifying = null; return { ok: true }; });
    }
    return verifying;
  }
  async function verifyTv(tv) {
    var probe = await probeTv(tv);
    if (!probe.reached) {
      // Nothing at the saved address. The router may have given the TV a new one: look for it.
      if (Date.now() - (lastSearchFail[tv.id] || 0) < 120000) return { ok: false, error: unreachableMessage(tv) };
      var net = hasBridge() && VizioBridge.networkStatus ? phoneNetwork() : null;
      var sub = function (ip) { return String(ip || "").split(".").slice(0, 3).join("."); };
      if (net && (!net.wifi || (net.ip && sub(net.ip) !== sub(tv.ip)))) return { ok: false, error: unreachableMessage(tv) }; // searching can't help
      var found = await relocateTv(tv, "unreachable");
      if (!found.ok) lastSearchFail[tv.id] = Date.now();
      return found;
    }
    // A serial number is proof enough; otherwise also require that the TV accepts
    // this phone's pairing code (each TV only accepts its own).
    var good = looksLikeTv(tv, probe) && (strongIdent(tv) ? true : await acceptsToken(tv));
    if (!good) return relocateTv(tv);
    if (!tv.ident && probe.ident) updateTv(tv.id, function (t) { t.ident = probe.ident; if (!t.model && probe.model) t.model = probe.model; });
    return { ok: true, cache: true };
  }
  function scanNetwork() {
    return new Promise(function (resolve) {
      if (!hasBridge()) { resolve([]); return; }
      var id = uid();
      pending[id] = function (res) { resolve((res.ok && res.found) || []); };
      VizioBridge.scanAsync(id);
    });
  }
  /** The selected TV isn't at its saved address any more: find it by identity. */
  async function relocateTv(tv, reason) {
    toast(reason === "unreachable"
      ? tvLabel(tv) + " isn't answering at its usual address. Looking for it on your WiFi…"
      : "A different TV is at " + tvLabel(tv) + "'s address. Nothing was sent. Looking for " + tvLabel(tv) + "…", { sticky: true });
    var found = await scanNetwork();
    for (var i = 0; i < found.length; i++) {
      var f = found[i];
      if (f.ip === tv.ip && reason !== "unreachable") continue;
      var target = { ip: f.ip, port: f.port, authToken: tv.authToken };
      var probe = await probeTv(target);
      if (!probe.reached || !looksLikeTv(tv, probe)) continue;
      if (!strongIdent(tv) && !(await acceptsToken(target))) continue;
      updateTv(tv.id, function (t) { t.ip = f.ip; t.port = f.port; if (probe.ident) t.ident = probe.ident; });
      toast("Found " + tvLabel(tv) + " at its new address.", { duration: 3500 });
      return { ok: true, cache: true, key: tv.id + "@" + f.ip };
    }
    hideToast();
    if (reason === "unreachable") return { ok: false, error: unreachableMessage(tv) };
    return { ok: false, error: "Couldn't find " + tvLabel(tv) + ". Another TV now has its address, so nothing was sent to it. Make sure " + tvLabel(tv) + " is on, or pair it again in Settings." };
  }

  function describeError(res) {
    if (res.wrongTv) return res.error;
    if (res.noTv) return "Set up your TV first.";
    if (res.vizioResult && /AUTH/.test(res.vizioResult)) return "The TV doesn't recognise this phone any more. Pair it again in Settings.";
    if (!res.status) return unreachableMessage(activeTv());
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
  var KEY_LABELS = { up: "↑", down: "↓", left: "←", right: "→", ok: "OK", back: "Back", play: "Play", pause: "Pause", exit: "Exit", home: "Home" };
  function sendKey(name) {
    var k = KEYS[name];
    return tvCall("PUT", "/key_command/", { KEYLIST: [{ CODESET: k[0], CODE: k[1], ACTION: "KEYPRESS" }] }, { fast: true });
  }

  function readPowerOn(res) {
    if (!res.ok || !res.json) return null;
    var item = (res.json.ITEMS && res.json.ITEMS[0]) || res.json.ITEM;
    if (!item) return null;
    return Number(item.VALUE) !== 0;
  }
  // ---------- volume ----------
  // Vizio exposes volume as a TV setting: read it to get its value and a
  // HASHVAL, then write the new value with that HASHVAL.
  var VOL_PATH = "/menu_native/dynamic/tv_settings/audio/volume";
  async function getVolume(tv) {
    var res = await tvCall("GET", VOL_PATH, null, { tv: tv, timeout: 3000 });
    var item = res.ok && res.json && res.json.ITEMS && res.json.ITEMS[0];
    if (!item || item.VALUE == null) return null;
    return { value: Number(item.VALUE), hash: item.HASHVAL };
  }
  async function setVolume(n, tv) {
    n = Math.max(0, Math.min(100, Math.round(n)));
    var cur = await getVolume(tv);
    if (!cur) return false;
    if (cur.value === n) return true;
    var res = await tvCall("PUT", VOL_PATH, { REQUEST: "MODIFY", HASHVAL: cur.hash, VALUE: n }, { tv: tv });
    if (res.ok) return true;
    // Fallback: step there with the volume buttons.
    var diff = n - cur.value, key = diff > 0 ? "vol_up" : "vol_down";
    for (var i = 0; i < Math.min(Math.abs(diff), 60); i++) await sendKey(key);
    return true;
  }

  function readCurrentApp(res) {
    var item = res.ok && res.json && res.json.ITEM;
    var val = item && (item.VALUE || item);
    return val && val.APP_ID != null ? val : null;
  }
  function sameApp(a, b) { return !!a && !!b && String(a.APP_ID) === String(b.APP_ID) && Number(a.NAME_SPACE) === Number(b.NAME_SPACE); }
  /** The TV's own SmartCast home screen (what apps get bounced back to). */
  function isHome(a) {
    return !!a && (/scfs\/sctv/i.test(String(a.MESSAGE || "")) || (String(a.APP_ID) === "1" && Number(a.NAME_SPACE) === 4));
  }
  // Some apps report a different ID while running than the one used to open
  // them. We learn that ID the first time and treat both as the same app.
  function appKey(a) { return Number(a.NAME_SPACE) + ":" + String(a.APP_ID); }
  function isApp(cur, app) {
    if (!cur) return false;
    if (sameApp(cur, app)) return true;
    var aliases = getJSON("remotetv.appAliases", {})[appKey(app)] || [];
    return aliases.indexOf(appKey(cur)) >= 0;
  }
  function learnAlias(app, cur) {
    if (!cur || isHome(cur) || sameApp(cur, app)) return;
    var all = getJSON("remotetv.appAliases", {}), k = appKey(app), list = all[k] || [];
    if (list.indexOf(appKey(cur)) < 0) { list.push(appKey(cur)); all[k] = list; setJSON("remotetv.appAliases", all); }
  }

  function currentApp(timeout) {
    return tvCall("GET", "/app/current", null, { timeout: timeout || 2500 }).then(readCurrentApp);
  }

  /** Turns the TV on if needed. Returns {ok, wasOff} or {ok:false, error}. */
  async function ensureOn(status) {
    var power = await tvCall("GET", "/state/device/power_mode", null, { timeout: 4000 });
    if (power.wrongTv) return { ok: false, error: power.error };
    if (!power.status) {
      return { ok: false, error: unreachableMessage(activeTv()) };
    }
    if (power.vizioResult && /AUTH/.test(power.vizioResult)) return { ok: false, error: describeError(power) };
    if (readPowerOn(power) !== false) return { ok: true, wasOff: false };
    status("Turning on " + tvLabel(activeTv()) + "…");
    await sendKey("pow_on");
    for (var i = 0; i < 20; i++) {
      await delay(1000);
      if (readPowerOn(await tvCall("GET", "/state/device/power_mode", null, { timeout: 2000 }))) break;
    }
    // After waking, the TV's own home screen loads and grabs the screen, which
    // kicks out any app opened too early. Wait until it reports the same
    // current app twice in a row (i.e. it has settled), then a bit more.
    status("Waiting for the TV to finish starting…");
    var prev = null, settled = 0;
    for (var j = 0; j < 15 && settled < 2; j++) {
      await delay(1000);
      var cur = await currentApp();
      settled = cur && prev && sameApp(cur, prev) ? settled + 1 : 0;
      prev = cur;
    }
    await delay(2000);
    return { ok: true, wasOff: true };
  }

  /**
   * Opens an app fresh and makes sure it *stays* open. Success means the TV
   * has left its own home screen and stayed out for 4 seconds. If it falls
   * back to the home screen, the app is launched again (up to 3 tries).
   */
  async function openApp(app, label, status) {
    var before = await currentApp(3000);
    if (isApp(before, app)) {
      // Already open somewhere inside it: leave first so recorded steps start from its home screen.
      status("Restarting " + label + "…");
      await sendKey("exit");
      for (var w = 0; w < 6; w++) {
        await delay(700);
        before = await currentApp();
        if (!isApp(before, app)) break;
      }
      await delay(1500);
    }
    var res;
    for (var attempt = 1; attempt <= 3; attempt++) {
      status(attempt === 1 ? "Opening " + label + "…" : "Opening " + label + " again (try " + attempt + ")…");
      res = await tvCall("PUT", "/app/launch", { VALUE: { APP_ID: app.APP_ID, NAME_SPACE: app.NAME_SPACE, MESSAGE: app.MESSAGE } });
      if (!res.ok) return res;
      var since = 0, inApp = false, bounced = false, unknown = 0, start = Date.now(), last = null;
      while (Date.now() - start < 15000) {
        await delay(700);
        var cur = await currentApp();
        if (!cur) { unknown++; continue; }            // TV didn't say; don't guess
        // Still showing whatever was on before the launch took effect.
        if (!inApp && before && sameApp(cur, before) && !isApp(cur, app) && Date.now() - start < 3000) continue;
        if (isApp(cur, app) || !isHome(cur)) {
          if (!inApp) { inApp = true; since = Date.now(); }
          last = cur;
          if (Date.now() - since >= 4000) { learnAlias(app, last); return res; } // stayed open
        } else if (inApp) {
          bounced = true;                              // opened, then kicked back to the home screen
          break;
        }
      }
      // Never saw it leave the home screen. If the TV isn't telling us what's
      // on screen at all, trust the launch rather than relaunching on top of it.
      if (!bounced && (!inApp && unknown > 5)) return res;
      if (!bounced && attempt >= 2) return res;
      await delay(2000);
    }
    return { ok: false, status: 200, error: label + " kept closing straight after opening. Try again in a few seconds." };
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
    if (opts.sticky) return;
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
    if (name === "remote") refreshVolume();
    window.scrollTo(0, 0);
  }
  $$(".tab").forEach(function (b) { b.addEventListener("click", function () { haptic(); showScreen(b.dataset.screen); }); });
  $("#remoteTv").addEventListener("click", function () {
    haptic();
    var tv = activeTv(), h = tv && health[tv.id];
    if (!getTvs().length) openOnboarding("find");
    else if (h && !h.ok) openFixSheet(tv.id);
    else openTvPicker();
  });
  $("#tvChip").addEventListener("click", function () {
    haptic();
    if (!getTvs().length) openOnboarding("find"); else openTvPicker();
  });
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-action='add-show']")) { haptic(); openShowSheet(null); }
  });

  function renderTvChip() {
    var tv = activeTv(), chip = $("#tvChip");
    var h = tv && health[tv.id], down = !!(h && !h.ok);
    var rn = document.getElementById("remoteTvName"), rb = document.getElementById("remoteTv");
    if (rn) rn.textContent = tv ? tvLabel(tv) : "no TV yet";
    if (rb) {
      rb.classList.toggle("down", down);
      $("#remoteTvLabel").textContent = down ? "Can't reach" : "Controlling";
      $("#remoteTvFix").classList.toggle("hidden", !down);
    }
    chip.className = "tv-chip " + (!tv ? "" : !tv.paired ? "warn" : down ? "bad" : "ok");
    $("#tvChipText").textContent = !tv ? "Set up TV" : tvLabel(tv) + (tv.paired ? "" : " · not paired");
  }

  // =====================================================================
  // sheet
  // =====================================================================
  var sheetOnClose = null;
  function openSheet(html, onClose) {
    hideToast();
    $("#sheetBody").innerHTML = html;
    $("#scrim").classList.remove("hidden");
    var s = $("#sheet");
    s.scrollTop = 0;
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
  function on(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", function (e) { haptic(); fn(e); });
  }

  // =====================================================================
  // WATCH
  // =====================================================================
  function renderShows() {
    var shows = getShows(), wrap = $("#showList");
    $("#watchEmpty").classList.toggle("hidden", shows.length > 0);
    $("#fab").classList.toggle("hidden", current !== "watch" || shows.length === 0);

    wrap.innerHTML = shows.map(function (s, i) {
      var svc = service(s.service);
      var mode = showMode(s);
      var hasSteps = mode === "steps";
      var isReady = ready && ready.showId === s.id;
      var pn = perNight(s);
      var autoTxt = s.auto === "nightly" ? (pn > 1 ? "+" + pn + " eps tomorrow" : "Next ep. tomorrow")
        : s.auto === "watched" ? "+" + pn + (pn > 1 ? " eps" : "") + " after nights you watch" : "";
      var foot = isReady
        ? '<div class="ready-bar"><span class="rec-dot ready"></span><span class="ready-txt">' + (ready.paused ? "Paused at the start on your TV" : "Playing on your TV") + '</span>' +
            '<button class="mini-btn" data-act="tv-pause" aria-label="Pause">' + icon("pause") + '</button>' +
            '<button class="mini-btn primary" data-act="tv-play" aria-label="Play">' + icon("play") + '</button></div>'
        : mode === "cast" ? '<span class="go-direct">' + icon("check") + 'Opens ' + esc(svc.label) + ' on your phone: tap Cast, then Play</span>'
        : hasSteps ? '<span class="go-direct">' + icon("check") + (asksFirst(s) ? 'Asks first, then goes to your show' : 'Goes straight to your show') + (s.pauseAtStart !== false ? ", paused" : "") + '</span>'
        : '<button class="teach-link" data-act="teach">' + icon("play") + 'Make Play go to the episode</button>';
      return '' +
        '<article class="show' + (isReady ? " is-ready" : "") + '" data-id="' + s.id + '" style="--brand:' + svc.color + ';animation-delay:' + (i * 40) + 'ms">' +
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
              (function () {
                var tvNow = activeTv(), vol = s.volumeOn && s.volumes && tvNow ? s.volumes[tvNow.id] : null;
                var badges = (autoTxt ? '<div class="auto-badge">' + icon("moon") + autoTxt + '</div>' : '') +
                  (vol != null ? '<div class="auto-badge vol">' + icon("vol") + 'Volume ' + vol + '</div>' : '');
                return badges ? '<div class="badges">' + badges + '</div>' : '';
              })() +
            '</div>' +
            '<button class="play-btn" data-act="' + (isReady && ready.paused ? "tv-play" : "play") + '" aria-label="Play ' + esc(s.name) + '">' + icon("play") + '</button>' +
          '</div>' +
          '<div class="show-bar">' +
            '<div class="stepper">' +
              '<button data-act="ep-" aria-label="Previous episode">' + icon("minus") + '</button>' +
              '<span>EP</span>' +
              '<button data-act="ep+" aria-label="Next episode">' + icon("plus") + '</button>' +
            '</div>' +
            '<button class="chip-btn" data-act="season">Next season</button>' +
          '</div>' +
          '<div class="show-foot">' + foot + '</div>' +
        '</article>';
    }).join("");
  }

  $("#showList").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var id = btn.closest(".show").dataset.id;
    var show = findShow(id);
    if (!show) return;
    haptic();
    switch (btn.dataset.act) {
      case "play": playShow(show, btn); break;
      case "edit": openShowSheet(show); break;
      case "teach": openGoToSheet(show); break;
      case "tv-play": sendKey("play"); ready.paused = false; renderShows(); break;
      case "tv-pause": sendKey("pause"); ready.paused = true; renderShows(); break;
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

  var playing = null; // { stop: bool }
  var ready = null;   // { showId, paused } once a show is cued up on the TV

  /** How Play gets to the show: "cast" (phone app), "steps" (recorded), or "open" (just the app). */
  function showMode(s) {
    if (s.mode === "cast" && s.castLink) return "cast";
    if (s.mode === "steps" && s.steps && s.steps.length) return "steps";
    if (!s.mode) {
      if (s.castLink) return "cast";
      if ((s.steps && s.steps.length) || (s.link && s.linkWorks)) return "steps";
    }
    return "open";
  }

  function stepFactor() { return getJSON("remotetv.patient", false) ? 1.6 : 1.15; }

  /** Turns a pasted share link into what the TV app expects (Netflix has a known format). */
  function linkMessage(link) {
    var m = /netflix\.com\/(?:[a-z-]+\/)?(?:watch|title)\/(\d+)/i.exec(link);
    if (m) return "m=https://api-global.netflix.com/catalog/titles/movie/" + m[1] + "&source_type=4";
    return link;
  }

  /** The question's answers: the show's usual steps first, then any extra recorded routes. */
  function askAnswers(show) {
    var ask = show.ask || {};
    return [{ id: "main", label: ask.mainLabel || "No, just this show", steps: show.steps || [] }].concat(ask.answers || []);
  }
  function asksFirst(show) {
    return showMode(show) === "steps" && show.ask && show.ask.on && (show.ask.answers || []).length > 0;
  }

  function openAskSheet(show, btn) {
    var svc = service(show.service);
    var answers = askAnswers(show);
    var body = openSheet(
      '<h2>' + esc(show.ask.question || "Did you watch something else since last time?") + '</h2>' +
      '<p class="lead">' + esc(show.name) + '</p>' +
      '<div class="ask-list">' + answers.map(function (a, i) {
        var ready = a.steps && a.steps.length;
        return '<button class="ask-opt" data-ans="' + i + '"' + (ready ? '' : ' disabled') + '>' +
          '<b>' + esc(a.label) + '</b>' + (ready ? '' : '<small>Not taught yet</small>') + '</button>';
      }).join("") + '</div>' +
      '<div class="sheet-actions">' +
        '<button class="btn block" id="askOpen">Just open ' + esc(svc.label) + '</button>' +
        '<button class="btn ghost block" id="askCancel">Cancel</button>' +
      '</div>'
    );
    $$("[data-ans]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic();
        var a = answers[Number(b.dataset.ans)];
        closeSheet();
        playShow(show, btn, { steps: a.steps, label: a.label });
      });
    });
    on("askOpen", function () { closeSheet(); playShow(show, btn, { steps: [], label: "open" }); });
    on("askCancel", closeSheet);
  }

  async function playShow(show, btn, route) {
    var tv = activeTv();
    if (!tv) { openOnboarding("find"); return; }
    if (!tv.paired) { openOnboarding("find"); return; }
    if (showMode(show) === "cast") { castShow(show, btn); return; }
    var app = appFor(show.service);
    if (!app) { openLinkSheet(show.service, function () { playShow(show, btn); }); return; }
    if (playing) return;
    if (!route && asksFirst(show)) { openAskSheet(show, btn); return; }

    var svc = service(show.service);
    var run = playing = { stop: false };
    var status = function (t) { toast(t, { sticky: true, action: "Stop", onAction: function () { run.stop = true; } }); };
    btn.classList.add("busy");
    try {
      var power = await ensureOn(status);
      if (!power.ok) { connectionError(power.error); return; }
      if (run.stop) return;
      applyShowVolume(show);

      var useLink = show.link && show.linkWorks;
      var res = await openApp(useLink ? Object.assign({}, app, { MESSAGE: linkMessage(show.link) }) : app, svc.label, status);
      if (!res.ok) {
        toast("Couldn't open " + svc.label + ": " + describeError(res), { bad: true, duration: 5000 });
        if (res.status && !getLinked()[show.service]) openLinkSheet(show.service, function () { playShow(show, btn); });
        return;
      }

      var steps = route ? route.steps : useLink ? [] : (show.steps || []);
      if (route && !steps.length) useLink = false;
      if (steps.length || useLink) {
        var f = stepFactor();
        for (var i = 0; i < steps.length; i++) {
          if (run.stop) { toast("Stopped"); return; }
          status("Going to " + show.name + "… (" + (i + 1) + "/" + steps.length + ")");
          var wait = Math.min(25000, Math.max(500, steps[i].wait * f + 250));
          if (i === 0 && power.wasOff) wait += 2500; // apps load slower right after the TV wakes
          await delay(wait);
          if (run.stop) { toast("Stopped"); return; }
          await sendKey(steps[i].key);
        }
        if (show.pauseAtStart !== false) {
          status("Pausing at the start…");
          await delay(useLink ? 9000 : 2500); // let the video actually begin
          if (run.stop) { toast("Stopped"); return; }
          await sendKey("pause");
          ready = { showId: show.id, paused: true };
          toast(show.name + " is ready on the TV. Tap ▶ when you're settled.", { duration: 4000 });
        } else {
          ready = { showId: show.id, paused: false };
          toast("Enjoy " + show.name + "!", { duration: 3000 });
        }
        renderShows();
      } else {
        toast(svc.label + " is open. Tip: tap \"Make Play go to the episode\" to skip the menus next time.", { duration: 5000 });
      }
      updateShow(show.id, function (s) {
        var d = tvDay();
        s.playedDays = (s.playedDays || []).filter(function (x) { return x !== d; }).concat([d]);
      });
    } finally {
      btn.classList.remove("busy");
      playing = null;
    }
  }

  /** Cast mode: wake the TV, then open the show in the streaming service's phone app. */
  async function castShow(show, btn) {
    if (playing) return;
    var svc = service(show.service);
    playing = { stop: false };
    btn.classList.add("busy");
    try {
      var power = await tvCall("GET", "/state/device/power_mode", null, { timeout: 3000 });
      if (power.wrongTv) { connectionError(power.error); return; }
      if (power.status && readPowerOn(power) === false) {
        toast("Turning on " + tvLabel(activeTv()) + "…");
        await sendKey("pow_on");
        await delay(600);
      }
      applyShowVolume(show, power.status && readPowerOn(power) === false);
      var opened = hasBridge() && VizioBridge.openUrl && VizioBridge.openUrl(show.castLink);
      if (!opened) { toast("Couldn't open the link. Check it in the show's settings.", { bad: true }); return; }
      toast("In " + svc.label + ": tap Cast, pick " + tvLabel(activeTv()) + ", then Play.", { duration: 8000 });
      updateShow(show.id, function (s) {
        var d = tvDay();
        s.playedDays = (s.playedDays || []).filter(function (x) { return x !== d; }).concat([d]);
      });
    } finally {
      btn.classList.remove("busy");
      playing = null;
    }
  }

  /** Sets this show's volume for the current TV, if the show has one. Retries while a just-woken TV settles. */
  async function applyShowVolume(show, justWoke) {
    var tv = activeTv();
    var v = show.volumeOn && show.volumes && tv && show.volumes[tv.id];
    if (v == null || v === false) return;
    for (var i = 0; i < (justWoke ? 6 : 2); i++) {
      if (i || justWoke) await delay(2500);
      if (await setVolume(v)) return;
    }
  }

  // ---------- choose how Play gets to the show ----------
  function openGoToSheet(show) {
    var svc = service(show.service);
    var mode = showMode(show);
    var body = openSheet(
      '<h2>Go straight to ' + esc(show.name) + '</h2>' +
      '<p class="lead">Pick how Play gets you to the episode.</p>' +
      '<button class="goto-opt' + (mode === "cast" ? " sel" : "") + '" id="gCast">' +
        '<div class="goto-head"><b>Cast from your phone</b><span class="tag good">Most reliable</span></div>' +
        '<small>Play turns on the TV and opens ' + esc(show.name) + ' in the ' + esc(svc.label) + ' app on your phone. You tap <b>Cast</b>, then <b>Play</b>. ' + esc(svc.label) + ' always knows which episode you\'re on.</small>' +
      '</button>' +
      '<div class="goto-detail' + (mode === "cast" ? "" : " hidden") + '" id="gCastBox">' +
        '<ol class="steps">' +
          '<li><span>In the <b>' + esc(svc.label) + '</b> app on your phone, open ' + esc(show.name) + '.</span></li>' +
          '<li><span>Tap <b>Share</b> → <b>Copy link</b>, then come back here.</span></li>' +
        '</ol>' +
        '<div style="display:flex;gap:8px"><input class="input" id="gLink" placeholder="Paste the show link" value="' + esc(show.castLink || "") + '">' +
        '<button class="btn" id="gPaste">Paste</button></div>' +
        '<div class="status-msg" id="gMsg"></div>' +
        '<button class="btn primary big block" id="gCastSave" style="margin-top:6px">Use this link</button>' +
      '</div>' +
      '<button class="goto-opt' + (mode === "steps" ? " sel" : "") + '" id="gSteps">' +
        '<div class="goto-head"><b>Hands-free</b><span class="tag">' + ((show.steps || []).length ? "Taught" : "Teach once") + '</span></div>' +
        '<small>Play does everything on the TV by repeating button presses you record once, and pauses at the start. Fully automatic, but menus or slow loading can trip it up.</small>' +
      '</button>' +
      '<button class="goto-opt' + (mode === "open" ? " sel" : "") + '" id="gOpen">' +
        '<div class="goto-head"><b>Just open ' + esc(svc.label) + '</b></div>' +
        '<small>Play turns on the TV and opens the app. You pick the show with your remote.</small>' +
      '</button>'
    );
    on("gCast", function () { $("#gCastBox").classList.remove("hidden"); $$(".goto-opt", body).forEach(function (x) { x.classList.toggle("sel", x.id === "gCast"); }); });
    on("gPaste", function () {
      var t = hasBridge() && VizioBridge.clipboardText ? VizioBridge.clipboardText() : "";
      var m = /https?:\/\/\S+/.exec(t || "");
      if (m) { $("#gLink").value = m[0]; setMsg("gMsg", ""); }
      else setMsg("gMsg", "No link on the clipboard yet. Copy it from the " + svc.label + " app first.", "bad");
    });
    on("gCastSave", function () {
      var raw = $("#gLink").value.trim(), m = /https?:\/\/\S+/.exec(raw);
      if (!m) { setMsg("gMsg", "Paste the link you copied from " + svc.label + ".", "bad"); return; }
      updateShow(show.id, function (x) { x.castLink = m[0]; x.mode = "cast"; });
      closeSheet(); renderShows();
      toast("Done. Play now opens " + show.name + " in " + svc.label + " on your phone.", { duration: 4500 });
    });
    on("gSteps", function () {
      updateShow(show.id, function (x) { x.mode = "steps"; });
      closeSheet();
      if ((show.steps || []).length) { renderShows(); toast("Play will use your recorded steps"); }
      else openTeach(findShow(show.id));
    });
    on("gOpen", function () {
      updateShow(show.id, function (x) { x.mode = "open"; });
      closeSheet(); renderShows();
    });
  }

  // ---------- add / edit show ----------
  function openShowSheet(show) {
    var isNew = !show;
    var s = show || { name: "", service: "Max", season: 1, episode: 1, auto: "nightly", perNight: defaultPerNight() };
    var sel = s.service, auto = s.auto || "off";
    var nSteps = (s.steps || []).length;

    var body = openSheet(
      '<h2>' + (isNew ? "Add a show" : "Edit show") + '</h2>' +
      '<p class="lead">' + (isNew ? "Play will turn on the TV and open its app." : "") + '</p>' +
      '<div class="field"><label>Show name</label><input class="input" id="fName" placeholder="e.g. The Big Bang Theory" value="' + esc(s.name) + '" maxlength="60"></div>' +
      '<div class="field"><label>Watch it on</label><div class="service-grid" id="fSvc">' +
        SERVICES.map(function (x) {
          return '<button class="service-opt' + (x.id === sel ? " sel" : "") + '" data-svc="' + esc(x.id) + '" style="--brand:' + x.color + '">' + esc(x.label) + '</button>';
        }).join("") +
      '</div></div>' +
      (isNew ? '' :
        '<div class="field"><label>Go straight to the episode</label><div class="card inset">' +
          (function () {
            var m = showMode(s);
            var title = m === "cast" ? "Cast from your phone" : m === "steps" ? "Hands-free: " + nSteps + " recorded steps" : "Just opens the app";
            var sub = m === "cast" ? "Opens the show in the " + service(s.service).label + " phone app. You tap Cast, then Play."
              : m === "steps" ? "Play repeats your recorded steps on the TV." : "Choose how Play should get to your episode.";
            return '<div class="row-item"><div class="ri-main"><div class="ri-title">' + title + '</div><div class="ri-sub">' + sub + '</div></div>' +
              '<button class="pill-btn accent" id="fGoTo">Change</button></div>' +
              ((m === "steps" || nSteps) ? '<div class="link-row">' +
                (m === "steps" ? '<button class="link-btn" id="fTeach">Re-teach steps</button>' : '') +
                (nSteps ? '<button class="link-btn" id="fClearSteps">Remove steps</button>' : '') + '</div>' : '');
          })() +
          (showMode(s) === "steps" ? (function () {
            var ask = s.ask || {};
            return '<label class="switch-row"><span><b>Ask a question first</b><small>e.g. if you watched something else, Play follows different steps</small></span>' +
              '<input type="checkbox" id="fAskOn"' + (ask.on ? " checked" : "") + '><i></i></label>' +
              '<div id="fAskBox"' + (ask.on ? '' : ' class="hidden"') + '>' +
                '<input class="input ask-q" id="fAskQ" maxlength="80" value="' + esc(ask.question || ("Did you watch something else on " + service(s.service).label + " since last time?")) + '">' +
                askAnswers(s).map(function (a) {
                  var n = (a.steps || []).length;
                  return '<div class="ans-row" data-ansrow="' + a.id + '">' +
                    '<input class="input" data-anslabel="' + a.id + '" maxlength="40" value="' + esc(a.label) + '">' +
                    '<button class="pill-btn' + (n ? '' : ' accent') + '" data-teachans="' + a.id + '">' + (n ? "Re-teach" : "Teach") + '</button>' +
                    (a.id === "main" ? '' : '<button class="pill-btn del" data-delans="' + a.id + '" aria-label="Remove answer">' + icon("close") + '</button>') +
                  '</div>';
                }).join("") +
                '<button class="btn block" id="fAddAns" style="margin-top:10px">' + icon("plus") + 'Add an answer</button>' +
              '</div>';
          })() : '') +
          '<label class="switch-row"><span><b>Pause it at the start</b><small>So it\'s cued up and waiting when you sit down</small></span>' +
            '<input type="checkbox" id="fPause"' + (s.pauseAtStart !== false ? " checked" : "") + '><i></i></label>' +
          '<details class="adv"' + (s.link ? " open" : "") + '><summary>Try a direct link (experimental)</summary>' +
            '<p class="ri-sub">In the ' + esc(service(s.service).label) + ' phone app, open the episode, tap Share and copy the link, then paste it here. Netflix links are reported to work. HBO Max, Paramount+ and the rest don\'t publish a way to do this, so they probably won\'t, but testing takes seconds.</p>' +
            '<div style="display:flex;gap:8px;margin-top:8px"><input class="input" id="fLink" placeholder="https://…" value="' + esc(s.link || "") + '">' +
            '<button class="btn" id="fLinkTest">Test</button></div>' +
            '<div class="status-msg" id="fLinkMsg">' + (s.link ? (s.linkWorks ? "Works: Play uses this link." : "Not confirmed. Play uses your steps instead.") : "") + '</div>' +
          '</details>' +
        '</div></div>') +
      (function () {
        var tvs = getTvs();
        if (!tvs.length) return '';
        var vols = s.volumes || {};
        return '<div class="field"><label>Volume</label><div class="card inset">' +
          '<label class="switch-row" style="margin:0;padding:0;border:0"><span><b>Set the volume when it starts</b><small>Each TV can have its own level</small></span>' +
            '<input type="checkbox" id="fVolOn"' + (s.volumeOn ? " checked" : "") + '><i></i></label>' +
          '<div id="fVolList"' + (s.volumeOn ? '' : ' class="hidden"') + '>' + tvs.map(function (t) {
            var v = vols[t.id] != null ? vols[t.id] : 20;
            return '<div class="show-vol"><span class="tvn">' + esc(tvLabel(t)) + '</span>' +
              '<input type="range" min="0" max="100" step="1" value="' + v + '" data-voltv="' + t.id + '" style="--fill:' + v + '%">' +
              '<b>' + v + '</b></div>';
          }).join("") + '</div>' +
        '</div></div>';
      })() +
      '<div class="field"><label>You\'re on</label><div class="two">' +
        numField("fSeason", "Season", s.season) + numField("fEp", "Episode", s.episode) +
      '</div></div>' +
      '<div class="field"><label>Move to next episode automatically</label><div class="seg" id="fAuto">' +
        segOpt("nightly", "Every night", "Moves forward each morning", auto) +
        segOpt("watched", "Only nights I watch", "Moves forward the morning after you tap Play", auto) +
        segOpt("off", "Off", "I'll update it myself", auto) +
      '</div>' +
      '<div class="per-night' + (auto === "off" ? " hidden" : "") + '" id="fPerNightRow"><span><b>Episodes per night</b><small>How many it moves forward each time</small></span>' +
        numField("fPerNight", "", perNight(s)) + '</div>' +
      '</div>' +
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
        $("#fPerNightRow").classList.toggle("hidden", auto === "off");
        $$("#fAuto .seg-opt", body).forEach(function (x) { x.classList.toggle("sel", x === b); });
      });
    });
    wireNumFields(body);
    var volOn = $("#fVolOn");
    if (volOn) volOn.addEventListener("change", function () { haptic(); $("#fVolList").classList.toggle("hidden", !volOn.checked); });
    $$("[data-voltv]", body).forEach(function (r) {
      r.addEventListener("input", function () { r.style.setProperty("--fill", r.value + "%"); r.nextElementSibling.textContent = r.value; });
    });
    if (isNew) setTimeout(function () { $("#fName").focus(); }, 350);

    function save() {
      var name = $("#fName").value.trim();
      if (!name) { $("#fName").focus(); toast("Give the show a name"); return null; }
      var season = Math.max(1, parseInt($("#fSeason").value, 10) || 1);
      var ep = Math.max(1, parseInt($("#fEp").value, 10) || 1);
      var list = getShows(), t;
      if (isNew) {
        t = { id: uid(), name: name, service: sel, season: season, episode: ep, auto: auto, lastDay: tvDay(), playedDays: [], steps: [], pauseAtStart: true, link: "", linkWorks: false };
        t.perNight = Math.max(1, Math.min(10, parseInt($("#fPerNight").value, 10) || 1));
        readVolumeFields(t);
        list.push(t);
      } else {
        t = list.find(function (x) { return x.id === show.id; });
        if (t) {
          if (t.auto !== auto) t.lastDay = tvDay();
          if (t.service !== sel) { t.steps = []; t.link = ""; t.linkWorks = false; } // these belong to the old app
          var pz = $("#fPause"); if (pz) t.pauseAtStart = pz.checked;
          readAskFields(t);
          readVolumeFields(t);
          var lk = $("#fLink");
          if (lk && lk.value.trim() !== (t.link || "")) { t.link = lk.value.trim(); t.linkWorks = false; }
          t.name = name; t.service = sel; t.season = season; t.episode = ep; t.auto = auto;
          t.perNight = Math.max(1, Math.min(10, parseInt($("#fPerNight").value, 10) || 1));
        }
      }
      setShows(list);
      return t;
    }

    on("fSave", function () {
      var t = save();
      if (!t) return;
      closeSheet(); renderShows();
      if (isNew) {
        toast(t.name + " added", { action: "Make Play go to the episode", duration: 6000, onAction: function () { openGoToSheet(findShow(t.id)); } });
      }
    });
    on("fTeach", function () { var t = save(); if (!t) return; closeSheet(); renderShows(); openTeach(findShow(t.id)); });
    var askOn = $("#fAskOn");
    if (askOn) askOn.addEventListener("change", function () { haptic(); $("#fAskBox").classList.toggle("hidden", !askOn.checked); });
    $$("[data-delans]", body).forEach(function (b) {
      b.addEventListener("click", function () { haptic(); var row = b.closest("[data-ansrow]"); if (row) row.remove(); });
    });
    $$("[data-teachans]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic();
        var t = save(); if (!t) return;
        closeSheet(); renderShows();
        openTeach(findShow(t.id), b.dataset.teachans);
      });
    });
    on("fAddAns", function () {
      var t = save(); if (!t) return;
      var id = uid();
      updateShow(t.id, function (x) {
        x.ask = x.ask || { on: true, answers: [] };
        x.ask.on = true;
        x.ask.answers = (x.ask.answers || []).concat([{ id: id, label: "Yes, I watched something else", steps: [] }]);
      });
      closeSheet(); renderShows();
      openTeach(findShow(t.id), id);
    });
    on("fGoTo", function () { var t = save(); if (!t) return; closeSheet(); renderShows(); setTimeout(function () { openGoToSheet(findShow(t.id)); }, 250); });
    on("fLinkTest", async function () {
      var link = $("#fLink").value.trim();
      if (!/^https?:\/\//i.test(link)) { setMsg("fLinkMsg", "Paste a link that starts with https://", "bad"); return; }
      var app = appFor(sel);
      if (!app) { setMsg("fLinkMsg", "Link the app first (Settings → Streaming apps).", "bad"); return; }
      setMsg("fLinkMsg", "Sending it to the TV… watch the screen.");
      var power = await ensureOn(function (t) { setMsg("fLinkMsg", t); });
      if (!power.ok) { setMsg("fLinkMsg", power.error, "bad"); return; }
      var res = await openApp(Object.assign({}, app, { MESSAGE: linkMessage(link) }), service(sel).label, function (t) { setMsg("fLinkMsg", t); });
      if (!res.ok) { setMsg("fLinkMsg", "The TV refused the link: " + describeError(res), "bad"); return; }
      var m = $("#fLinkMsg");
      m.className = "status-msg";
      m.innerHTML = 'Did the TV go straight to the episode? <span class="yn"><button class="pill-btn accent" id="fLinkYes">Yes</button><button class="pill-btn" id="fLinkNo">No</button></span>';
      on("fLinkYes", function () {
        var t = save(); if (!t) return;
        updateShow(t.id, function (x) { x.link = link; x.linkWorks = true; });
        setMsg("fLinkMsg", "Saved. Play will use this link.", "ok");
        renderShows();
      });
      on("fLinkNo", function () {
        var t = save(); if (!t) return;
        updateShow(t.id, function (x) { x.link = link; x.linkWorks = false; });
        setMsg("fLinkMsg", "OK, this app doesn't take links. Teach the steps instead.", "bad");
      });
    });
    on("fClearSteps", function () { updateShow(show.id, function (x) { x.steps = []; }); closeSheet(); renderShows(); toast("Steps removed"); });
    on("fDelete", function () {
      var list = getShows();
      var idx = list.findIndex(function (x) { return x.id === show.id; });
      var removed = list.splice(idx, 1)[0];
      setShows(list); closeSheet(); renderShows();
      toast(removed.name + " deleted", {
        action: "Undo",
        onAction: function () { var l = getShows(); l.splice(idx, 0, removed); setShows(l); renderShows(); }
      });
    });
  }

  function readAskFields(t) {
    var on = $("#fAskOn");
    if (!on) return;
    t.ask = t.ask || { answers: [] };
    t.ask.on = on.checked;
    t.ask.question = $("#fAskQ").value.trim();
    var keep = {};
    $$("[data-anslabel]").forEach(function (inp) {
      var id = inp.dataset.anslabel, label = inp.value.trim();
      keep[id] = true;
      if (id === "main") { t.ask.mainLabel = label || "No, just this show"; return; }
      var a = (t.ask.answers || []).find(function (x) { return x.id === id; });
      if (a) a.label = label || a.label;
    });
    t.ask.answers = (t.ask.answers || []).filter(function (a) { return keep[a.id]; });
  }

  function readVolumeFields(t) {
    var on = $("#fVolOn");
    if (!on) return;
    t.volumeOn = on.checked;
    t.volumes = t.volumes || {};
    $$("[data-voltv]").forEach(function (r) { t.volumes[r.dataset.voltv] = Number(r.value); });
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

  // =====================================================================
  // TEACH: record the button presses from the app's home screen to the show
  // =====================================================================
  var teach = null; // { showId, phase: 'intro'|'opening'|'rec', steps: [], last: ms, busy }

  function openTeach(show, answerId) {
    if (!show) return;
    var tv = activeTv();
    if (!tv || !tv.paired) { openOnboarding("find"); return; }
    teach = { showId: show.id, answerId: answerId || "main", phase: "intro", steps: [], last: 0 };
    $("#teach").classList.remove("hidden");
    renderTeach();
  }
  function closeTeach() {
    teach = null;
    $("#teach").classList.add("hidden");
  }

  function renderTeach() {
    var show = findShow(teach.showId);
    var svc = service(show.service);
    var el = $("#teach");
    var ans = teach.answerId !== "main" && show.ask && (show.ask.answers || []).find(function (a) { return a.id === teach.answerId; });
    var html = '<div class="ob-top"><span class="teach-title">' + esc(show.name) + (ans ? ' · "' + esc(ans.label) + '"' : '') + '</span><button class="link-btn" id="tClose">Cancel</button></div>';

    if (teach.phase === "intro") {
      html +=
        '<div class="ob-body">' +
          '<div class="ob-art">' + icon("play") + '</div>' +
          '<h1>' + (ans ? 'Teach the steps for "' + esc(ans.label) + '"' : 'Teach Play the way to your show') + '</h1>' +
          '<p class="lead">You only do this once. The app opens ' + esc(svc.label) + ' on the TV. Then use the buttons here, while watching the TV, to get to ' + esc(show.name) + ' and start it playing. Next time, Play repeats exactly that and pauses it at the start.</p>' +
          '<div class="note">' + icon("check") + '<span>Choose your show from <b>Continue Watching</b> (usually the first row) instead of searching. That way it always opens at the episode you\'re up to. Take your time: the app waits as long as you did, plus a bit extra.</span></div>' +
          '<div class="ob-actions" style="margin-top:22px"><button class="btn primary big block" id="tStart">Open ' + esc(svc.label) + ' and start</button></div>' +
        '</div>';
    } else {
      var rec = teach.phase === "rec";
      html +=
        '<div class="teach-status">' + (rec ? '<span class="rec-dot"></span>Recording. Wait for each screen to load before you press.' : '<div class="spinner"></div><span id="tStatus">Opening ' + esc(svc.label) + '…</span>') + '</div>' +
        '<div class="step-strip" id="tSteps">' + stepsHtml(teach.steps) + '</div>' +
        '<div class="teach-pad' + (rec ? '' : ' disabled') + '">' +
          '<div class="dpad small">' +
            '<button class="d up" data-tkey="up">' + icon("chev-up") + '</button>' +
            '<button class="d right" data-tkey="right">' + icon("chev-up") + '</button>' +
            '<button class="d down" data-tkey="down">' + icon("chev-up") + '</button>' +
            '<button class="d left" data-tkey="left">' + icon("chev-up") + '</button>' +
            '<button class="d ok" data-tkey="ok">OK</button>' +
          '</div>' +
          '<div class="r-row">' +
            '<button class="rkey" data-tkey="back">' + icon("back") + '<small>Back</small></button>' +
            '<button class="rkey" data-tkey="play">' + icon("play") + '<small>Play</small></button>' +
          '</div>' +
        '</div>' +
        '<div class="ob-actions teach-actions">' +
          '<button class="btn primary big block" id="tSave"' + (rec && teach.steps.length ? '' : ' disabled') + '>' + icon("check") + 'It\'s playing. Save these steps</button>' +
          '<div class="btn-row"><button class="btn" id="tUndo"' + (teach.steps.length ? '' : ' disabled') + '>Undo last</button><button class="btn" id="tRestart">Start over</button></div>' +
        '</div>';
    }
    el.innerHTML = html;

    on("tClose", closeTeach);
    on("tStart", startTeachRun);
    on("tRestart", startTeachRun);
    on("tUndo", function () { teach.steps.pop(); renderTeach(); });
    on("tSave", function () {
      var steps = teach.steps.slice();
      var aid = teach.answerId;
      updateShow(teach.showId, function (s) {
        s.mode = "steps";
        var a = aid !== "main" && s.ask && (s.ask.answers || []).find(function (x) { return x.id === aid; });
        if (a) a.steps = steps; else s.steps = steps;
      });
      closeTeach(); renderShows();
      toast(aid !== "main" && ans ? 'Saved the steps for "' + ans.label + '".' : "Saved. Play now goes straight to " + show.name + ".", { duration: 4000 });
    });
    $$("[data-tkey]", el).forEach(function (b) {
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        if (!teach || teach.phase !== "rec") return;
        haptic();
        var now = Date.now();
        teach.steps.push({ key: b.dataset.tkey, wait: now - teach.last });
        teach.last = now;
        sendKey(b.dataset.tkey).then(function (res) { if (!res.ok) toast(describeError(res), { bad: true }); });
        $("#tSteps").innerHTML = stepsHtml(teach.steps);
        $("#tSteps").scrollLeft = 1e6;
        $("#tSave").disabled = false; $("#tUndo").disabled = false;
      });
    });
  }

  function stepsHtml(steps) {
    if (!steps.length) return '<span class="step-empty">Your button presses will show up here</span>';
    return steps.map(function (s) {
      return '<span class="wait">' + (s.wait / 1000).toFixed(1) + 's</span><span class="step">' + esc(KEY_LABELS[s.key] || s.key) + '</span>';
    }).join("");
  }

  async function startTeachRun() {
    var show = findShow(teach.showId), svc = service(show.service);
    var app = appFor(show.service);
    if (!app) { closeTeach(); openLinkSheet(show.service, function () { openTeach(findShow(show.id)); }); return; }
    var mine = teach;
    teach.phase = "opening"; teach.steps = [];
    renderTeach();
    var status = function (t) { var s = $("#tStatus"); if (s) s.textContent = t; };
    var power = await ensureOn(status);
    if (teach !== mine) return;
    if (!power.ok) { toast(power.error, { bad: true, duration: 7000 }); teach.phase = "intro"; renderTeach(); return; }
    var res = await openApp(app, svc.label, status);
    if (teach !== mine) return;
    if (!res.ok) { toast("Couldn't open " + svc.label + ": " + describeError(res), { bad: true }); teach.phase = "intro"; renderTeach(); return; }
    teach.phase = "rec";
    teach.last = Date.now();
    renderTeach();
  }

  // ---------- link a streaming app (for "Other", or if the built-in code fails) ----------
  function openLinkSheet(serviceId, then) {
    var svc = service(serviceId);
    openSheet(
      '<h2>Link ' + esc(svc.label) + '</h2>' +
      '<p class="lead">This only needs doing once. It shows the app which streaming app to open.</p>' +
      '<ol class="steps">' +
        '<li><span>Using your normal TV remote, <b>open ' + esc(svc.label) + '</b> on the TV.</span></li>' +
        '<li><span>When it\'s on screen, tap the button below.</span></li>' +
      '</ol>' +
      '<div class="status-msg" id="linkMsg"></div>' +
      '<div class="sheet-actions">' +
        '<button class="btn primary big block" id="linkGo">' + icon("link") + esc(svc.label) + ' is open — link it</button>' +
        (getLinked()[serviceId] ? '<button class="btn ghost block" id="linkReset">Use the built-in code instead</button>' : '') +
        '<button class="btn ghost block" id="linkCancel">Not now</button>' +
      '</div>'
    );
    on("linkCancel", closeSheet);
    on("linkReset", function () { var l = getLinked(); delete l[serviceId]; setLinked(l); closeSheet(); renderSettings(); toast("Using the built-in code for " + svc.label); });
    on("linkGo", async function () {
      var b = $("#linkGo");
      b.disabled = true;
      setMsg("linkMsg", "Checking what's open on the TV…");
      var res = await tvCall("GET", "/app/current", null);
      b.disabled = false;
      var val = readCurrentApp(res);
      if (!val) {
        setMsg("linkMsg", res.ok ? "No app seems to be open. Open " + svc.label + " on the TV and try again." : describeError(res), "bad");
        return;
      }
      var l = getLinked();
      l[serviceId] = { APP_ID: val.APP_ID, NAME_SPACE: val.NAME_SPACE, MESSAGE: val.MESSAGE != null ? val.MESSAGE : null };
      setLinked(l);
      closeSheet(); renderShows();
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
  var keysInFlight = 0;
  async function pressKey(name, el) {
    var tv = activeTv();
    if (keysInFlight >= 3) { toast("Still trying to reach " + tvLabel(tv) + "…"); return; }
    keysInFlight++;
    var slow = setTimeout(function () { toast("Connecting to " + tvLabel(tv) + "…", { sticky: true }); }, 1200);
    var res;
    try { res = await sendKey(name); } finally { clearTimeout(slow); keysInFlight--; }
    if (res.ok && $("#toastText").textContent.indexOf("Connecting to") === 0) hideToast();
    if (!res.ok) {
      el.classList.add("flash-bad");
      setTimeout(function () { el.classList.remove("flash-bad"); }, 400);
      if (Date.now() - lastKeyErr > 4000) {
        lastKeyErr = Date.now();
        var tv = activeTv();
        if (!tv || !tv.paired) toast("Set up your TV first (tap the button at the top).", { bad: true });
        else if (!res.status || res.wrongTv) connectionError(describeError(res));
        else toast(describeError(res), { bad: true });
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

  // ---------- volume slider, HUD and phone volume buttons ----------
  var volSlider = $("#volSlider"), volKnown = null, volDragging = false, volTarget = null, volBusy = false, volRefreshTimer;
  function showVolume(v) {
    volKnown = v;
    $("#volValue").textContent = v == null ? "–" : v;
    if (v != null && !volDragging) { volSlider.value = v; }
    volSlider.style.setProperty("--fill", (v == null ? 0 : v) + "%");
    volSlider.disabled = v == null;
  }
  async function refreshVolume() {
    var tv = activeTv();
    if (!tv || !tv.paired) { showVolume(null); return; }
    var v = await getVolume();
    if (!volDragging && volTarget == null) showVolume(v ? v.value : null);
  }
  function refreshVolumeSoon() { clearTimeout(volRefreshTimer); volRefreshTimer = setTimeout(refreshVolume, 700); }
  function queueVolume(n) {
    volTarget = n;
    if (volBusy) return;
    volBusy = true;
    (async function () {
      while (volTarget != null) { var v = volTarget; volTarget = null; await setVolume(v); }
      volBusy = false;
      refreshVolumeSoon();
    })();
  }
  volSlider.addEventListener("input", function () {
    volDragging = true;
    var v = Number(volSlider.value);
    $("#volValue").textContent = v;
    volSlider.style.setProperty("--fill", v + "%");
    queueVolume(v);
  });
  volSlider.addEventListener("change", function () { volDragging = false; haptic(); });
  ["pointerup", "pointercancel", "touchend"].forEach(function (ev) { volSlider.addEventListener(ev, function () { volDragging = false; }); });
  $$("[data-key='vol_up'], [data-key='vol_down']").forEach(function (b) { b.addEventListener("pointerup", refreshVolumeSoon); });

  var hudTimer;
  function showHud(v) {
    $("#volHudVal").textContent = v == null ? "–" : v;
    $("#volHudBar").style.width = (v == null ? 0 : v) + "%";
    $("#volHud").classList.add("on");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { $("#volHud").classList.remove("on"); }, 1500);
  }
  window.onVolumeKey = function (dir) {
    var tv = activeTv();
    if (!tv || !tv.paired) { toast("Set up your TV first to use the volume buttons"); return; }
    sendKey(dir === "up" ? "vol_up" : "vol_down");
    if (volKnown != null) showVolume(Math.max(0, Math.min(100, volKnown + (dir === "up" ? 1 : -1))));
    showHud(volKnown);
    refreshVolumeSoon();
  };
  var volKeys = $("#volKeysToggle");
  volKeys.checked = getJSON("remotetv.volumeKeys", true);
  function syncVolumeKeys() { try { if (hasBridge() && VizioBridge.setVolumeKeys) VizioBridge.setVolumeKeys(!!volKeys.checked); } catch (e) {} }
  volKeys.addEventListener("change", function () { haptic(); setJSON("remotetv.volumeKeys", volKeys.checked); syncVolumeKeys(); });
  syncVolumeKeys();

  // =====================================================================
  // In-app updates (GitHub releases)
  // =====================================================================
  var update = null; // { version, url, notes } when a newer version exists
  function currentVersion() {
    try { return (hasBridge() && VizioBridge.appVersion && VizioBridge.appVersion()) || ""; } catch (e) { return ""; }
  }
  function newerThan(a, b) {
    var pa = String(a).replace(/^v/i, "").split("."), pb = String(b).replace(/^v/i, "").split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
      if (x !== y) return x > y;
    }
    return false;
  }
  function setUpdStatus(text, cls) {
    var el = $("#updateStatus");
    el.textContent = text;
    el.className = "ri-sub" + (cls === "ok" ? " good" : cls === "bad" ? " bad-txt" : "");
  }
  function renderUpdateUi() {
    var b = $("#updateBanner");
    var dismissed = getJSON("remotetv.updateDismissed", "");
    b.classList.toggle("hidden", !update || dismissed === update.version);
    if (update) $("#updateBannerTitle").textContent = "Version " + update.version + " is available";
    var v = currentVersion();
    $("#appVer").textContent = v ? "v" + v : "";
  }
  function checkForUpdate(manual) {
    if (!hasBridge() || !VizioBridge.checkUpdateAsync) { if (manual) setUpdStatus("Updates can only be checked inside the app."); return; }
    if (!manual && Date.now() - getJSON("remotetv.updateCheckedAt", 0) < 2 * 60e3) {
      update = getJSON("remotetv.updateAvailable", null);
      if (update && !newerThan(update.version, currentVersion())) update = null;
      renderUpdateUi();
      return;
    }
    if (manual) setUpdStatus("Checking…");
    var id = uid();
    pending[id] = function (res) {
      if (!res.ok) { if (manual) setUpdStatus(res.error, "bad"); return; }
      var rel; try { rel = JSON.parse(res.body); } catch (e) { rel = null; }
      var asset = rel && (rel.assets || []).find(function (a) { return /\.apk$/i.test(a.name); });
      var ver = rel && String(rel.tag_name || "").replace(/^v/i, "");
      setJSON("remotetv.updateCheckedAt", Date.now());
      if (ver && asset && newerThan(ver, currentVersion())) {
        update = { version: ver, url: asset.browser_download_url, notes: String(rel.body || "").slice(0, 600) };
        if (manual) setUpdStatus("Version " + ver + " is available.", "ok");
      } else {
        update = null;
        if (manual) setUpdStatus("You're on the latest version.", "ok");
      }
      setJSON("remotetv.updateAvailable", update);
      renderUpdateUi();
      if (manual && update) openUpdateSheet();
    };
    VizioBridge.checkUpdateAsync(id);
  }
  function openUpdateSheet() {
    if (!update) return;
    var u = update;
    openSheet(
      '<h2>Update to version ' + esc(u.version) + '</h2>' +
      '<p class="lead">You\'re on version ' + esc(currentVersion() || "?") + '. Your shows, TVs and recorded steps are kept.</p>' +
      '<div class="update-progress hidden" id="upProg"><div class="bar"><i id="upBar"></i></div><span id="upPct">0%</span></div>' +
      '<div class="status-msg" id="upMsg"></div>' +
      '<div class="sheet-actions">' +
        '<button class="btn primary big block" id="upGo">' + icon("download") + 'Download and install</button>' +
        '<button class="btn ghost block" id="upLater">Not now</button>' +
      '</div>'
    );
    on("upLater", function () { setJSON("remotetv.updateDismissed", u.version); closeSheet(); renderUpdateUi(); });
    on("upGo", function () {
      var b = $("#upGo"); b.disabled = true;
      $("#upProg").classList.remove("hidden");
      setMsg("upMsg", "Downloading…");
      var id = uid();
      pending[id] = function (res) {
        b.disabled = false;
        if (res.ok) { setMsg("upMsg", "Almost done. Tap Update in the box Android shows.", "ok"); return; }
        $("#upProg").classList.add("hidden");
        if (res.needsPermission) {
          setMsg("upMsg", "Android needs your OK first: turn on \"Allow from this source\" for Remote on the screen that just opened, then come back and tap Download again.", "bad");
        } else {
          setMsg("upMsg", "Couldn't update: " + (res.error || "unknown error") + ". You can try again.", "bad");
        }
      };
      VizioBridge.installUpdateAsync(id, u.url);
    });
  }
  window.onUpdateProgress = function (pct) {
    var bar = document.getElementById("upBar");
    if (bar) { bar.style.width = pct + "%"; $("#upPct").textContent = pct + "%"; }
  };
  $("#updateBanner").addEventListener("click", function () { haptic(); openUpdateSheet(); });
  $("#checkUpdateBtn").addEventListener("click", function () { haptic(); checkForUpdate(true); });

  // =====================================================================
  // TV picker + management
  // =====================================================================
  function tvRow(t, active, withCheck) {
    return '<button class="tv-row' + (active ? " active" : "") + '" data-tv="' + t.id + '">' +
      '<div class="ri-icon">' + icon("tv") + '</div>' +
      '<div class="ri-main"><div class="ri-title">' + esc(tvLabel(t)) + '</div>' +
      '<div class="ri-sub">' + esc([t.name && t.model ? t.model : "", t.ip].filter(Boolean).join(" · ")) + (t.paired ? "" : ' · <span class="warn-txt">not paired</span>') + '</div></div>' +
      (withCheck ? '<span class="check">' + (active ? icon("check") : "") + '</span>' : '<span class="chev">›</span>') +
    '</button>';
  }

  function openTvPicker() {
    var tvs = getTvs(), cur = activeTv();
    var body = openSheet(
      '<h2>Your TVs</h2><p class="lead">Play and the remote control the TV you pick here.</p>' +
      '<div class="tv-list">' + tvs.map(function (t) { return tvRow(t, cur && t.id === cur.id, true); }).join("") + '</div>' +
      '<div class="sheet-actions">' +
        '<button class="btn block" id="pAdd">' + icon("plus") + 'Add another TV</button>' +
        '<button class="btn ghost block" id="pManage">Rename or remove TVs</button>' +
      '</div>'
    );
    $$("[data-tv]", body).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic();
        var t = getTvs().find(function (x) { return x.id === b.dataset.tv; });
        if (!canSwitchTv()) return;
        if (!t.paired) { closeSheet(); setActive(t.id); pairTv(t); return; }
        setActive(t.id); closeSheet(); toast("Now controlling " + tvLabel(t));
      });
    });
    on("pAdd", function () { closeSheet(); openOnboarding("find"); });
    on("pManage", function () { closeSheet(); showScreen("settings"); });
  }

  // =====================================================================
  // FIX CONNECTION: step-by-step repair for a TV that stopped working
  // =====================================================================
  var fixing = false;
  function connectionError(msg) {
    var tv = activeTv();
    toast(msg, tv ? { bad: true, duration: 9000, action: "Fix it", onAction: function () { openFixSheet(tv.id); } } : { bad: true, duration: 8000 });
  }

  function detailsText() {
    var net = hasBridge() && VizioBridge.networkStatus ? phoneNetwork() : null;
    var tvs = getTvs().map(function (t) {
      return "- " + tvLabel(t) + (activeTv() && activeTv().id === t.id ? " (selected)" : "") + ": " + t.ip + ":" + (t.port || "?") +
        (t.paired ? ", paired" : ", not paired") + (t.ident ? ", id " + t.ident.slice(0, 3) : ", no id") +
        (health[t.id] ? ", last " + (health[t.id].ok ? "OK" : "FAILED") + " " + Math.round((Date.now() - health[t.id].at) / 1000) + "s ago" : "");
    });
    return "Remote app v" + currentVersion() + "\n" +
      "Phone: " + (net ? (net.wifi ? "WiFi " + (net.ip || "?") : "NOT on WiFi") : "?") + "\n" +
      "TVs:\n" + tvs.join("\n") + "\n" +
      "Recent requests:\n" + (reqLog.length ? reqLog.join("\n") : "(none)");
  }
  function copyDetails() {
    try { VizioBridge.copyText(detailsText()); toast("Copied. Paste it in your chat with Claude."); }
    catch (e) { toast("Couldn't copy", { bad: true }); }
  }

  async function openFixSheet(id) {
    var t = getTvs().find(function (x) { return x.id === id; });
    if (!t || fixing) return;
    if (playing || teach) { toast("Wait until the current Play finishes first."); return; }
    fixing = true;
    var name = tvLabel(t);
    openSheet(
      '<h2>Fixing ' + esc(name) + '</h2>' +
      '<p class="lead">Checking what\'s wrong. Keep the TV on.</p>' +
      '<ul class="fix-steps" id="fixSteps"></ul>' +
      '<div id="fixResult"></div>' +
      '<button class="btn ghost block" id="fixCopy" style="margin-top:10px">Copy details to send to Claude</button>',
      function () { fixing = false; }
    );
    function step(text) {
      var li = document.createElement("li");
      li.className = "run";
      li.innerHTML = '<span class="fs-icon"><span class="spinner"></span></span><span class="fs-text">' + esc(text) + '</span>';
      var list = $("#fixSteps"); if (list) list.appendChild(li);
      return {
        done: function (ok, detail) {
          li.className = ok ? "ok" : "bad";
          li.querySelector(".fs-icon").innerHTML = icon(ok ? "check" : "close");
          if (detail) li.querySelector(".fs-text").innerHTML = esc(text) + '<small>' + esc(detail) + '</small>';
        }
      };
    }
    function result(html) { var r = $("#fixResult"); if (r) r.innerHTML = html; }
    on("fixCopy", copyDetails);
    function finishOk(msg) {
      verifiedAt = {}; lastSearchFail = {};
      result('<div class="fix-ok">' + icon("check") + '<span>' + esc(msg) + '</span></div>' +
        '<div class="sheet-actions"><button class="btn primary big block" id="fixDone">Done</button></div>');
      on("fixDone", closeSheet);
      renderTvChip(); if (current === "settings") renderSettings();
    }
    function offerPair(target, why) {
      result('<div class="note" style="margin-top:6px">' + esc(why) + '</div>' +
        '<div class="sheet-actions"><button class="btn primary big block" id="fixPair">Pair again (shows a PIN on the TV)</button></div>' +
        '<p class="hint" style="margin:10px 4px 0">Your shows, recorded steps and volume settings are kept.</p>');
      on("fixPair", function () {
        updateTv(t.id, function (x) { x.ip = target.ip; x.port = target.port || x.port; x.ident = null; });
        sheetOnClose = null; fixing = false; closeSheet();
        pairTv(getTvs().find(function (x) { return x.id === t.id; }));
      });
    }

    // 1. Phone on the right WiFi?
    var s1 = step("Your phone is on WiFi");
    var net = hasBridge() && VizioBridge.networkStatus ? phoneNetwork() : { wifi: true };
    if (net && !net.wifi) { s1.done(false, "It's using mobile data. Connect to the TV's WiFi, then tap Fix it again."); fixing = false; return; }
    s1.done(true, net && net.ip ? "Phone address " + net.ip : "");

    // 2. Is the TV where we left it?
    var s2 = step("Looking for " + name + " at " + t.ip);
    var probe = await probeTv(t);
    if (probe.reached && looksLikeTv(t, probe)) {
      if (await acceptsToken(t)) {
        s2.done(true, "It answered");
        if (probe.ident && !t.ident) updateTv(t.id, function (x) { x.ident = probe.ident; });
        finishOk(name + " is working. If something still fails, try Play again.");
        fixing = false; return;
      }
      s2.done(false, "It answered, but doesn't recognise this phone any more (it may have been reset).");
      offerPair(t, name + " needs pairing again.");
      fixing = false; return;
    }
    s2.done(false, probe.reached ? "A different device is at that address now" : "Nothing answered there");

    // 3. Search the WiFi for it.
    var s3 = step("Searching your WiFi for " + name + " (about 10 seconds)");
    var found = await scanNetwork();
    var match = null, others = [];
    for (var i = 0; i < found.length; i++) {
      var f = found[i], target = { ip: f.ip, port: f.port, authToken: t.authToken };
      var p = await probeTv(target);
      if (!p.reached) continue;
      if (looksLikeTv(t, p) && (await acceptsToken(target))) { match = { f: f, p: p }; break; }
      var known = getTvs().find(function (x) { return x.ip === f.ip && x.id !== t.id && x.paired; });
      if (!known) others.push(f);
    }
    if (match) {
      var oldIp = t.ip;
      updateTv(t.id, function (x) { x.ip = match.f.ip; x.port = match.f.port; if (match.p.ident) x.ident = match.p.ident; });
      s3.done(true, "Found it at its new address " + match.f.ip + " (was " + oldIp + ")");
      finishOk("Fixed. " + name + "'s address changed and the app has updated it.");
      fixing = false; return;
    }
    s3.done(false, found.length ? "Found " + found.length + " TV" + (found.length > 1 ? "s" : "") + ", but none recognised this phone as " + name : "No TVs answered");

    // 4. Let the person pick, or type the address.
    var html = '';
    if (others.length) {
      html += '<p class="lead" style="margin:14px 0 10px">Is one of these ' + esc(name) + '? It may have been reset, so it needs pairing again.</p>' +
        '<div class="found-list">' + others.map(function (f, i) {
          return '<button class="found" data-fixpick="' + i + '"><div class="ri-icon">' + icon("tv") + '</div><div class="ri-main">' +
            '<div class="ri-title">' + esc(f.name || f.model || "Vizio TV") + '</div><div class="ri-sub">' + esc([f.name && f.model ? f.model : "", f.ip].filter(Boolean).join(" · ")) + '</div></div><span class="chev">›</span></button>';
        }).join("") + '</div>';
    } else {
      html += '<div class="note" style="margin-top:6px">Check the TV is on and connected to WiFi (TV Menu → Network). If it\'s in standby, turn on Quick Start (Menu → System → Power Mode) so it stays reachable.</div>';
    }
    html += '<div class="field" style="margin-top:14px"><label>Or type its IP address (TV Menu → Network → Manual Setup)</label>' +
      '<div style="display:flex;gap:10px"><input class="input" id="fixIp" inputmode="decimal" placeholder="' + esc(t.ip) + '"><button class="btn primary" id="fixIpGo">Use</button></div></div>' +
      '<div class="sheet-actions"><button class="btn block" id="fixAgain">Try again</button></div>';
    result(html);
    $$("[data-fixpick]").forEach(function (b) {
      b.addEventListener("click", function () { haptic(); var f = others[Number(b.dataset.fixpick)]; offerPair({ ip: f.ip, port: f.port }, "Pair " + name + " at " + f.ip + "."); });
    });
    on("fixAgain", function () { sheetOnClose = null; closeSheet(); fixing = false; setTimeout(function () { openFixSheet(t.id); }, 300); });
    on("fixIpGo", async function () {
      var ip = $("#fixIp").value.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast("That doesn't look like an IP address"); return; }
      var target = { ip: ip, port: 0, authToken: t.authToken };
      var p = await probeTv(target);
      if (!p.reached) { toast("Nothing answered at " + ip + ". Check the number on the TV.", { bad: true }); return; }
      if (looksLikeTv(t, p) && (await acceptsToken(target))) {
        updateTv(t.id, function (x) { x.ip = ip; x.port = target.port || 0; if (p.ident) x.ident = p.ident; });
        finishOk("Fixed. " + name + " is at " + ip + " now.");
        return;
      }
      offerPair(target, "The TV at " + ip + " doesn't recognise this phone yet.");
    });
    fixing = false;
  }

  function openTvSheet(id) {
    var t = getTvs().find(function (x) { return x.id === id; });
    if (!t) return;
    var isActive = activeTv() && activeTv().id === id;
    openSheet(
      '<h2>' + esc(tvLabel(t)) + '</h2><p class="lead">' + esc([t.model, t.ip].filter(Boolean).join(" · ")) + '</p>' +
      '<div class="field"><label>Name</label><input class="input" id="tvName" value="' + esc(t.name || "") + '" placeholder="e.g. Living Room TV" maxlength="40"></div>' +
      '<div class="status-msg" id="tvMsg"></div>' +
      '<div class="sheet-actions">' +
        (isActive ? '' : '<button class="btn primary block" id="tvUse">Use this TV</button>') +
        '<button class="btn primary block" id="tvFix">' + icon("search") + 'Fix connection</button>' +
        '<button class="btn block" id="tvTest">Test connection</button>' +
        '<button class="btn block" id="tvPair">' + (t.paired ? "Pair again" : "Pair") + '</button>' +
        '<button class="btn danger block" id="tvRemove">Remove this TV</button>' +
      '</div>',
      function () {
        var n = ($("#tvName") || {}).value;
        if (n != null && n.trim() !== (t.name || "")) { updateTv(id, function (x) { x.name = n.trim(); }); renderSettings(); }
      }
    );
    on("tvUse", function () { if (!canSwitchTv()) return; setActive(id); closeSheet(); toast("Now controlling " + tvLabel(t)); });
    on("tvTest", async function () {
      setMsg("tvMsg", "Checking…");
      var res = await tvCall("GET", "/state/device/power_mode", null, { tv: t });
      if (!res.status) return setMsg("tvMsg", unreachableMessage(t), "bad");
      if (res.vizioResult && /AUTH/.test(res.vizioResult)) return setMsg("tvMsg", "Reached the TV, but it needs pairing again.", "bad");
      setMsg("tvMsg", "Connected. The TV is " + (readPowerOn(res) === false ? "in standby." : "on."), "ok");
    });
    on("tvPair", function () { closeSheet(); pairTv(t); });
    on("tvFix", function () { sheetOnClose = null; closeSheet(); setTimeout(function () { openFixSheet(id); }, 250); });
    on("tvRemove", function () {
      var l = getTvs().filter(function (x) { return x.id !== id; });
      setTvs(l);
      if (activeId() === id) setActive(l[0] ? l[0].id : null);
      sheetOnClose = null;
      closeSheet(); renderSettings();
      toast(tvLabel(t) + " removed");
    });
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  // default episodes per night for new shows
  function renderPerNightDefault() { $("#perNightVal").textContent = defaultPerNight(); }
  $$("[data-pn]").forEach(function (b) {
    b.addEventListener("click", function () {
      haptic();
      setJSON("remotetv.perNight", Math.max(1, Math.min(10, defaultPerNight() + Number(b.dataset.pn))));
      renderPerNightDefault();
    });
  });
  renderPerNightDefault();

  var patient = $("#patientToggle");
  patient.checked = getJSON("remotetv.patient", false);
  patient.addEventListener("change", function () { haptic(); setJSON("remotetv.patient", patient.checked); });

  function renderSettings() {
    var tvs = getTvs(), cur = activeTv();
    $("#tvCard").innerHTML =
      (tvs.length
        ? '<div class="tv-list">' + tvs.map(function (t) { return tvRow(t, cur && t.id === cur.id, false); }).join("") + '</div>'
        : '<div class="row-item"><div class="ri-main"><div class="ri-sub">No TV set up yet.</div></div></div>') +
      '<div class="btn-row" style="margin-top:12px">' +
        (cur && cur.paired ? '<button class="btn" id="sFix">' + icon("search") + 'Fix connection</button>' : '') +
        '<button class="btn' + (tvs.length ? "" : " primary") + '" id="sAdd">' + icon("plus") + (tvs.length ? "Add TV" : "Set up TV") + '</button></div>';
    $$("[data-tv]", $("#tvCard")).forEach(function (b) { b.addEventListener("click", function () { haptic(); openTvSheet(b.dataset.tv); }); });
    on("sAdd", function () { openOnboarding("find"); });
    on("sFix", function () { openFixSheet(activeTv().id); });

    var linked = getLinked(), used = {};
    getShows().forEach(function (s) { used[s.service] = true; });
    var ids = SERVICES.map(function (s) { return s.id; }).filter(function (id) { return used[id] || linked[id]; });
    if (!ids.length) {
      $("#appList").innerHTML = '<div class="row-item"><div class="ri-main"><div class="ri-sub">Apps show up here once you add a show.</div></div></div>';
      return;
    }
    $("#appList").innerHTML = ids.map(function (id) {
      var svc = service(id), isLinked = !!linked[id], ok = isLinked || !!svc.app;
      return '<div class="row-item"><div class="ri-icon" style="background:' + svc.color + '">' + esc(svc.short) + '</div>' +
        '<div class="ri-main"><div class="ri-title">' + esc(svc.label) + '</div>' +
        '<div class="ri-sub' + (ok ? " good" : "") + '">' + (isLinked ? "Linked from your TV" : ok ? "Ready" : "Needs linking") + '</div></div>' +
        '<button class="pill-btn' + (ok ? "" : " accent") + '" data-link="' + esc(id) + '">' + (ok ? "Re-link" : "Link") + '</button></div>';
    }).join("");
    $$("[data-link]", $("#appList")).forEach(function (b) {
      b.addEventListener("click", function () {
        haptic();
        var tv = activeTv();
        if (!tv || !tv.paired) { openOnboarding("find"); return; }
        openLinkSheet(b.dataset.link);
      });
    });
  }

  // =====================================================================
  // ONBOARDING: find TVs -> pick one -> pair -> name it
  // =====================================================================
  var ob = { step: "welcome", found: null, scanning: false, pair: null, target: null };
  var OB_ORDER = ["welcome", "find", "pair", "done"];

  function openOnboarding(step) {
    ob.step = step || "welcome";
    $("#onboard").classList.remove("hidden");
    renderOnboarding();
    if (ob.step === "find" && !ob.scanning) startScan();
  }
  function closeOnboarding() {
    setJSON("remotetv.onboarded", true);
    $("#onboard").classList.add("hidden");
    ob.pair = null;
    renderTvChip(); renderShows();
    if (current === "settings") renderSettings();
  }
  function pairTv(t) {
    ob.target = { ip: t.ip, port: t.port, name: t.name, model: t.model, id: t.id };
    ob.pair = null;
    openOnboarding("pair");
  }

  function renderOnboarding() {
    var el = $("#onboard");
    var idx = OB_ORDER.indexOf(ob.step);
    var dots = '<div class="ob-dots">' + [0, 1, 2].map(function (i) { return '<i class="' + (i === Math.min(idx, 2) ? "on" : "") + '"></i>'; }).join("") + '</div>';
    var skip = ob.step !== "done" ? '<button class="link-btn" id="obSkip">' + (ob.step === "welcome" ? "Skip" : "Close") + '</button>' : '<span></span>';
    var html = '<div class="ob-top">' + dots + skip + '</div><div class="ob-body">';
    var tvs = getTvs();

    if (ob.step === "welcome") {
      html +=
        '<div class="ob-art">' + icon("play") + '</div>' +
        '<h1>From TV off to your show in one tap</h1>' +
        '<p class="lead">This app turns on your Vizio TV, opens the streaming app and goes to your show. First, let\'s connect to your TV.</p>' +
        '<div class="ob-actions"><button class="btn primary big block" id="obNext">Get started</button></div>';
    } else if (ob.step === "find") {
      html +=
        '<div class="ob-art">' + icon("search") + '</div>' +
        '<h1>Pick your TV</h1>' +
        '<p class="lead">Turn the TV on and make sure your phone is on the same WiFi.</p>';
      if (ob.scanning) {
        html += '<div class="scanning"><div class="spinner"></div>Looking for every TV on your WiFi (about 10 seconds)…</div>';
      } else if (ob.found && ob.found.length) {
        html += '<div class="found-list">' + ob.found.map(function (f, i) {
          var known = tvs.find(function (t) { return t.ip === f.ip; });
          return '<button class="found" data-found="' + i + '"><div class="ri-icon">' + icon("tv") + '</div><div class="ri-main">' +
            '<div class="ri-title">' + esc((known && known.name) || f.name || f.model || "Vizio TV") + '</div>' +
            '<div class="ri-sub">' + esc([f.name && f.model ? f.model : "", f.ip].filter(Boolean).join(" · ")) + '</div></div>' +
            (known && known.paired ? '<span class="tag good">Paired</span>' : '<span class="chev">›</span>') + '</button>';
        }).join("") + '</div>';
      } else if (ob.found) {
        html += '<div class="note" style="margin-bottom:18px">No TV found. Check the TV is on and try again, or type its IP address. You\'ll find it on the TV under Menu → Network → Network Connection.</div>';
      }
      html +=
        '<div class="ob-actions">' +
          (ob.scanning ? '' : '<button class="btn ' + (ob.found && ob.found.length ? "" : "primary ") + 'big block" id="obScan">' + icon("search") + (ob.found ? "Search again" : "Search for TVs") + '</button>') +
          '<details style="margin-top:6px"><summary class="link-btn" style="list-style:none;text-align:center">Enter IP address instead</summary>' +
            '<div style="display:flex;gap:10px;margin-top:10px"><input class="input" id="obIp" inputmode="decimal" placeholder="192.168.1.50">' +
            '<button class="btn primary" id="obIpGo">Next</button></div></details>' +
        '</div>';
    } else if (ob.step === "pair") {
      var tn = ob.target ? (ob.target.name || ob.target.model || ob.target.ip) : "your TV";
      html +=
        '<div class="ob-art">' + icon("link") + '</div>' +
        '<h1>Enter the PIN</h1>' +
        '<p class="lead" id="obPairLead">Asking ' + esc(tn) + ' for a PIN…</p>' +
        '<input class="pin-input" id="obPin" inputmode="numeric" maxlength="6" placeholder="····" autocomplete="one-time-code">' +
        '<div class="status-msg" id="obMsg"></div>' +
        '<div class="ob-actions" style="margin-top:18px">' +
          '<button class="btn primary big block" id="obPair">Pair</button>' +
          '<button class="link-btn" id="obRetry">No PIN on the TV? Try again</button>' +
        '</div>';
    } else if (ob.step === "done") {
      var nt = activeTv();
      html +=
        '<div class="ob-art" style="background:linear-gradient(135deg,#38d39f,#2bb3c0)">' + icon("check") + '</div>' +
        '<h1>Paired!</h1>' +
        '<p class="lead">Give this TV a name so you can tell your TVs apart.</p>' +
        '<input class="input" id="obName" value="' + esc((nt && nt.name) || "") + '" placeholder="e.g. Living Room TV" maxlength="40" style="margin-bottom:18px">' +
        '<div class="ob-actions"><button class="btn primary big block" id="obDone">' + (getShows().length ? "Done" : "Next: add a show") + '</button></div>';
    }
    html += '</div>';
    el.innerHTML = html;

    on("obSkip", closeOnboarding);
    on("obNext", function () { ob.step = "find"; renderOnboarding(); if (!ob.found) startScan(); });
    on("obScan", startScan);
    on("obIpGo", function () {
      var ip = $("#obIp").value.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast("That doesn't look like an IP address"); return; }
      chooseFound({ ip: ip, port: 0, name: "", model: "" });
    });
    $$("[data-found]", el).forEach(function (b) {
      b.addEventListener("click", function () { haptic(); chooseFound(ob.found[Number(b.dataset.found)]); });
    });
    on("obPair", submitPin);
    on("obRetry", startPairing);
    on("obDone", function () {
      var n = $("#obName").value.trim(), t = activeTv();
      if (t && n) updateTv(t.id, function (x) { x.name = n; });
      var add = !getShows().length;
      closeOnboarding();
      if (add) openShowSheet(null);
    });

    var pin = $("#obPin");
    if (pin) {
      pin.addEventListener("keydown", function (e) { if (e.key === "Enter") submitPin(); });
      if (!ob.pair) startPairing();
      else $("#obPairLead").textContent = "A PIN is showing on the TV screen.";
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
      // Remember any newer name/IP info for TVs we already know.
      var l = getTvs(), dirty = false;
      ob.found.forEach(function (f) {
        var k = l.find(function (t) { return t.ip === f.ip; });
        if (k && !k.model && f.model) { k.model = f.model; dirty = true; }
      });
      if (dirty) setTvs(l);
      if (ob.step === "find") renderOnboarding();
    };
    VizioBridge.scanAsync(id);
  }

  function chooseFound(f) {
    var known = getTvs().find(function (t) { return t.ip === f.ip; });
    if (known && known.paired) {
      if (!canSwitchTv()) return;
      setActive(known.id);
      closeOnboarding();
      toast("Now controlling " + tvLabel(known));
      return;
    }
    ob.target = { ip: f.ip, port: f.port || 0, name: (known && known.name) || f.name || "", model: f.model || "", id: known && known.id };
    ob.pair = null;
    ob.step = "pair";
    renderOnboarding();
  }

  async function startPairing() {
    ob.pair = null;
    var lead = $("#obPairLead");
    setMsg("obMsg", "");
    if (!ob.target) { ob.step = "find"; renderOnboarding(); return; }
    var deviceId = "remotetv-" + uid();
    var target = { ip: ob.target.ip, port: ob.target.port };
    var res = await tvCall("PUT", "/pairing/start", { DEVICE_NAME: "Remote app", DEVICE_ID: deviceId }, { tv: target });
    if (ob.step !== "pair") return;
    if (!res.ok || !res.json || !res.json.ITEM) {
      if (lead) lead.textContent = "The TV didn't respond.";
      setMsg("obMsg", res.status ? (res.error || "Error " + res.status) + "\nYou can go back and pick a different TV." : unreachableMessage({ ip: ob.target.ip, name: ob.target.name || ob.target.ip }), "bad");
      return;
    }
    ob.target.port = target.port;
    ob.pair = { deviceId: deviceId, token: res.json.ITEM.PAIRING_REQ_TOKEN, challenge: res.json.ITEM.CHALLENGE_TYPE || 1 };
    if (lead) lead.textContent = "A PIN is now showing on the TV screen.";
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
    }, { tv: { ip: ob.target.ip, port: ob.target.port } });
    b.disabled = false;
    var token = res.ok && res.json && res.json.ITEM && res.json.ITEM.AUTH_TOKEN;
    if (!token) { setMsg("obMsg", "That PIN didn't work. Check it, or tap Try again for a new one.", "bad"); return; }

    var l = getTvs(), t = ob.target.id && l.find(function (x) { return x.id === ob.target.id; });
    if (!t) t = l.find(function (x) { return x.ip === ob.target.ip; });
    if (!t) { t = { id: uid() }; l.push(t); }
    t.ip = ob.target.ip; t.port = ob.target.port || 0;
    t.name = t.name || ob.target.name || ""; t.model = t.model || ob.target.model || "";
    t.deviceId = ob.pair.deviceId; t.authToken = token; t.paired = true;
    t.ident = null;
    setTvs(l);
    (function (id, target) {
      probeTv(target).then(function (p) {
        if (p.ident) updateTv(id, function (x) { x.ident = p.ident; if (!x.model && p.model) x.model = p.model; });
      });
    })(t.id, { ip: t.ip, port: t.port, authToken: token });
    setActive(t.id);
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
    if (teach) { closeTeach(); return true; }
    if (!$("#onboard").classList.contains("hidden")) {
      var i = OB_ORDER.indexOf(ob.step);
      if (i > 0 && ob.step !== "done") { ob.step = OB_ORDER[i - 1]; renderOnboarding(); }
      else closeOnboarding();
      return true;
    }
    if (current !== "watch") { showScreen("watch"); return true; }
    return false;
  };
  window.onAppResume = function () { checkAutoAdvance(); checkForUpdate(false); };
  document.addEventListener("visibilitychange", function () { if (!document.hidden) checkAutoAdvance(); });

  // =====================================================================
  // boot
  // =====================================================================
  (function migrate() {
    // v1.0/1.1 stored a single TV.
    var old = getJSON("remotetv.tvConfig", null);
    if (old && old.ip && !getTvs().length) {
      var t = { id: uid(), ip: old.ip, port: old.port || 0, name: old.name || "", model: "", deviceId: old.deviceId || "", authToken: old.authToken || "", paired: !!old.paired };
      setTvs([t]); setActive(t.id);
    }
    var list = getShows(), dirty = false;
    list.forEach(function (s) {
      if (!s.auto) { s.auto = "off"; dirty = true; }
      if (!s.season) { s.season = 1; dirty = true; }
      if (!s.episode) { s.episode = 1; dirty = true; }
      if (!s.steps) { s.steps = []; dirty = true; }
    });
    if (dirty) setShows(list);
  })();

  renderTvChip();
  checkAutoAdvance();
  renderUpdateUi();
  setTimeout(function () { checkForUpdate(false); }, 1500);
  showScreen("watch");
  if (!getTvs().length && !getJSON("remotetv.onboarded", false)) openOnboarding("welcome");
})();
