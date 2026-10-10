(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // storage helpers
  // ---------------------------------------------------------------------
  function getJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function setJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getTvConfig() {
    return getJSON("remotetv.tvConfig", { ip: "", deviceId: "", authToken: "", paired: false });
  }
  function setTvConfig(cfg) { setJSON("remotetv.tvConfig", cfg); }

  function getShows() { return getJSON("remotetv.shows", []); }
  function setShows(list) { setJSON("remotetv.shows", list); }

  function getAppConfigs() { return getJSON("remotetv.appConfigs", {}); }
  function setAppConfigs(cfgs) { setJSON("remotetv.appConfigs", cfgs); }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---------------------------------------------------------------------
  // bridge to native code (VizioBridge.kt) -- this is what actually talks
  // to the TV. See MainActivity.kt / VizioBridge.kt for why this has to be
  // native code instead of a plain fetch() call.
  // ---------------------------------------------------------------------
  function tvCall(method, path, bodyObj) {
    var cfg = getTvConfig();
    if (!cfg.ip) {
      return { ok: false, error: "No TV IP address set yet. Go to Setup first." };
    }
    if (typeof VizioBridge === "undefined") {
      return { ok: false, error: "Native bridge not available (are you running this outside the app?)." };
    }
    var bodyJson = bodyObj ? JSON.stringify(bodyObj) : "";
    var raw = VizioBridge.request(cfg.ip, method, path, bodyJson, cfg.authToken || "");
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: "Bad response from bridge: " + raw };
    }
    if (parsed.ok && parsed.body) {
      try {
        parsed.json = JSON.parse(parsed.body);
      } catch (e) { /* not all responses are JSON */ }
    }
    return parsed;
  }

  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // ---------------------------------------------------------------------
  // key codes (from Vizio's own local API -- CODESET/CODE pairs)
  // ---------------------------------------------------------------------
  var KEYS = {
    pow_on:     [11, 1], pow_off: [11, 0], pow_toggle: [11, 2],
    vol_up:     [5, 1],  vol_down: [5, 0],
    mute_toggle:[5, 4],
    up:    [3, 8], down: [3, 0], left: [3, 1], right: [3, 7], ok: [3, 2],
    back:  [4, 0], menu: [4, 8], home: [4, 15],
    input_next: [7, 1],
    exit:  [9, 0],
    play:  [2, 3], pause: [2, 2]
  };

  function sendKey(name) {
    var pair = KEYS[name];
    if (!pair) return { ok: false, error: "Unknown key " + name };
    return tvCall("PUT", "/key_command/", {
      KEYLIST: [{ CODESET: pair[0], CODE: pair[1], ACTION: "KEYPRESS" }]
    });
  }

  async function ensurePoweredOn() {
    var state = tvCall("GET", "/state/device/power_mode", null);
    var isOn = state.ok && state.json && state.json.ITEM && Number(state.json.ITEM.VALUE) !== 0;
    if (!isOn) {
      sendKey("pow_on");
      await delay(4000); // give the TV a few seconds to wake up before we send more commands
    }
    return state;
  }

  // ---------------------------------------------------------------------
  // tabs
  // ---------------------------------------------------------------------
  function showScreen(name) {
    document.querySelectorAll(".screen").forEach(function (el) {
      el.classList.toggle("hidden", el.id !== "screen-" + name);
    });
    document.querySelectorAll(".tab").forEach(function (el) {
      el.classList.toggle("active", el.dataset.screen === name);
    });
  }
  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () { showScreen(btn.dataset.screen); });
  });

  // ---------------------------------------------------------------------
  // top status pill
  // ---------------------------------------------------------------------
  function refreshStatusPill() {
    var cfg = getTvConfig();
    var pill = document.getElementById("tvStatusPill");
    if (!cfg.ip) {
      pill.textContent = "TV not set up";
      pill.className = "tvstatus";
    } else if (!cfg.paired) {
      pill.textContent = cfg.ip + " · not paired";
      pill.className = "tvstatus bad";
    } else {
      pill.textContent = cfg.ip + " · paired";
      pill.className = "tvstatus ok";
    }
  }

  // ---------------------------------------------------------------------
  // SETUP tab
  // ---------------------------------------------------------------------
  var pairState = { deviceId: null, challengeType: 1, reqToken: null };

  function initSetup() {
    var cfg = getTvConfig();
    document.getElementById("tvIp").value = cfg.ip || "";

    document.getElementById("saveIpBtn").addEventListener("click", function () {
      var ip = document.getElementById("tvIp").value.trim();
      var c = getTvConfig();
      c.ip = ip;
      setTvConfig(c);
      refreshStatusPill();
      setStatus("testResult", "Saved. Tap \"Test connection\" to check it.", "");
    });

    document.getElementById("testConnBtn").addEventListener("click", function () {
      setStatus("testResult", "Testing...", "");
      var res = tvCall("GET", "/state/device/power_mode", null);
      if (res.ok) {
        setStatus("testResult", "Reached the TV OK (HTTP " + res.status + ").", "ok");
      } else {
        setStatus("testResult", "Could not reach the TV: " + (res.error || ("HTTP " + res.status)) +
          "\nCheck the IP, and that your phone is on the same WiFi as the TV.", "bad");
      }
    });

    document.getElementById("pairStartBtn").addEventListener("click", function () {
      var deviceId = "remotetv-" + uid();
      var res = tvCall("PUT", "/pairing/start", {
        DEVICE_NAME: "RemoteTV App",
        DEVICE_ID: deviceId
      });
      if (!res.ok || !res.json || !res.json.ITEM) {
        setStatus("pairResult", "Couldn't start pairing: " + (res.error || ("HTTP " + res.status)), "bad");
        return;
      }
      pairState.deviceId = deviceId;
      pairState.reqToken = res.json.ITEM.PAIRING_REQ_TOKEN;
      pairState.challengeType = res.json.ITEM.CHALLENGE_TYPE || 1;
      document.getElementById("pinRow").classList.remove("hidden");
      setStatus("pairResult", "Look at the TV screen for a PIN, then enter it below.", "");
    });

    document.getElementById("pairSubmitBtn").addEventListener("click", function () {
      var pin = document.getElementById("pairPin").value.trim();
      if (!pin || !pairState.deviceId) {
        setStatus("pairResult", "Start pairing first, then enter the PIN shown on the TV.", "bad");
        return;
      }
      var res = tvCall("PUT", "/pairing/pair", {
        DEVICE_ID: pairState.deviceId,
        CHALLENGE_TYPE: pairState.challengeType,
        RESPONSE_VALUE: pin,
        PAIRING_REQ_TOKEN: pairState.reqToken
      });
      if (!res.ok || !res.json || !res.json.ITEM || !res.json.ITEM.AUTH_TOKEN) {
        setStatus("pairResult", "Pairing failed: " + (res.error || JSON.stringify(res.json || res.status)) +
          "\nIf the PIN expired, tap \"Start pairing\" again.", "bad");
        return;
      }
      var c = getTvConfig();
      c.deviceId = pairState.deviceId;
      c.authToken = res.json.ITEM.AUTH_TOKEN;
      c.paired = true;
      setTvConfig(c);
      refreshStatusPill();
      document.getElementById("pinRow").classList.add("hidden");
      setStatus("pairResult", "Paired! You can use Quick Launch and Remote now.", "ok");
    });

    document.getElementById("captureBtn").addEventListener("click", function () {
      var service = document.getElementById("captureService").value;
      var res = tvCall("GET", "/app/current", null);
      if (!res.ok || !res.json || !res.json.ITEM) {
        setStatus("captureResult", "Couldn't read the current app: " + (res.error || ("HTTP " + res.status)) +
          "\nMake sure the app is actually open on the TV right now, and that pairing is done.", "bad");
        return;
      }
      var val = res.json.ITEM.VALUE || res.json.ITEM;
      var cfgs = getAppConfigs();
      cfgs[service] = {
        APP_ID: val.APP_ID,
        NAME_SPACE: val.NAME_SPACE,
        MESSAGE: val.MESSAGE != null ? val.MESSAGE : null
      };
      setAppConfigs(cfgs);
      setStatus("captureResult", "Captured " + service + " — Quick Launch will reopen it to this.", "ok");
      renderAppConfigList();
    });

    renderAppConfigList();
  }

  function renderAppConfigList() {
    var cfgs = getAppConfigs();
    var wrap = document.getElementById("appConfigList");
    wrap.innerHTML = "";
    Object.keys(cfgs).forEach(function (service) {
      var item = document.createElement("div");
      item.className = "list-item";
      var c = cfgs[service];
      item.innerHTML =
        '<div><div class="li-main">' + service + '</div>' +
        '<div class="li-sub">APP_ID ' + c.APP_ID + ' · NAME_SPACE ' + c.NAME_SPACE + '</div></div>';
      var del = document.createElement("button");
      del.className = "icon-btn";
      del.textContent = "Remove";
      del.addEventListener("click", function () {
        var cfgs2 = getAppConfigs();
        delete cfgs2[service];
        setAppConfigs(cfgs2);
        renderAppConfigList();
      });
      item.appendChild(del);
      wrap.appendChild(item);
    });
  }

  function setStatus(id, text, cls) {
    var el = document.getElementById(id);
    el.textContent = text;
    el.className = "status-line" + (cls ? " " + cls : "");
  }

  // ---------------------------------------------------------------------
  // SHOWS tab
  // ---------------------------------------------------------------------
  function initShows() {
    document.getElementById("showForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var list = getShows();
      list.push({
        id: uid(),
        name: document.getElementById("showName").value.trim(),
        service: document.getElementById("showService").value,
        season: Number(document.getElementById("showSeason").value) || 1,
        episode: Number(document.getElementById("showEpisode").value) || 1
      });
      setShows(list);
      document.getElementById("showForm").reset();
      document.getElementById("showSeason").value = 1;
      document.getElementById("showEpisode").value = 1;
      renderShows();
      renderLaunchList();
    });
    renderShows();
  }

  function renderShows() {
    var wrap = document.getElementById("showList");
    wrap.innerHTML = "";
    getShows().forEach(function (show) {
      var item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML =
        '<div><div class="li-main">' + escapeHtml(show.name) + '</div>' +
        '<div class="li-sub">' + escapeHtml(show.service) + ' · S' + show.season + 'E' + show.episode + '</div></div>';
      var actions = document.createElement("div");
      actions.className = "li-actions";

      var del = document.createElement("button");
      del.className = "icon-btn";
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        setShows(getShows().filter(function (s) { return s.id !== show.id; }));
        renderShows();
        renderLaunchList();
      });

      actions.appendChild(del);
      item.appendChild(actions);
      wrap.appendChild(item);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // ---------------------------------------------------------------------
  // QUICK LAUNCH tab
  // ---------------------------------------------------------------------
  function initLaunch() {
    renderLaunchList();
  }

  function renderLaunchList() {
    var shows = getShows();
    var wrap = document.getElementById("launchList");
    var empty = document.getElementById("launchEmpty");
    wrap.innerHTML = "";
    empty.classList.toggle("hidden", shows.length > 0);

    shows.forEach(function (show) {
      var card = document.createElement("div");
      card.className = "show-card";
      card.innerHTML =
        '<div class="name">' + escapeHtml(show.name) + '</div>' +
        '<div class="meta">' + escapeHtml(show.service) + ' · Season ' + show.season + ', Episode ' + show.episode + '</div>';

      var actions = document.createElement("div");
      actions.className = "actions";

      var watchBtn = document.createElement("button");
      watchBtn.className = "watch-btn";
      watchBtn.textContent = "▶ Watch";
      watchBtn.addEventListener("click", function () { launchShow(show, watchBtn); });

      var epBtn = document.createElement("button");
      epBtn.className = "epbtn";
      epBtn.textContent = "+1 Ep";
      epBtn.addEventListener("click", function () {
        var list = getShows();
        var target = list.find(function (s) { return s.id === show.id; });
        if (target) { target.episode = (target.episode || 1) + 1; setShows(list); renderLaunchList(); }
      });

      actions.appendChild(watchBtn);
      actions.appendChild(epBtn);
      card.appendChild(actions);
      wrap.appendChild(card);
    });
  }

  async function launchShow(show, btn) {
    var cfg = getTvConfig();
    if (!cfg.paired) {
      alert("Pair with your TV first (Setup tab).");
      return;
    }
    var appCfgs = getAppConfigs();
    var appCfg = appCfgs[show.service];
    if (!appCfg) {
      alert('No captured app config for "' + show.service + '" yet.\n\nOpen ' + show.service +
        " on the TV once, then go to Setup → \"Capture app currently open on TV\".");
      return;
    }

    var original = btn.textContent;
    btn.textContent = "Powering on...";
    btn.disabled = true;
    try {
      await ensurePoweredOn();
      btn.textContent = "Opening " + show.service + "...";
      var res = tvCall("PUT", "/app/launch", {
        VALUE: { APP_ID: appCfg.APP_ID, NAME_SPACE: appCfg.NAME_SPACE, MESSAGE: appCfg.MESSAGE }
      });
      if (!res.ok) {
        alert("Couldn't launch the app: " + (res.error || ("HTTP " + res.status)));
      }
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // REMOTE tab
  // ---------------------------------------------------------------------
  function initRemote() {
    document.querySelectorAll("[data-key]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var res = sendKey(btn.dataset.key);
        if (!res.ok) {
          flashBad(btn);
        }
      });
    });
  }
  function flashBad(btn) {
    var prev = btn.style.borderColor;
    btn.style.borderColor = "#ff5a5a";
    setTimeout(function () { btn.style.borderColor = prev; }, 400);
  }

  // ---------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------
  refreshStatusPill();
  initSetup();
  initShows();
  initLaunch();
  initRemote();
})();
