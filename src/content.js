(async () => {
  if (window.__meridianLoaded) return;
  window.__meridianLoaded = true;

  let TwitchIRC, EmoteRegistry;
  try {
    ({ TwitchIRC } = await import(chrome.runtime.getURL("src/twitch-irc.js")));
  } catch {
    // Stale content script after extension reload — reload the page.
    return;
  }
  try {
    ({ EmoteRegistry } = await import(chrome.runtime.getURL("src/emotes.js")));
  } catch {
    EmoteRegistry = class { constructor(){} currentMap(){ return null; } loadForChannel(){ return Promise.resolve(); } };
  }

  const PREFS_KEY = "meridian.prefs";
  function defaultRect() {
    const vw = Math.max(640, window.innerWidth || 1280);
    const vh = Math.max(480, window.innerHeight || 720);
    const width = Math.min(340, Math.max(260, Math.round(vw * 0.24)));
    const height = Math.min(420, Math.max(280, Math.round(vh * 0.46)));
    return {
      top: Math.max(40, Math.round((vh - height) / 2)),
      right: Math.max(16, Math.round(vw * 0.04)),
      width,
      height
    };
  }
  const defaults = {
    channel: "",
    mappings: {},
    overrideChannel: "",
    rect: null,                  // computed on first load
    hidden: false,
    chatDelaySec: 0,
    updateFrequencyMs: 0,
    autoscroll: true,
    hotkeyToggle: "",
    hotkeyFocusInput: "",
    blockedWords: [],
    hideDeleted: false,
    opacity: 0.55,
    fontSize: 13,
    blurRadius: 6,
    maxMessages: 300,
    blurEnabled: true,
    bgEnabled: true,
    shadowEnabled: true,
    boundToPlayer: true,
    playerAnchor: null
  };

  let prefs = { ...defaults, ...(await loadPrefs()) };
  if (!prefs.rect) prefs.rect = defaultRect();
  prefs.rect = clampRect(prefs.rect);

  function clampRect(r) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const maxW = Math.max(260, vw - 40);
    const maxH = Math.max(140, vh - 120);
    const width = Math.min(maxW, Math.max(240, r.width || 320));
    const height = Math.min(maxH, Math.max(120, r.height || 260));
    let top = Math.max(0, Math.min(vh - 60, r.top ?? 80));
    const out = { width, height, top };
    if (r.left != null) {
      out.left = Math.max(0, Math.min(vw - width, r.left));
    } else {
      out.right = Math.max(0, Math.min(vw - 60, r.right ?? 24));
    }
    return out;
  }
  let detectedHandle = null;
  let playerResizeObs = null;
  const CORNER_THRESH = 60;

  // Blocklist: rebuilt from prefs whenever prefs.blockedWords changes.
  // O(1) membership check per word; O(n) per message (n = word count).
  let blockSet = new Set();
  function rebuildBlockSet() {
    blockSet = new Set();
    for (const w of (prefs.blockedWords || [])) {
      const t = String(w).trim().toLowerCase();
      if (t) blockSet.add(t);
    }
  }
  function isBlocked(text) {
    if (blockSet.size === 0 || !text) return false;
    // Tokenize on whitespace AND common punctuation; emote/word boundary.
    const tokens = String(text).toLowerCase().split(/[^a-z0-9_]+/);
    for (const t of tokens) if (t && blockSet.has(t)) return true;
    return false;
  }

  // --- DOM ---
  const root = document.createElement("div");
  root.className = "meridian-root";
  root.innerHTML = `
    <div class="meridian-bg"></div>
    <div class="meridian-header">
      <span class="meridian-channel-field">
        <span class="meridian-channel-prefix">twitch.tv/</span>
        <input class="meridian-channel" placeholder="channel name" spellcheck="false" />
        <button class="meridian-channel-reset" data-act="auto" title="Reset to auto channel" hidden>⟲</button>
      </span>
      <div class="meridian-delay" title="Chat delay (seconds)">
        <span class="meridian-delay-icon">⏱</span>
        <button class="meridian-btn" data-act="delay-down">−</button>
        <input class="meridian-delay-val" type="text" inputmode="numeric" value="0s" spellcheck="false" />
        <button class="meridian-btn" data-act="delay-up">+</button>
      </div>
      <button class="meridian-btn" data-act="reconnect" title="Reconnect">↻</button>
      <button class="meridian-btn" data-act="hide" title="Hide">×</button>
    </div>
    <div class="meridian-status"></div>
    <div class="meridian-messages"></div>
    <div class="meridian-suggest"></div>
    <div class="meridian-input-wrap">
      <input class="meridian-input" placeholder="Send a message…" maxlength="500" autocomplete="off" />
      <button class="meridian-send" title="Send"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="13 6 19 12 13 18"></polyline></svg></button>
    </div>
    <div class="meridian-resize meridian-resize-se" data-corner="se"></div>
    <div class="meridian-resize meridian-resize-sw" data-corner="sw"></div>
    <div class="meridian-resize meridian-resize-ne" data-corner="ne"></div>
    <div class="meridian-resize meridian-resize-nw" data-corner="nw"></div>
  `;
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "meridian-toggle";
  toggleBtn.title = "Show Meridian chat";
  toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;

  document.documentElement.appendChild(root);
  document.documentElement.appendChild(toggleBtn);

  const els = {
    header: root.querySelector(".meridian-header"),
    channel: root.querySelector(".meridian-channel"),
    channelReset: root.querySelector(".meridian-channel-reset"),
    delayVal: root.querySelector(".meridian-delay-val"),
    status: root.querySelector(".meridian-status"),
    messages: root.querySelector(".meridian-messages"),
    input: root.querySelector(".meridian-input"),
    send: root.querySelector(".meridian-send"),
    suggest: root.querySelector(".meridian-suggest"),
    grips: root.querySelectorAll(".meridian-resize")
  };

  // Keep wheel/touch gestures inside the overlay — otherwise scrolling chat
  // in fullscreen activates YouTube's "suggested videos" panel.
  ["wheel", "mousewheel", "touchstart", "touchmove", "touchend"].forEach((ev) => {
    root.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  });

  rebuildBlockSet();
  applyBoundMode();
  applyAppearance();
  applyDelayDisplay();
  updateChannelInputFromPrefs();
  if (prefs.hidden) hideOverlay(); else showOverlay();

  // --- drag ---
  makeDraggable(els.header, (rect) => persistRect(rect));         // header: always drags
  makeDraggable(els.messages, (rect) => persistRect(rect), (e) => {
    // Drag from messages background or from the empty area of a notice/bubble.
    // Avoid clicks directly on text spans (allow selection there).
    if (e.target === els.messages) return true;
    const msg = e.target.closest(".meridian-msg");
    return msg && e.target === msg;
  });
  els.grips.forEach((g) => makeResizable(g, g.dataset.corner, (rect) => persistRect(rect)));

  async function persistRect(rect) {
    if (prefs.boundToPlayer) {
      const player = findPlayerElement();
      if (player) {
        const pw = player.offsetWidth, ph = player.offsetHeight;
        if (pw > 0 && ph > 0) prefs.playerAnchor = computeAnchor(rect, pw, ph);
      }
      prefs.rect = { ...(prefs.rect || {}), width: rect.width, height: rect.height };
      applyPlayerBoundRect();
    } else {
      prefs.rect = clampRect(rect);
      applyRect(prefs.rect);
    }
    await savePrefs();
  }

  // Pin distance to the closest edge in px. For the perpendicular axis, also
  // pin in px if its nearest-edge distance is within CORNER_THRESH (i.e. the
  // overlay sits in a corner); otherwise express it as a percentage so it
  // scales when the player resizes ("40% from top -> 40% from top").
  function computeAnchor(rect, pw, ph) {
    const w = rect.width, h = rect.height;
    const dl = Math.max(0, rect.left);
    const dr = Math.max(0, pw - (rect.left + w));
    const dt = Math.max(0, rect.top);
    const db = Math.max(0, ph - (rect.top + h));
    const xEdge = dl <= dr ? "left" : "right";
    const xDist = Math.min(dl, dr);
    const yEdge = dt <= db ? "top" : "bottom";
    const yDist = Math.min(dt, db);
    let xMode, yMode;
    if (xDist <= yDist) {
      xMode = "px";
      yMode = (yDist <= CORNER_THRESH) ? "px" : "pct";
    } else {
      yMode = "px";
      xMode = (xDist <= CORNER_THRESH) ? "px" : "pct";
    }
    return {
      x: { edge: xEdge, mode: xMode, value: xMode === "px" ? xDist : (xDist / pw) * 100 },
      y: { edge: yEdge, mode: yMode, value: yMode === "px" ? yDist : (yDist / ph) * 100 }
    };
  }
  function resolveAnchor(a, w, h, pw, ph) {
    const xDist = a.x.mode === "px" ? a.x.value : (a.x.value / 100) * pw;
    const yDist = a.y.mode === "px" ? a.y.value : (a.y.value / 100) * ph;
    let left = a.x.edge === "left" ? xDist : pw - w - xDist;
    let top  = a.y.edge === "top"  ? yDist : ph - h - yDist;
    left = Math.max(0, Math.min(Math.max(0, pw - w), left));
    top  = Math.max(0, Math.min(Math.max(0, ph - h), top));
    return { left, top };
  }

  // --- header actions ---
  root.querySelector('[data-act="hide"]').addEventListener("click", async (e) => {
    e.stopPropagation();
    prefs.hidden = true; await savePrefs();
    hideOverlay();
    disconnectIRC();
  });
  root.querySelector('[data-act="reconnect"]').addEventListener("click", (e) => {
    e.stopPropagation();
    reconnect();
  });
  els.channelReset.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!prefs.overrideChannel) return;
    prefs.overrideChannel = "";
    await savePrefs();
    updateChannelInputFromPrefs();
    syncChannel();
  });
  root.querySelector('[data-act="delay-down"]').addEventListener("click", async (e) => {
    e.stopPropagation();
    await setDelay(Math.max(0, (prefs.chatDelaySec || 0) - 1));
  });
  root.querySelector('[data-act="delay-up"]').addEventListener("click", async (e) => {
    e.stopPropagation();
    await setDelay(Math.min(600, (prefs.chatDelaySec || 0) + 1));
  });

  toggleBtn.addEventListener("click", async () => {
    prefs.hidden = false; await savePrefs();
    showOverlay();
    if (!irc) ensureConnected();
  });

  // --- channel input (twitch.tv/<channel> with × reset; auto-fills from mapping) ---
  // keydown handled in the document-level capture listener (search "isOurInput").
  els.channel.addEventListener("blur", commitChannelInput);
  els.channel.addEventListener("input", updateResetVisibility);

  function autoChannel() {
    if (detectedHandle && prefs.mappings?.[detectedHandle]) return prefs.mappings[detectedHandle];
    return "";
  }
  function resolveChannel() {
    return prefs.overrideChannel || autoChannel();
  }
  async function commitChannelInput() {
    const raw = els.channel.value.trim().toLowerCase().replace(/^#/, "");
    const auto = autoChannel();
    let changed = false;
    if (!raw || raw === auto) {
      if (prefs.overrideChannel) { prefs.overrideChannel = ""; changed = true; }
    } else if (raw !== prefs.overrideChannel) {
      prefs.overrideChannel = raw; changed = true;
    }
    if (changed) { await savePrefs(); syncChannel(); }
    updateChannelInputFromPrefs();
  }
  function updateChannelInputFromPrefs() {
    if (document.activeElement === els.channel) { updateResetVisibility(); return; }
    els.channel.value = resolveChannel();
    updateResetVisibility();
  }
  function updateResetVisibility() {
    const cur = els.channel.value.trim().toLowerCase();
    const auto = autoChannel();
    const isOverride = cur && cur !== auto;
    els.channelReset.hidden = !isOverride && !prefs.overrideChannel;
  }

  // --- send ---
  els.send.addEventListener("click", () => sendCurrent());
  els.input.addEventListener("input", () => updateSuggest());
  els.input.addEventListener("blur", () => setTimeout(closeSuggest, 100));

  // Handle our keys on the inputs directly; also stop propagation so YouTube
  // shortcuts (k/j/l/space/etc.) don't fire while the user is typing.
  els.input.addEventListener("keydown", (e) => {
    if (suggestState.open) {
      if (e.key === "Tab")       { e.preventDefault(); completeSuggest(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1);    return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); moveSuggest(-1);   return; }
      if (e.key === "Escape")    { e.preventDefault(); closeSuggest();    return; }
    }
    if (e.key === "Enter") { e.preventDefault(); closeSuggest(); sendCurrent(); }
    e.stopPropagation();
  });
  els.channel.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  {
      e.preventDefault();
      commitChannelInput().then(() => syncChannel());
      els.channel.blur();
    } else if (e.key === "Escape") {
      updateChannelInputFromPrefs();
      els.channel.blur();
    }
    e.stopPropagation();
  });
  [els.input, els.channel].forEach((el) => {
    el.addEventListener("keyup", (e) => e.stopPropagation());
    el.addEventListener("keypress", (e) => e.stopPropagation());
  });
  function isOurInput(t) { return t === els.input || t === els.channel || t === els.delayVal; }

  // --- emote autocomplete ---
  const suggestState = { open: false, items: [], index: 0, word: null };
  function getCurrentWord() {
    const v = els.input.value;
    const pos = els.input.selectionStart ?? v.length;
    let start = pos;
    while (start > 0 && !/\s/.test(v[start - 1])) start--;
    return { start, end: pos, text: v.slice(start, pos) };
  }
  function updateSuggest() {
    const w = getCurrentWord();
    if (!w.text || w.text.length < 2) { closeSuggest(); return; }
    const map = emoteReg?.currentMap();
    if (!map || map.size === 0) { closeSuggest(); return; }
    const needle = w.text.toLowerCase();
    const matches = [];
    for (const [name, em] of map) {
      const lc = name.toLowerCase();
      if (lc.startsWith(needle)) matches.push({ name, em, score: 0 });
      else if (lc.includes(needle)) matches.push({ name, em, score: 1 });
      if (matches.length >= 50) break;
    }
    matches.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const top = matches.slice(0, 8);
    if (top.length === 0) { closeSuggest(); return; }
    suggestState.open = true;
    suggestState.items = top;
    suggestState.index = 0;
    suggestState.word = w;
    renderSuggest();
  }
  function renderSuggest() {
    els.suggest.innerHTML = "";
    suggestState.items.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "meridian-suggest-item" + (i === suggestState.index ? " selected" : "");
      const img = document.createElement("img");
      img.src = m.em.url;
      const name = document.createElement("span");
      name.textContent = m.name;
      const prov = document.createElement("span");
      prov.className = "prov";
      prov.textContent = m.em.provider;
      row.append(img, name, prov);
      row.addEventListener("mousedown", (e) => { e.preventDefault(); suggestState.index = i; completeSuggest(); });
      els.suggest.appendChild(row);
    });
    els.suggest.classList.add("open");
  }
  function moveSuggest(delta) {
    if (!suggestState.items.length) return;
    suggestState.index = (suggestState.index + delta + suggestState.items.length) % suggestState.items.length;
    renderSuggest();
  }
  function completeSuggest() {
    const item = suggestState.items[suggestState.index];
    if (!item || !suggestState.word) return;
    const v = els.input.value;
    const w = suggestState.word;
    const inserted = item.name + " ";
    els.input.value = v.slice(0, w.start) + inserted + v.slice(w.end);
    const cursor = w.start + inserted.length;
    els.input.selectionStart = els.input.selectionEnd = cursor;
    closeSuggest();
  }
  function closeSuggest() {
    suggestState.open = false;
    els.suggest.classList.remove("open");
    els.suggest.innerHTML = "";
  }
  function sendCurrent() {
    const text = els.input.value.trim();
    if (!text) return;
    if (!irc) { setStatus("not connected"); return; }
    if (currentAuth?.kind === "anonymous") {
      setStatus("read-only — log into twitch.tv (or use OAuth in the popup) to send");
      return;
    }
    if (!irc.say(text)) { setStatus("send failed (not connected)"); return; }
    els.input.value = "";
  }

  // --- delay queue + update-frequency batching ---
  const queue = [];
  const renderBuffer = [];
  let pumpTimer = null;
  let renderTimer = null;

  function enqueue(m) {
    if (m.type === "msg" && !m.self && isBlocked(m.text)) return;
    if (m.self || (prefs.chatDelaySec || 0) <= 0) { scheduleRender(m); return; }
    queue.push(m);
    schedulePump();
  }
  function schedulePump() {
    if (pumpTimer) return;
    const head = queue[0];
    if (!head) return;
    const due = head.ts + (prefs.chatDelaySec || 0) * 1000 - Date.now();
    pumpTimer = setTimeout(() => { pumpTimer = null; flushQueue(); }, Math.max(50, due));
  }
  function flushQueue() {
    const cutoff = Date.now() - (prefs.chatDelaySec || 0) * 1000;
    while (queue.length && queue[0].ts <= cutoff) scheduleRender(queue.shift());
    schedulePump();
  }
  async function setDelay(sec) {
    prefs.chatDelaySec = sec;
    await savePrefs();
    applyDelayDisplay();
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    flushQueue();
  }
  function applyDelayDisplay() {
    if (document.activeElement === els.delayVal) return;
    els.delayVal.value = `${prefs.chatDelaySec || 0}s`;
  }
  els.delayVal.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); els.delayVal.blur(); }
    if (e.key === "Escape") { applyDelayDisplay(); els.delayVal.blur(); }
    e.stopPropagation();
  });
  els.delayVal.addEventListener("blur", () => {
    const n = parseInt(els.delayVal.value, 10);
    if (Number.isFinite(n)) setDelay(Math.max(0, Math.min(600, n)));
    else applyDelayDisplay();
  });

  function scheduleRender(m) {
    const freq = prefs.updateFrequencyMs | 0;
    if (freq <= 0) { renderMessage(m); return; }
    renderBuffer.push(m);
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      const batch = renderBuffer.splice(0);
      for (const x of batch) renderMessage(x);
    }, freq);
  }

  // --- IRC ---
  let irc = null;
  let currentAuth = null;
  let emoteReg = null;

  async function ensureConnected() {
    const resp = await chrome.runtime.sendMessage({ type: "AUTH_GET" });
    if (!resp?.ok || !resp.auth) { setStatus("auth unavailable"); return; }
    currentAuth = resp.auth;
    emoteReg = new EmoteRegistry({
      getAuth: () => currentAuth,
      onChange: () => { /* nothing to do — emotes resolved at render time */ }
    });
    applyAuthUI(currentAuth);
    if (irc) irc.disconnect();
    irc = new TwitchIRC({
      token: currentAuth.accessToken,
      login: currentAuth.login,
      displayName: currentAuth.displayName || currentAuth.login,
      anonymous: currentAuth.kind === "anonymous",
      onMessage: enqueue,
      onStatus: (s) => setStatus(formatStatus(s))
    });
    irc.connect();
    syncChannel();
  }

  function applyAuthUI(auth) {
    const anon = auth.kind === "anonymous";
    els.input.disabled = anon;
    els.send.disabled = anon;
    els.input.placeholder = anon
      ? "Read-only — log into twitch.tv to chat"
      : `Send as ${auth.displayName || auth.login}…`;
  }

  function reconnect() {
    disconnectIRC();
    ensureConnected();
  }
  function disconnectIRC() {
    if (irc) { irc.disconnect(); irc = null; lastJoined = ""; }
    // clear pending delay queue so it doesn't dump after reconnect
    queue.length = 0;
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  }

  let lastJoined = "";
  function syncChannel() {
    const target = resolveChannel();
    updateChannelInputFromPrefs();
    if (irc && target && target !== lastJoined) {
      irc.join(target);
      lastJoined = target;
      emoteReg?.loadForChannel(target).catch(() => {});
    }
  }

  // --- storage changes ---
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes["meridian.auth"] || changes["meridian.authMode"] || changes["meridian.cookieRev"]) {
      reconnect();
    }
    if (changes[PREFS_KEY]) {
      const next = { ...defaults, ...(changes[PREFS_KEY].newValue || {}) };
      const channelInputsChanged = (next.channel !== prefs.channel)
        || JSON.stringify(next.mappings) !== JSON.stringify(prefs.mappings)
        || next.overrideChannel !== prefs.overrideChannel;
      const appearanceChanged = next.opacity !== prefs.opacity
        || next.fontSize !== prefs.fontSize
        || next.blurRadius !== prefs.blurRadius
        || next.maxMessages !== prefs.maxMessages
        || next.blurEnabled !== prefs.blurEnabled
        || next.bgEnabled !== prefs.bgEnabled
        || next.shadowEnabled !== prefs.shadowEnabled;
      const delayChanged = next.chatDelaySec !== prefs.chatDelaySec;
      const boundChanged = next.boundToPlayer !== prefs.boundToPlayer;
      const blocklistChanged = JSON.stringify(next.blockedWords) !== JSON.stringify(prefs.blockedWords);
      prefs = next;
      if (channelInputsChanged) { syncChannel(); updateChannelInputFromPrefs(); }
      if (appearanceChanged) applyAppearance();
      if (delayChanged) { applyDelayDisplay(); flushQueue(); }
      if (boundChanged) applyBoundMode();
      if (blocklistChanged) rebuildBlockSet();
    }
  });

  // --- YouTube handle detection ---
  function detectYoutubeHandle() {
    const sel = [
      'ytd-video-owner-renderer a[href*="/@"]',
      'ytd-channel-name a[href*="/@"]',
      '#owner a[href*="/@"]',
      'a.yt-simple-endpoint[href*="/@"]'
    ].join(",");
    const a = document.querySelector(sel);
    const href = a?.getAttribute("href") || "";
    const m = href.match(/\/@([^/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  }
  function refreshDetectedHandle() {
    const h = detectYoutubeHandle();
    if (h !== detectedHandle) { detectedHandle = h; syncChannel(); }
    else updateChannelInputFromPrefs();
    // Retry player binding if not yet established (player may load after content script).
    if (prefs.boundToPlayer && root.parentElement !== findPlayerElement()) applyBoundMode();
  }
  refreshDetectedHandle();
  window.addEventListener("yt-navigate-finish", () => setTimeout(refreshDetectedHandle, 400));
  setInterval(refreshDetectedHandle, 2000);

  // --- hotkey ---
  document.addEventListener("keydown", (e) => {
    if (isOurInput(e.target)) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    if (prefs.hotkeyToggle && combo === prefs.hotkeyToggle) {
      e.preventDefault();
      prefs.hidden = !prefs.hidden;
      savePrefs();
      if (prefs.hidden) { hideOverlay(); disconnectIRC(); }
      else { showOverlay(); ensureConnected(); }
      return;
    }
    if (prefs.hotkeyFocusInput && combo === prefs.hotkeyFocusInput) {
      e.preventDefault();
      if (prefs.hidden) { prefs.hidden = false; savePrefs(); showOverlay(); ensureConnected(); }
      els.input.focus();
    }
  }, true);

  // --- inactivity → hide bars after 10s, blur input but keep typed text ---
  let idleTimer = null;
  function startIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      root.classList.add("meridian-idle");
      // blur any focused element inside the overlay; .value persists
      const a = document.activeElement;
      if (a && root.contains(a) && typeof a.blur === "function") a.blur();
    }, 10000);
  }
  function bumpActivity() {
    root.classList.remove("meridian-idle");
    startIdleTimer();
  }
  // Activity = mouse/keys/wheel inside the overlay OR keeping focus on an input.
  root.addEventListener("mouseenter", bumpActivity);
  root.addEventListener("mousemove", bumpActivity);
  root.addEventListener("keydown", bumpActivity);
  root.addEventListener("focusin", bumpActivity);
  root.addEventListener("input", bumpActivity, true);
  root.addEventListener("wheel", bumpActivity, { passive: true });
  // Don't clear the idle timer on mouseleave — focused input must still time out.
  // When focus leaves the overlay entirely AND the mouse is outside, drop idle state.
  root.addEventListener("focusout", () => {
    if (!root.matches(":hover") && !root.matches(":focus-within")) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      root.classList.remove("meridian-idle");
    }
  });
  root.addEventListener("mouseleave", () => {
    if (!root.matches(":focus-within")) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      root.classList.remove("meridian-idle");
    }
    // else: input is still focused → keep timer running so it can blur after 10 s
  });

  // --- autoscroll + scrollbar visibility ---
  let userScrollUntil = 0;
  let scrollbarTimer = null;
  function showScrollbar() {
    els.messages.classList.add("scrolling");
    if (scrollbarTimer) clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(() => els.messages.classList.remove("scrolling"), 800);
  }
  els.messages.addEventListener("wheel", () => {
    if (prefs.autoscroll) userScrollUntil = Date.now() + 8000;
    showScrollbar();
  }, { passive: true });
  // (no "scroll" listener — programmatic auto-scroll would falsely flash the scrollbar)
  // resume autoscroll after 8s; snap to bottom
  setInterval(() => {
    if (!prefs.autoscroll) return;
    if (userScrollUntil && Date.now() >= userScrollUntil) {
      userScrollUntil = 0;
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }, 500);

  if (!prefs.hidden) ensureConnected();

  // --- rendering ---
  function renderMessage(m) {
    const el = document.createElement("div");
    el.className = "meridian-msg" + (m.type === "notice" ? " notice" : "") + (m.self ? " self" : "");
    if (m.id) el.dataset.id = m.id;

    if (m.type === "notice") {
      el.textContent = m.text;
    } else if (m.type === "clearchat") {
      if (!m.user) { els.messages.innerHTML = ""; return; }
      els.messages.querySelectorAll(".meridian-msg").forEach((n) => {
        if (n.dataset.user !== m.user.toLowerCase()) return;
        if (prefs.hideDeleted) n.remove();
        else n.style.opacity = "0.35";
      });
      return;
    } else if (m.type === "clearmsg") {
      const n = els.messages.querySelector(`.meridian-msg[data-id="${cssEscape(m.targetMsgId)}"]`);
      if (n) { if (prefs.hideDeleted) n.remove(); else n.style.opacity = "0.35"; }
      return;
    } else if (m.type === "msg") {
      el.dataset.user = (m.user || "").toLowerCase();
      const name = document.createElement("span");
      name.className = "meridian-name";
      name.textContent = m.displayName || m.user;
      if (m.color && !m.self) name.style.color = m.color;
      const sep = document.createElement("span");
      sep.className = "meridian-sep";
      sep.textContent = ":";
      const text = document.createElement("span");
      text.className = "meridian-text";
      renderMessageText(text, m);
      el.append(name, sep, text);
    } else return;

    els.messages.appendChild(el);
    pruneOldMessages();
    if (shouldAutoscroll()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function shouldAutoscroll() {
    if (!prefs.autoscroll) return false;
    if (userScrollUntil && Date.now() < userScrollUntil) return false;
    return true;
  }

  function renderMessageText(container, m) {
    const text = m.text;
    // Insert Twitch native emotes from IRC tags first (positions are reliable).
    const native = m.emotes || [];
    const chunks = []; // [{kind:"text"|"twitch", value or {id,name}}]
    if (native.length === 0) {
      chunks.push({ kind: "text", value: text });
    } else {
      const chars = Array.from(text);
      let cursor = 0;
      for (const e of native) {
        if (cursor < e.start) chunks.push({ kind: "text", value: chars.slice(cursor, e.start).join("") });
        chunks.push({ kind: "twitch", id: e.id, name: e.name });
        cursor = e.end + 1;
      }
      if (cursor < chars.length) chunks.push({ kind: "text", value: chars.slice(cursor).join("") });
    }
    // Now substitute 3rd-party emotes inside text chunks.
    for (const c of chunks) {
      if (c.kind === "twitch") {
        container.appendChild(twitchEmoteImg(c.id, c.name));
      } else {
        appendWithThirdPartyEmotes(container, c.value);
      }
    }
  }

  function emoteNode(src, name, label) {
    const wrap = document.createElement("span");
    wrap.className = "meridian-emote-wrap";
    wrap.dataset.label = label || name;
    // Hidden text node holding the emote name — preserved when the user copies the message.
    const txt = document.createElement("span");
    txt.className = "meridian-emote-name";
    txt.textContent = name;
    const img = document.createElement("img");
    img.className = "meridian-emote";
    img.alt = name;
    img.src = src;
    wrap.append(txt, img);
    return wrap;
  }
  function twitchEmoteImg(id, name) {
    return emoteNode(`https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`, name, name);
  }

  function appendWithThirdPartyEmotes(container, str) {
    const map = emoteReg?.currentMap();
    if (!map || map.size === 0) { container.appendChild(document.createTextNode(str)); return; }
    const tokens = str.split(/(\s+)/); // keep whitespace
    for (const tok of tokens) {
      const em = tok && map.get(tok);
      if (em) {
        container.appendChild(emoteNode(em.url, tok, `${tok} · ${em.provider}`));
      } else {
        container.appendChild(document.createTextNode(tok));
      }
    }
  }

  function pruneOldMessages() {
    const max = prefs.maxMessages || 300;
    while (els.messages.childElementCount > max) els.messages.firstElementChild.remove();
  }

  function setStatus(s) { els.status.textContent = s || ""; }
  function formatStatus(s) {
    switch (s.state) {
      case "connecting": return "connecting…";
      case "disconnected": return "disconnected — retrying";
      case "error": return "connection error";
      default: return "";
    }
  }

  // --- helpers ---
  function applyRect(r) {
    root.style.top = r.top + "px";
    if (r.left != null) { root.style.left = r.left + "px"; root.style.right = "auto"; }
    else { root.style.right = (r.right ?? 24) + "px"; root.style.left = "auto"; }
    root.style.width = r.width + "px";
    root.style.height = r.height + "px";
  }
  function applyAppearance() {
    root.style.setProperty("--meridian-opacity", String(prefs.opacity ?? 0.55));
    root.style.setProperty("--meridian-font", `${prefs.fontSize ?? 13}px`);
    root.style.setProperty("--meridian-blur", `${prefs.blurRadius ?? 6}px`);
    root.classList.toggle("no-blur", prefs.blurEnabled === false);
    root.classList.toggle("no-bg", prefs.bgEnabled === false);
    root.classList.toggle("no-shadow", prefs.shadowEnabled === false);
  }
  function currentRect() {
    return { top: root.offsetTop, left: root.offsetLeft, width: root.offsetWidth, height: root.offsetHeight };
  }
  function showOverlay() { root.classList.remove("meridian-hidden"); toggleBtn.classList.remove("show"); }
  function hideOverlay() { root.classList.add("meridian-hidden"); toggleBtn.classList.add("show"); }

  async function loadPrefs() {
    const o = await chrome.storage.local.get(PREFS_KEY);
    return o[PREFS_KEY] || {};
  }
  async function savePrefs() { await chrome.storage.local.set({ [PREFS_KEY]: prefs }); }

  function cssEscape(s) {
    return (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
  }
  function comboFromEvent(e) {
    if (["Control","Alt","Shift","Meta"].includes(e.key)) return null;
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    if (parts.length === 0) return null;
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return parts.join("+");
  }

  function makeDraggable(handle, onChange, predicate) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("input,button,textarea,.meridian-resize")) return;
      if (predicate && !predicate(e)) return;
      e.preventDefault();
      e.stopPropagation(); // don't let YouTube player toggle play/pause on drag
      handle.classList.add("dragging");
      root.classList.add("meridian-dragging"); // freeze transition during drag
      const sx = e.clientX, sy = e.clientY;
      const startLeft = root.offsetLeft;
      const startTop = root.offsetTop;
      const w = root.offsetWidth;
      const h = root.offsetHeight;
      const _bp = prefs.boundToPlayer ? findPlayerElement() : null;
      const bw = _bp ? _bp.offsetWidth : window.innerWidth;
      const bh = _bp ? _bp.offsetHeight : window.innerHeight;
      const onMove = (ev) => {
        const left = Math.max(0, Math.min(bw - w, startLeft + (ev.clientX - sx)));
        const top = Math.max(0, Math.min(bh - h, startTop + (ev.clientY - sy)));
        root.style.left = left + "px";
        root.style.right = "auto";
        root.style.top = top + "px";
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        root.classList.remove("meridian-dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        onChange?.(currentRect());
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function makeResizable(grip, corner, onChange) {
    grip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      root.classList.add("meridian-dragging");
      const w0 = root.offsetWidth;
      const h0 = root.offsetHeight;
      const left0 = root.offsetLeft;
      const top0 = root.offsetTop;
      const sx = e.clientX, sy = e.clientY;
      const minW = 240, minH = 160;
      const _rbp = prefs.boundToPlayer ? findPlayerElement() : null;
      const maxW = Math.max(minW, (_rbp ? _rbp.offsetWidth : window.innerWidth) - 20);
      const maxH = Math.max(minH, (_rbp ? _rbp.offsetHeight : window.innerHeight) - 40);
      const east = corner === "se" || corner === "ne";
      const south = corner === "se" || corner === "sw";
      const onMove = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let w = w0 + (east ? dx : -dx);
        let h = h0 + (south ? dy : -dy);
        w = Math.min(maxW, Math.max(minW, w));
        h = Math.min(maxH, Math.max(minH, h));
        const newLeft = east ? left0 : Math.max(0, left0 + (w0 - w));
        const newTop = south ? top0 : Math.max(0, top0 + (h0 - h));
        root.style.width = w + "px";
        root.style.height = h + "px";
        root.style.left = newLeft + "px";
        root.style.right = "auto";
        root.style.top = newTop + "px";
      };
      const onUp = () => {
        root.classList.remove("meridian-dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        onChange?.(currentRect());
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  // --- player binding ---
  function findPlayerElement() {
    return document.querySelector('#movie_player');
  }

  function applyPlayerBoundRect() {
    const player = findPlayerElement();
    if (!player) return;
    const pw = player.offsetWidth, ph = player.offsetHeight;
    if (pw <= 0 || ph <= 0) return;
    if (!prefs.playerAnchor) {
      prefs.playerAnchor = { x: { edge: "right", mode: "px", value: 24 }, y: { edge: "top", mode: "pct", value: 18 } };
    }
    const w = Math.max(240, Math.min(pw - 20, (prefs.rect && prefs.rect.width) || 320));
    const h = Math.max(160, Math.min(ph - 40, (prefs.rect && prefs.rect.height) || 340));
    const { left, top } = resolveAnchor(prefs.playerAnchor, w, h, pw, ph);
    root.style.left = left + 'px';
    root.style.top  = top  + 'px';
    root.style.right = 'auto';
    root.style.width = w + 'px';
    root.style.height = h + 'px';
  }

  function applyBoundMode() {
    if (playerResizeObs) { playerResizeObs.disconnect(); playerResizeObs = null; }
    if (prefs.boundToPlayer) {
      const player = findPlayerElement();
      if (!player) {
        // Player not loaded yet — fall back to fixed; retry runs via refreshDetectedHandle.
        if (root.parentElement !== document.documentElement) document.documentElement.appendChild(root);
        root.style.position = 'fixed';
        applyRect(prefs.rect);
        return;
      }
      if (!prefs.playerAnchor) {
        // First time: derive anchor from current viewport-based rect.
        const pr = player.getBoundingClientRect();
        const r = prefs.rect || defaultRect();
        const rLeft = r.left != null ? r.left : window.innerWidth - r.width - (r.right ?? 24);
        if (pr.width > 0 && pr.height > 0) {
          prefs.playerAnchor = computeAnchor(
            { left: rLeft - pr.left, top: r.top - pr.top, width: r.width, height: r.height },
            pr.width, pr.height
          );
        }
      }
      if (root.parentElement !== player) player.appendChild(root);
      root.style.position = 'absolute';
      applyPlayerBoundRect();
      playerResizeObs = new ResizeObserver(() => applyPlayerBoundRect());
      playerResizeObs.observe(player);
    } else {
      // Moving back to page — convert player-relative position to viewport rect.
      if (root.parentElement && root.parentElement !== document.documentElement) {
        const pr = root.parentElement.getBoundingClientRect();
        prefs.rect = clampRect({
          top:    pr.top    + root.offsetTop,
          left:   pr.left   + root.offsetLeft,
          width:  root.offsetWidth,
          height: root.offsetHeight
        });
      }
      if (root.parentElement !== document.documentElement) document.documentElement.appendChild(root);
      root.style.position = 'fixed';
      applyRect(prefs.rect);
    }
  }
})();
