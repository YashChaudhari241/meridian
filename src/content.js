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
  let HighlightEngine, DensityTracker;
  try {
    ({ HighlightEngine, DensityTracker } = await import(chrome.runtime.getURL("src/highlights.js")));
  } catch {
    HighlightEngine = class { ingest(){} prune(){} reset(){} };
    DensityTracker = class { add(){} reset(){} resolutionFor(){ return 10; } series(){ return []; } };
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
  // Default YouTube handle / Kick slug → Twitch channel mappings (separate maps per site;
  // keys are the lower-cased handle/slug, values the Twitch login).
  const DEFAULT_MAPPINGS = {
    eslcs: "eslcs",
    pgl: "pgl",
    blastpremier: "blastpremier",
    starladder_cs: "starladder_cs_en",
    starladder: "starladder_cs_en",
    valorantesports: "valorant",
    tenz: "tenz",
    ohnepixel: "ohnepixel"
  };
  const DEFAULT_KICK_MAPPINGS = {
    xqc: "xqc",
    destiny: "destiny"
  };
  const defaults = {
    channel: "",
    mappings: { ...DEFAULT_MAPPINGS },
    kickMappings: { ...DEFAULT_KICK_MAPPINGS },
    overrideChannel: "",
    rect: null,                  // computed on first load
    hidden: false,
    chatDelaySec: 0,
    updateFrequencyMs: 0,
    autoscroll: true,            // always on (no longer user-toggleable)
    hotkeyToggle: "",            // toggle chat visibility (= × / chat bubble)
    hotkeyFocus: "",             // show chat + focus the input
    blockedWords: [],
    hideDeleted: true,
    opacity: 0.51,
    fontSize: 13,
    blurRadius: 0,
    maxMessages: 300,
    blurEnabled: false,
    bgEnabled: true,
    shadowEnabled: false,
    outlineEnabled: true,        // 1px border around the chat background panel
    boundToPlayer: true,
    playerAnchor: null,
    extensionEnabled: true,      // master switch — turn Meridian off everywhere
    sites: {},                   // per-host: { "<host>": { mode, hidden } } (hidden = transient, toggled by the bubble)
    highlightTimeline: true,     // master: msgs/sec density wave on the live seekbar
    highlightEnabled: true,      // emote-surge markers on the wave (requires highlightTimeline)
    highlightThreshold: 5,       // global default: unique viewers per window (floor 3)
    highlightThresholds: {},     // per-channel overrides: { "channel": threshold }
    highlightWindowSec: 12,      // global default: rolling window the unique-viewer count is measured over (2..120)
    highlightWindows: {},        // per-channel window overrides: { "channel": seconds }
    highlightAnchorLive: true,   // anchor highlights at the live edge (scroll left) vs. the viewer's seek position
    highlightOffsetSec: 5,       // shift highlights this many sec into the past (human reaction time)
    highlightColor: "#b388ff",   // wave + emote-marker accent color (light purple)
    highlightPersistEmotes: true,  // keep emote highlights across sessions + replay them on the VOD
    highlightPersistDensity: true, // keep the intensity-timeline wave + replay it on the VOD
    emote7tv: true,              // 3rd-party emote providers (each toggleable; all on by default)
    emoteBttv: true,
    emoteFfz: true,
    textStyle: "shadow",         // chat text legibility: "none" | "shadow" | "outline"
    boldText: true,              // message body weight (names are always one step heavier)
    ytLoadOn: "live",            // YouTube: load chat on "live" (livestreams only) | "all" (any video)
    showViewers: false           // show the channel's live Twitch viewer count (OAuth only; polled ~90s)
  };

  // Chatters for @-mention autocomplete (lcLogin → displayName). Seeded from the IRC
  // NAMES list / JOINs (so lurkers who haven't typed are suggestible too) and upgraded
  // with the real display name once someone speaks.
  const chatters = new Map();
  // Hard bound so a huge channel (100k+ chatters over a session) can't grow memory
  // unboundedly — we evict the oldest. A full prefix scan of this many entries is still
  // sub-millisecond, and the suggest loop early-breaks once it has enough matches.
  const CHATTER_CAP = 50000;
  function addChatter(login, displayName) {
    if (!login) return;
    const lc = login.toLowerCase();
    const existing = chatters.get(lc);
    // Keep the best name we have — don't downgrade a real display name back to the login.
    const dn = displayName || existing || login;
    if (chatters.has(lc)) chatters.delete(lc); // re-insert → most-recent ordering
    else if (chatters.size >= CHATTER_CAP) chatters.delete(chatters.keys().next().value);
    chatters.set(lc, dn);
  }

  let prefs = { ...defaults, ...(await loadPrefs()) };
  if (!prefs.rect) prefs.rect = defaultRect();
  prefs.rect = clampRect(prefs.rect);

  // --- site adapters ---
  // Each host runs the same overlay; adapters differ only in how we find the video
  // player (for bound mode) and how we detect the channel handle (for mappings).
  const HOST = location.hostname.replace(/^www\./, "");
  const youtubeAdapter = {
    name: "youtube",
    findPlayer: () => document.querySelector("#movie_player"),
    detectHandle() {
      const sel = [
        'ytd-video-owner-renderer a[href*="/@"]',
        'ytd-channel-name a[href*="/@"]',
        '#owner a[href*="/@"]',
        'a.yt-simple-endpoint[href*="/@"]'
      ].join(",");
      const href = document.querySelector(sel)?.getAttribute("href") || "";
      const m = href.match(/\/@([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    },
    // Dock anchor: the native live-chat frame itself (reliably sized in every layout —
    // normal/theater/fullscreen — whereas #chat-container collapses to width:0 in theater).
    // We overlay our panel inside it, so we never restructure YouTube's chat layout.
    findDockAnchor: () => document.querySelector("ytd-live-chat-frame#chat"),
    nativeChatLabel: "YouTube",
    brandColor: "#FF0033",       // source-badge dot color on the docked tab
    // Timeline highlights (live DVR seekbar). Live detection: the player only renders a
    // `.ytp-live-badge` for live content — `video.duration` is unreliable (finite even live).
    hasTimeline: true,
    canSeek: true,           // real DVR seekbar — clicking a highlight seeks
    waveSpanSec: null,       // wave window = the seekbar's DVR span
    // Robust live check. The `.ytp-live-badge` element exists on EVERY video (it's just
    // `display:none` on VODs), so the old presence test (`!!querySelector`) reported every video as
    // live and rendered the timeline on VODs. Instead require a positive live signal: YouTube's
    // `ytp-live` state class (on the player or the time display), a *displayed* live badge, or an
    // infinite-duration video. All are false on a VOD → highlights stay off there.
    isLive: () => {
      const mp = document.querySelector("#movie_player");
      if (mp?.classList.contains("ytp-live")) return true;
      if (document.querySelector(".ytp-time-display.ytp-live")) return true;
      // The badge is `display:none` on VODs and laid out (display ≠ none) on live — independent of
      // whether the controls are currently visible (unlike offsetWidth, which drops to 0 when the
      // control bar auto-hides), so this won't flicker the wave off mid-stream.
      const badge = document.querySelector(".ytp-live-badge");
      if (badge && getComputedStyle(badge).display !== "none") return true;
      const v = document.querySelector("#movie_player video") || document.querySelector("video");
      return v?.duration === Infinity;
    },
    // During an ad the player reports the AD's progress on the seekbar (aria-value*), which would
    // mis-scale the timeline — callers skip mapping while this is true.
    isAd: () => {
      const mp = document.querySelector("#movie_player");
      return !!(mp && (mp.classList.contains("ad-showing") || mp.classList.contains("ad-interrupting")));
    },
    // Only treat a watch page that actually has a *laid-out* player as "active" — waiting for the
    // player to have real dimensions stops the overlay/docked panel from briefly taking over the
    // screen before YouTube finishes loading (notably in theater mode).
    hasVideo: () => {
      if (!new URLSearchParams(location.search).get("v")) return false;
      const p = document.querySelector("#movie_player");
      const laidOut = !!(p && p.offsetWidth > 0 && p.offsetHeight > 0
        && (p.querySelector("video") || document.querySelector("video")));
      if (!laidOut) return false;
      // Per the Site setting, optionally only load on livestreams (default). On a non-live video
      // the overlay never mounts/connects (pageActive stays false), so it's truly off there.
      if ((prefs.ytLoadOn || "live") === "live" && !youtubeAdapter.isLive()) return false;
      return true;
    },
    getVideo: () => document.querySelector("#movie_player video") || document.querySelector("video"),
    findSeekbar: () => document.querySelector("#movie_player .ytp-progress-bar"),
    videoId: () => new URLSearchParams(location.search).get("v") || null,
    navEvent: "yt-navigate-finish"
  };
  const kickAdapter = {
    name: "kick",
    // Kick's player box (verified live): the <video id="video-player"> sits inside
    // #injected-channel-player, which is the sized, positioned container we bind to.
    findPlayer() {
      return document.querySelector("#injected-channel-player")
        || document.querySelector("#injected-embedded-channel-player-video")
        || document.querySelector("video")?.parentElement
        || null;
    },
    // Channel slug from the URL: kick.com/<slug>.
    detectHandle() {
      const m = location.pathname.match(/^\/([A-Za-z0-9_]+)/);
      const slug = m && m[1].toLowerCase();
      const skip = new Set(["", "browse", "categories", "category", "search", "following", "dashboard", "messages", "clips"]);
      return slug && !skip.has(slug) ? slug : null;
    },
    // Dock anchor: Kick's chat sidebar (verified live — h-full column holding a header bar
    // + the messages/input body). We overlay our panel inside it.
    findDockAnchor: () => document.querySelector("#channel-chatroom"),
    nativeChatLabel: "Kick",
    brandColor: "#53FC18",       // source-badge dot color on the docked tab
    // Kick live has no usable DVR timeline, so the highlight wave/emotes are unsupported here.
    hasTimeline: false,
    isLive: () => true,
    hasVideo() { return !!(this.detectHandle() && document.querySelector("video")); },
    getVideo: () => document.querySelector("#injected-channel-player video") || document.querySelector("video"),
    findSeekbar: () => null,
    videoId: () => null,
    navEvent: null // SPA nav covered by the 2 s poll
  };
  // Content script only runs on supported hosts (see manifest).
  const SITE = /(^|\.)kick\.com$/.test(HOST) ? kickAdapter : youtubeAdapter;

  // Per-origin enable gate — lets the user turn Meridian off for youtube.com or kick.com
  // from the popup without uninstalling. Defaults ON.
  function siteEnabled() {
    const entry = prefs.sites?.[HOST];
    return entry && typeof entry.enabled === "boolean" ? entry.enabled : true;
  }
  function extensionEnabled() { return prefs.extensionEnabled !== false; }
  if (!siteEnabled() || !extensionEnabled()) {
    // Stay dormant but watch for the user re-enabling Meridian (master switch or this site) from the popup.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[PREFS_KEY]) {
        const next = changes[PREFS_KEY].newValue || {};
        const e = next.sites?.[HOST];
        const siteOn = !e || e.enabled !== false;
        const extOn = next.extensionEnabled !== false;
        if (siteOn && extOn) location.reload();
      }
    });
    return;
  }

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
  // IRC/emote + display-mode state — declared early because applyMode() (called during
  // setup) reads these; `let` would otherwise be in the temporal dead zone and throw.
  let irc = null;
  let connecting = false;          // guards ensureConnected against overlapping attempts
  let currentAuth = null;
  let emoteReg = null;
  let lastVisibleMode = "overlay"; // restored when un-hiding via the bubble
  let dockRetryTimer = null;
  // Docked-mode tab switcher state (native site chat ⇄ our Twitch chat).
  let dockTabBar = null;
  let dockAnchor = null;       // the native chat frame/column we overlay
  let dockAnchorPosSet = false; // whether we set inline position:relative on the anchor
  let dockForcedFixed = false;  // whether we've pinned the frame fixed into the reserved theater strip
  let dockLayoutObs = null;     // reacts to theater/hide-chat toggles so the layout updates instantly
  let sizeDebTimer = null;      // trailing debounce so load-time attribute flapping doesn't thrash layout
  let repinRaf = 0;             // rAF guard for re-pinning the theater-fixed chat on scroll
  // Declared up here (not next to the dock helpers) because dock()/sizeDockAnchor() can run during
  // setup — a `const` lower in the file would be in its temporal dead zone and throw, aborting init.
  const THEATER_CHAT_W = 402;   // YouTube's default live-chat column width
  let reFsUntil = 0, reFsEl = null; // brief window to re-enter fullscreen after an in-input Esc
  let dockChatTab = "twitch";  // which chat is shown while docked; default to ours
  let pageActive = false;      // true only when the page actually has a video/stream player
  let appliedMode = "inactive"; // last display mode actually applied (drives auto re-apply)

  // Blocklist: rebuilt from prefs whenever prefs.blockedWords changes.
  // O(1) membership check per word; O(n) per message (n = word count).
  let blockSet = new Set();
  function rebuildBlockSet() {
    blockSet = new Set();
    for (const w of (prefs.blockedWords || [])) {
      // Tokenize each entry the same way messages are tokenized below, so a blocked word typed
      // with punctuation (e.g. a "#WeWantDestiny3" hashtag) still matches the bare token.
      for (const t of String(w).toLowerCase().split(/[^a-z0-9_]+/)) {
        if (t) blockSet.add(t);
      }
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
        <span class="meridian-channel-scroll">
          <span class="meridian-channel-prefix">twitch.tv/</span>
          <input class="meridian-channel" placeholder="channel name" spellcheck="false" />
        </span>
        <button class="meridian-channel-follow" data-act="follow" title="Follow on Twitch" hidden><svg viewBox="0 0 24 24" width="10" height="10"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></button>
      </span>
      <div class="meridian-delay" title="Chat delay (seconds)">
        <span class="meridian-delay-icon">⏱</span>
        <button class="meridian-btn" data-act="delay-down">−</button>
        <input class="meridian-delay-val" type="text" inputmode="numeric" value="0s" spellcheck="false" />
        <button class="meridian-btn" data-act="delay-up">+</button>
      </div>
      <button class="meridian-btn" data-act="mode" title="Dock / undock">⧉</button>
      <button class="meridian-btn" data-act="reconnect" title="Reconnect">↻</button>
      <button class="meridian-btn" data-act="hide" title="Hide">×</button>
    </div>
    <div class="meridian-status"></div>
    <div class="meridian-banner meridian-conn-banner">
      <span class="meridian-banner-dot"></span>
      <span class="meridian-banner-text"></span>
      <span class="meridian-banner-shimmer"></span>
    </div>
    <div class="meridian-banner meridian-delay-banner">
      <span class="meridian-banner-dot"></span>
      <span class="meridian-banner-text"></span>
      <span class="meridian-banner-shimmer"></span>
    </div>
    <div class="meridian-viewers" title="Live viewers on Twitch">
      <svg class="meridian-viewers-eye" viewBox="0 0 24 24" width="11" height="11" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      <span class="meridian-viewers-count"></span>
    </div>
    <div class="meridian-messages"></div>
    <button class="meridian-resume" title="Resume autoscroll"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="6 4 20 12 6 20"></polygon></svg>Autoscroll</button>
    <div class="meridian-suggest"></div>
    <div class="meridian-input-wrap">
      <div class="meridian-input" contenteditable="true" role="textbox" spellcheck="false" data-placeholder="Send a message…"></div>
      <button class="meridian-send" title="Send"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"></path></svg></button>
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
    follow: root.querySelector(".meridian-channel-follow"),
    delayVal: root.querySelector(".meridian-delay-val"),
    status: root.querySelector(".meridian-status"),
    delayBanner: root.querySelector(".meridian-delay-banner"),
    delayBannerText: root.querySelector(".meridian-delay-banner .meridian-banner-text"),
    connBanner: root.querySelector(".meridian-conn-banner"),
    connBannerText: root.querySelector(".meridian-conn-banner .meridian-banner-text"),
    viewers: root.querySelector(".meridian-viewers"),
    viewersCount: root.querySelector(".meridian-viewers-count"),
    messages: root.querySelector(".meridian-messages"),
    input: root.querySelector(".meridian-input"),
    send: root.querySelector(".meridian-send"),
    suggest: root.querySelector(".meridian-suggest"),
    resume: root.querySelector(".meridian-resume"),
    modeBtn: root.querySelector('[data-act="mode"]'),
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
  applyModeVisual(); // visual only — initial connect happens after all state is declared

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
      const player = boundHost();
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
  root.querySelector('[data-act="hide"]').addEventListener("click", (e) => {
    e.stopPropagation();
    setSiteMode("hidden");
  });
  els.modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSiteMode(effectiveMode() === "docked" ? "overlay" : "docked");
  });
  root.querySelector('[data-act="reconnect"]').addEventListener("click", (e) => {
    e.stopPropagation();
    reconnect();
  });
  // Heart (signed-in only): opens the channel on twitch.tv in a new tab, where the user can
  // follow/unfollow. (Twitch removed the programmatic follow API in 2021.)
  els.follow.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const ch = resolveChannel();
    if (!ch) return;
    window.open(`https://www.twitch.tv/${encodeURIComponent(ch)}`, "_blank", "noopener");
  });
  els.follow.addEventListener("mousedown", (e) => e.stopPropagation());
  root.querySelector('[data-act="delay-down"]').addEventListener("click", async (e) => {
    e.stopPropagation();
    await setDelay(Math.max(0, (prefs.chatDelaySec || 0) - 1));
  });
  root.querySelector('[data-act="delay-up"]').addEventListener("click", async (e) => {
    e.stopPropagation();
    await setDelay(Math.min(600, (prefs.chatDelaySec || 0) + 1));
  });

  toggleBtn.addEventListener("click", () => {
    // Un-hide: return to the site's chosen visible mode (auto/overlay/docked) — the dropdown's value.
    setSiteMode(siteMode());
  });

  // --- channel input (twitch.tv/<channel> with × reset; auto-fills from mapping) ---
  // keydown handled in the document-level capture listener (search "isOurInput").
  els.channel.addEventListener("blur", commitChannelInput);
  els.channel.addEventListener("input", updateHeart);
  // The input fills the field, so clicking beside the name still edits. The `twitch.tv/` prefix and
  // the heart strip are NOT part of the input: they inherit the header's grab cursor and start a
  // drag (the prefix is uneditable, by design).
  // Rest scrolled to the LEFT (showing `twitch.tv/` + the start of the name) by default and whenever
  // the field loses focus. While focused/typing the browser keeps the caret in view natively.
  function scrollChannelToStart() {
    els.channel.scrollLeft = 0;             // input scrolls internally now (fills the field)
    const f = els.channel.parentElement;
    if (f) f.scrollLeft = 0;
  }
  els.channel.addEventListener("blur", scrollChannelToStart);

  function autoChannel() {
    const map = SITE === kickAdapter ? prefs.kickMappings : prefs.mappings;
    if (detectedHandle && map?.[detectedHandle]) return map[detectedHandle];
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
    if (document.activeElement === els.channel) { updateChannelControls(); return; }
    els.channel.value = resolveChannel();
    updateChannelControls();
    // Default to showing the start (`twitch.tv/<name>…`), not the tail.
    scrollChannelToStart();
  }
  function isSignedIn() { return currentAuth?.kind === "oauth"; }
  function updateChannelControls() {
    const showHeart = isSignedIn();
    els.follow.hidden = !showHeart;
    updateHeart();
  }
  function updateHeart() {
    const ch = resolveChannel();
    els.follow.title = ch ? `Open ${ch} on Twitch` : "Open on Twitch";
  }

  // --- send ---
  els.send.addEventListener("click", () => sendCurrent());
  els.input.addEventListener("input", () => { maybeReplaceEmoteBeforeCaret(); updateSuggest(); });
  els.input.addEventListener("blur", () => setTimeout(closeSuggest, 100));
  // Keep the contenteditable single-line and plain-text: paste as text, no newlines.
  els.input.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    document.execCommand("insertText", false, t.replace(/\r?\n/g, " "));
  });

  // Handle our keys on the inputs directly; also stop propagation so YouTube
  // shortcuts (k/j/l/space/etc.) don't fire while the user is typing.
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      // Tab always autocompletes the current word (never moves focus out of the input).
      e.preventDefault();
      e.stopPropagation();
      if (!suggestState.open) updateSuggest();
      if (suggestState.open) completeSuggest();
      return;
    }
    if (suggestState.open) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1);    return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); moveSuggest(-1);   return; }
      // (Escape handled by the window-capture listener below.)
    }
    if (e.key === "Enter") { e.preventDefault(); closeSuggest(); sendCurrent(); }
    e.stopPropagation();
  });
  // Escape must be intercepted in the CAPTURE phase at the window (the earliest point) so it beats
  // YouTube's own document/player keydown handlers — otherwise YouTube exits fullscreen before our
  // bubble-phase handler can swallow it. When our chat input is focused: close the suggest list if
  // open, else blur the input + collapse the bars — and never let the event reach YouTube.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || document.activeElement !== els.input) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (suggestState.open) { closeSuggest(); return; }
    // The browser's native Fullscreen-API Esc exit can't be cancelled, so if we're fullscreen,
    // arm a brief re-enter: this Esc dismisses the input but keeps the video fullscreen. With the
    // input now blurred, a second Esc (activeElement no longer our input) exits normally.
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { reFsEl = fsEl; reFsUntil = Date.now() + 700; }
    els.input.blur();
    root.classList.add("meridian-idle");
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }, true);
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

  // --- contenteditable input model ---
  // The chat input is a contenteditable div holding text nodes and atomic emote
  // chips (<img.meridian-input-emote data-name>). These helpers translate between
  // the DOM and a plain-text "value", and manage the caret for autocomplete.
  function nodeText(n) {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeName === "IMG" && n.dataset && n.dataset.name != null) return n.dataset.name;
    if (n.nodeName === "BR") return "";
    return n.textContent || "";
  }
  function inputText() {
    let s = "";
    for (const n of els.input.childNodes) s += nodeText(n);
    return s;
  }
  function clearInput() { els.input.textContent = ""; }
  function focusInputEnd() {
    els.input.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(els.input);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  // Caret position as { node:<text node>, offset } when the caret sits inside a text
  // node; node is null when it doesn't (e.g. right after a chip with no text yet).
  function caretTextNode() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.collapsed || !els.input.contains(r.startContainer)) return null;
    if (r.startContainer.nodeType !== 3) return null;
    return { node: r.startContainer, offset: r.startOffset };
  }
  function setCaret(node, offset) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(node, Math.max(0, Math.min(offset, node.nodeValue.length)));
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function makeInputEmote(name, url) {
    const img = document.createElement("img");
    img.className = "meridian-input-emote";
    img.src = url;
    img.alt = name;
    img.dataset.name = name;
    img.setAttribute("contenteditable", "false");
    return img;
  }
  // After a space is typed, if the token just before it is a complete emote, swap
  // the typed text for an inline emote chip (keeping the space + caret in place).
  function maybeReplaceEmoteBeforeCaret() {
    const ci = caretTextNode();
    if (!ci) return;
    const v = ci.node.nodeValue;
    const pos = ci.offset;
    if (pos === 0 || !/\s/.test(v[pos - 1])) return; // only fires right after whitespace
    let start = pos - 1;
    while (start > 0 && !/\s/.test(v[start - 1])) start--;
    const word = v.slice(start, pos - 1);
    if (!word) return;
    const em = emoteReg?.currentMap()?.get(word);
    if (!em) return;
    const before = v.slice(0, start);
    const after = v.slice(pos - 1); // includes the triggering space + trailing text
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(makeInputEmote(word, em.url));
    const afterNode = document.createTextNode(after);
    frag.appendChild(afterNode);
    ci.node.parentNode.replaceChild(frag, ci.node);
    setCaret(afterNode, 1); // afterNode starts with the triggering space; caret goes after it
  }

  // --- emote autocomplete ---
  const suggestState = { open: false, items: [], index: 0, word: null };
  function getCurrentWord() {
    const ci = caretTextNode();
    if (!ci) return { node: null, start: 0, end: 0, text: "" };
    const v = ci.node.nodeValue;
    const pos = ci.offset;
    let start = pos;
    while (start > 0 && !/\s/.test(v[start - 1])) start--;
    return { node: ci.node, start, end: pos, text: v.slice(start, pos) };
  }
  function updateSuggest() {
    const w = getCurrentWord();
    if (w.text.startsWith("@")) { updateUserSuggest(w); return; }
    if (!w.text || w.text.length < 2) { closeSuggest(); return; }
    const map = emoteReg?.currentMap();
    if (!map || map.size === 0) { closeSuggest(); return; }
    const needle = w.text.toLowerCase();
    const matches = [];
    // Prefix-only match ("Kappa" suggests on "Kap", not on "appa").
    for (const [name, em] of map) {
      if (name.toLowerCase().startsWith(needle)) matches.push({ name, em });
      if (matches.length >= 50) break;
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    const top = matches.slice(0, 8);
    if (top.length === 0) { closeSuggest(); return; }
    suggestState.open = true;
    suggestState.items = top;
    suggestState.index = 0;
    suggestState.word = w;
    renderSuggest();
  }
  function updateUserSuggest(w) {
    const needle = w.text.slice(1).toLowerCase();
    if (needle.length < 1 || chatters.size === 0) { closeSuggest(); return; }
    // Prefix-only match (on login or display name) — "ro" matches "Ross", not "styRo".
    const matches = [];
    for (const [lc, dn] of chatters) {
      if (lc.startsWith(needle) || dn.toLowerCase().startsWith(needle)) {
        matches.push({ name: dn, user: true });
        if (matches.length >= 40) break;
      }
    }
    if (matches.length === 0) { closeSuggest(); return; }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    suggestState.open = true;
    suggestState.items = matches.slice(0, 8);
    suggestState.index = 0;
    suggestState.word = w;
    renderSuggest();
  }
  function renderSuggest() {
    els.suggest.innerHTML = "";
    suggestState.items.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "meridian-suggest-item" + (i === suggestState.index ? " selected" : "");
      const name = document.createElement("span");
      const prov = document.createElement("span");
      prov.className = "prov";
      if (m.user) {
        name.textContent = "@" + m.name;
        prov.textContent = "chatter";
        row.append(name, prov);
      } else {
        const img = document.createElement("img");
        img.src = m.em.url;
        name.textContent = m.name;
        prov.textContent = m.em.provider;
        row.append(img, name, prov);
      }
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
    const w = suggestState.word;
    if (!item || !w || !w.node || !els.input.contains(w.node)) return;
    if (item.user) {
      // Insert "@name " as plain text into the caret's text node.
      const inserted = "@" + item.name + " ";
      const v = w.node.nodeValue;
      w.node.nodeValue = v.slice(0, w.start) + inserted + v.slice(w.end);
      setCaret(w.node, w.start + inserted.length);
      closeSuggest();
    } else {
      // Replace the typed word with an inline emote chip + trailing space.
      const v = w.node.nodeValue;
      const before = v.slice(0, w.start);
      const after = v.slice(w.end);
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(makeInputEmote(item.name, item.em.url));
      const afterNode = document.createTextNode(" " + after);
      frag.appendChild(afterNode);
      w.node.parentNode.replaceChild(frag, w.node);
      setCaret(afterNode, 1);
      closeSuggest();
    }
  }
  function closeSuggest() {
    suggestState.open = false;
    els.suggest.classList.remove("open");
    els.suggest.innerHTML = "";
  }
  function sendCurrent() {
    const text = inputText().trim();
    if (!text) return;
    if (!irc) { setStatus("not connected"); return; }
    if (currentAuth?.kind === "anonymous") {
      setStatus("Read only - connect twitch to send messages.");
      return;
    }
    if (!irc.say(text)) { setStatus("send failed (not connected)"); return; }
    clearInput();
  }

  // --- delay queue + update-frequency batching ---
  const queue = [];
  const renderBuffer = [];
  let pumpTimer = null;
  let renderTimer = null;

  function enqueue(m) {
    if (m.type === "roomstate") {
      // Channel id from IRC — (re)load 3rd-party channel emotes without Helix.
      const target = resolveChannel();
      if (m.roomId && target && m.channel?.toLowerCase() === target.toLowerCase()) {
        emoteReg?.loadForChannel(target, m.roomId).catch(() => {});
      }
      return;
    }
    if (m.type === "names") {
      if (!lastJoined || m.channel?.toLowerCase() === lastJoined) for (const u of m.users) addChatter(u);
      return;
    }
    if (m.type === "join") {
      if (!lastJoined || m.channel?.toLowerCase() === lastJoined) addChatter(m.user);
      return;
    }
    if (m.type === "msg" && m.user) { addChatter(m.user, m.displayName); feedHighlights(m); }
    if (m.type === "msg" && !m.self && isBlocked(m.text)) return;
    if (m.self || (prefs.chatDelaySec || 0) <= 0) { scheduleRender(m); return; }
    queue.push(m);
    schedulePump();
    updateDelayBanner();
  }
  // --- status banners (connection + delay buffering) ---
  // Both float at the top of the messages area (inside `root` → shown in overlay AND docked mode),
  // same pill style, pulsing dot + sliding shimmer. The connection banner takes priority over the
  // delay banner (you can't be buffering delayed chat before you've connected).
  let connState = "connecting";   // connecting | connected | joined | disconnected | error
  let delayPrimed = false;        // true once the first delayed message has been shown this session
  let delayTicker = null;
  function startDelayTicker() { if (!delayTicker) delayTicker = setInterval(updateDelayBanner, 250); }
  function stopDelayTicker() { if (delayTicker) { clearInterval(delayTicker); delayTicker = null; } }
  function updateConnBanner() {
    const connecting = connState === "connecting";
    const failed = connState === "disconnected" || connState === "error";
    const show = connecting || failed;
    els.connBanner.classList.toggle("show", show);
    els.connBanner.classList.toggle("error", failed);
    if (show) {
      els.connBannerText.textContent = connecting
        ? "Connecting to Twitch chat…"
        : connState === "error" ? "Connection error — reconnecting…" : "Disconnected — reconnecting…";
    }
    updateDelayBanner();          // delay banner is suppressed while the connection banner shows
  }
  function updateDelayBanner() {
    const delay = prefs.chatDelaySec || 0;
    const head = queue[0];
    // Buffering indicator only: show while the delay is holding the FIRST message(s) back, and
    // hide for good once a delayed message has actually appeared (delayPrimed). Re-armed on
    // (re)connect / channel switch / delay change.
    const connShowing = els.connBanner.classList.contains("show");
    const waiting = delay > 0 && !!head && !delayPrimed && !connShowing;
    els.delayBanner.classList.toggle("show", waiting);
    // Shift the messages down so the (solid) banner never overlaps chat text.
    root.classList.toggle("meridian-has-banner", waiting || connShowing);
    if (!waiting) { stopDelayTicker(); return; }
    const remain = Math.max(0, Math.ceil((head.ts + delay * 1000 - Date.now()) / 1000));
    els.delayBannerText.textContent = remain > 0
      ? `Buffering — first delayed message in ${remain}s`
      : `Buffering delayed chat…`;
    startDelayTicker();
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
    while (queue.length && queue[0].ts <= cutoff) { scheduleRender(queue.shift()); delayPrimed = true; }
    schedulePump();
    updateDelayBanner();
  }
  async function setDelay(sec) {
    prefs.chatDelaySec = sec;
    await savePrefs();
    applyDelayDisplay();
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    delayPrimed = false;          // re-arm the buffering indicator for the new delay
    flushQueue();
    updateDelayBanner();
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
  // (irc / currentAuth / emoteReg declared earlier — see note near the top.)

  // Which 3rd-party emote providers the user has enabled (provider strings match emotes.js).
  function enabledEmoteProviders() {
    const s = new Set();
    if (prefs.emote7tv !== false) s.add("7TV");
    if (prefs.emoteBttv !== false) s.add("BTTV");
    if (prefs.emoteFfz !== false) s.add("FFZ");
    return s;
  }

  async function ensureConnected() {
    if (!pageActive) return;          // don't connect on pages without a video
    if (irc || connecting) return;    // already connected / a connect attempt is in flight
    connecting = true;
    try {
      // On a fresh page load the background service worker is often cold, so AUTH_GET can reject
      // ("receiving end does not exist") or come back not-ok before auth resolves. Don't give up —
      // the 2 s poll calls ensureConnected again while irc is null, so a transient miss self-heals
      // instead of leaving the user to hit reconnect manually.
      // Race the message against a timeout: on a cold start the SW may not be ready and the
      // message can hang (not just reject), which would otherwise leave us stuck mid-await with
      // `connecting` pinned true — blocking the poll's retry. Time out → fall through → retry.
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ type: "AUTH_GET" }).catch(() => null),
        new Promise((res) => setTimeout(() => res(null), 3000))
      ]);
      if (!pageActive) return;        // page went inactive while we awaited
      if (!resp?.ok || !resp.auth) { connState = "connecting"; setStatus("connecting…"); updateConnBanner(); return; }
      currentAuth = resp.auth;
      emoteReg = new EmoteRegistry({
        getAuth: () => currentAuth,
        getEnabledProviders: enabledEmoteProviders,
        onChange: () => { /* nothing to do — emotes resolved at render time */ }
      });
      applyAuthUI(currentAuth);
      updateChannelControls(); // show/hide the heart based on sign-in state
      if (irc) irc.disconnect();
      irc = new TwitchIRC({
        token: currentAuth.accessToken,
        login: currentAuth.login,
        displayName: currentAuth.displayName || currentAuth.login,
        anonymous: currentAuth.kind === "anonymous",
        onMessage: enqueue,
        onStatus: (s) => { connState = s.state; setStatus(formatStatus(s)); updateConnBanner(); }
      });
      irc.connect();
      syncChannel();
    } finally {
      connecting = false;
    }
  }

  function applyAuthUI(auth) {
    const anon = auth.kind === "anonymous";
    els.input.contentEditable = anon ? "false" : "true";
    els.input.classList.toggle("disabled", anon);
    els.send.disabled = anon;
    els.input.dataset.placeholder = anon
      ? "Read only - connect twitch to send messages."
      : `Send as ${auth.displayName || auth.login}…`;
  }

  function reconnect() {
    disconnectIRC();
    ensureConnected();
  }
  function disconnectIRC() {
    if (irc) { irc.disconnect(); irc = null; lastJoined = ""; }
    chrome.storage.local.set({ [PREFS_KEY]: { ...prefs, _activeChannel: "" } }).catch(() => {});
    // clear pending delay queue so it doesn't dump after reconnect
    queue.length = 0;
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    delayPrimed = false;          // re-arm the buffering indicator for the next connection
    updateDelayBanner();
    stopViewerPoll(); setViewers(null);
  }

  // --- live Twitch viewer count (OAuth only, opt-in) ---
  let viewerTimer = null;
  function viewersEnabled() { return prefs.showViewers === true && currentAuth?.kind === "oauth"; }
  function formatViewers(n) {
    if (n == null) return "";
    if (n < 1000) return String(n);          // 1 decimal place once past 1000 (24800 → "24.8K")
    if (n < 1e6) return (n / 1e3).toFixed(1) + "K";
    return (n / 1e6).toFixed(1) + "M";
  }
  function setViewers(n) {
    if (n == null) { els.viewers.classList.remove("show"); return; }
    els.viewersCount.textContent = formatViewers(n);
    els.viewers.classList.add("show");
  }
  async function fetchViewers() {
    if (!viewersEnabled() || !lastJoined) { setViewers(null); return; }
    if (!chrome.runtime?.id) { stopViewerPoll(); return; } // content script orphaned by an extension reload
    try {
      const r = await chrome.runtime.sendMessage({ type: "STREAM_INFO", login: lastJoined });
      if (!viewersEnabled()) return;                  // toggled off mid-flight
      setViewers(r?.ok && r.live ? r.viewers : null); // hide when offline / failed
    } catch { setViewers(null); }
  }
  function stopViewerPoll() { if (viewerTimer) { clearInterval(viewerTimer); viewerTimer = null; } }
  function startViewerPoll() {
    stopViewerPoll();
    if (!viewersEnabled()) { setViewers(null); return; }
    fetchViewers();                                   // immediate, then every 90 s
    viewerTimer = setInterval(fetchViewers, 90000);
  }

  let lastJoined = "";
  function syncChannel() {
    const target = resolveChannel();
    updateChannelInputFromPrefs();
    if (irc && target && target !== lastJoined) {
      irc.join(target);
      lastJoined = target;
      chatters.clear(); // reset suggestions for the new channel (NAMES will reseed)
      queue.length = 0; delayPrimed = false; updateDelayBanner(); // re-arm buffering for the new channel
      setViewers(null); startViewerPoll();            // refetch viewer count for the new channel
      applyHighlightWindow();                          // pick up this channel's per-channel window
      emoteReg?.loadForChannel(target).catch(() => {});
      // Expose the active channel so the popup can show per-channel settings.
      prefs._activeChannel = target;
      chrome.storage.local.set({ [PREFS_KEY]: { ...prefs, _activeChannel: target } }).catch(() => {});
    }
    updateChannelControls();
  }

  // The popup asks the *active tab* for its live channel (more reliable than the global
  // `_activeChannel` storage key, which goes stale across tabs) to scope per-channel settings.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_ACTIVE_CHANNEL") {
      sendResponse({ channel: (lastJoined || resolveChannel() || "").toLowerCase() });
      return true;
    }
  });

  // --- storage changes ---
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes["meridian.oauth"]) {
      reconnect(); // user connected/disconnected their Twitch account
    }
    // Highlight cache cleared from the popup — drop in-memory markers for this video.
    if (highlightsKey && changes[highlightsKey] && changes[highlightsKey].newValue == null) {
      highlights.clear(); hlEngine.reset(); renderEmotes();
    }
    if (changes[PREFS_KEY]) {
      const next = { ...defaults, ...(changes[PREFS_KEY].newValue || {}) };
      // Master switch flipped off → tear everything down by reloading (content script then
      // early-returns at the enable gate).
      if (next.extensionEnabled === false) { location.reload(); return; }
      const channelInputsChanged = (next.channel !== prefs.channel)
        || JSON.stringify(next.mappings) !== JSON.stringify(prefs.mappings)
        || JSON.stringify(next.kickMappings) !== JSON.stringify(prefs.kickMappings)
        || next.overrideChannel !== prefs.overrideChannel;
      const appearanceChanged = next.opacity !== prefs.opacity
        || next.fontSize !== prefs.fontSize
        || next.blurRadius !== prefs.blurRadius
        || next.maxMessages !== prefs.maxMessages
        || next.blurEnabled !== prefs.blurEnabled
        || next.bgEnabled !== prefs.bgEnabled
        || next.shadowEnabled !== prefs.shadowEnabled
        || next.outlineEnabled !== prefs.outlineEnabled
        || next.textStyle !== prefs.textStyle
        || next.boldText !== prefs.boldText;
      const delayChanged = next.chatDelaySec !== prefs.chatDelaySec;
      const boundChanged = next.boundToPlayer !== prefs.boundToPlayer;
      const blocklistChanged = JSON.stringify(next.blockedWords) !== JSON.stringify(prefs.blockedWords);
      const loadOnChanged = next.ytLoadOn !== prefs.ytLoadOn;
      const prevMode = effectiveMode();
      const highlightChanged = next.highlightEnabled !== prefs.highlightEnabled
        || next.highlightTimeline !== prefs.highlightTimeline
        || next.highlightPersistEmotes !== prefs.highlightPersistEmotes
        || next.highlightPersistDensity !== prefs.highlightPersistDensity;
      const colorChanged = next.highlightColor !== prefs.highlightColor;
      const viewersChanged = next.showViewers !== prefs.showViewers;
      const windowChanged = next.highlightWindowSec !== prefs.highlightWindowSec
        || JSON.stringify(next.highlightWindows) !== JSON.stringify(prefs.highlightWindows);
      prefs = next;
      const modeChanged = effectiveMode() !== prevMode;
      if (viewersChanged) startViewerPoll(); // start polling, or stop + hide when turned off
      if (windowChanged) applyHighlightWindow();
      if (channelInputsChanged) { syncChannel(); updateChannelInputFromPrefs(); }
      if (appearanceChanged) applyAppearance();
      if (delayChanged) { applyDelayDisplay(); flushQueue(); }
      if (boundChanged && effectiveMode() === "overlay") applyBoundMode();
      if (blocklistChanged) rebuildBlockSet();
      if (loadOnChanged) syncPageActive(); // live-only ⇄ all may mount/unmount this page
      if (modeChanged) applyMode();
      if (highlightChanged) refreshHighlightState();
      if (colorChanged) applyWaveColor();
    }
  });

  // --- YouTube handle detection ---
  function refreshDetectedHandle() {
    if (!chrome.runtime?.id) return; // content script orphaned by an extension reload — go quiet
    // Mount/unmount as the SPA navigates between video pages and the feed.
    syncPageActive();
    if (!pageActive) return;
    // Safety net: if we're meant to be connected but aren't (e.g. AUTH_GET failed against a cold
    // service worker on reload), keep retrying on the 2 s poll instead of waiting for a manual
    // reconnect. The `connecting` guard inside ensureConnected makes overlapping calls a no-op.
    if (!irc && effectiveMode() !== "hidden") ensureConnected();
    const h = SITE.detectHandle();
    if (h !== detectedHandle) {
      detectedHandle = h;
      // A manual channel override is scoped to the page it was typed on — navigating to a
      // different stream must fall back to that channel's mapping, not carry the old override.
      if (prefs.overrideChannel) { prefs.overrideChannel = ""; savePrefs(); }
      syncChannel();
    }
    else updateChannelInputFromPrefs();
    // Effective mode can flip on its own in "auto" (the chat frame loading/unloading), so re-run
    // the full dispatcher when it differs from what we last applied.
    const em = effectiveMode();
    if (em !== appliedMode) { applyMode(); return; }
    // Retry player binding if not yet established (player may load after content script).
    if (em === "overlay" && prefs.boundToPlayer && root.parentElement !== boundHost()) applyBoundMode();
    // Re-assert docking if the SPA replaced the chat frame (e.g. entering theater/fullscreen
    // re-parents it); dock() is idempotent and re-homes our panel + tab bar onto the new anchor.
    if (em === "docked") {
      const anchor = SITE.findDockAnchor?.();
      if (anchor && (root.parentElement !== anchor || !anchor.contains(dockTabBar))) dock();
      else scheduleSizeDock(); // keep our panel sized; debounced so load-time flapping can't thrash
    }
  }
  refreshDetectedHandle();
  if (SITE.navEvent) window.addEventListener(SITE.navEvent, () => setTimeout(refreshDetectedHandle, 400));
  setInterval(refreshDetectedHandle, 2000);

  // Keep the theater-fixed docked chat aligned with the player as the page scrolls (rAF-throttled).
  window.addEventListener("scroll", () => {
    if (!dockForcedFixed || repinRaf) return;
    repinRaf = requestAnimationFrame(() => { repinRaf = 0; repinTheaterChat(); });
  }, { passive: true, capture: true });

  // Re-home the overlay when entering/leaving fullscreen so it stays visible inside the
  // fullscreen element (fixes the Kick overlay vanishing in fullscreen).
  ["fullscreenchange", "webkitfullscreenchange"].forEach((ev) =>
    document.addEventListener(ev, () => {
      // If we just dropped out of fullscreen because of an in-input Esc, re-enter (keeps the
      // video fullscreen; the now-blurred input lets a second Esc exit normally).
      if (!(document.fullscreenElement || document.webkitFullscreenElement) && reFsEl && Date.now() < reFsUntil) {
        reFsUntil = 0; const el = reFsEl; reFsEl = null;
        (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
        return;
      }
      // Our re-layout (dock/undock + player resize nudge) is deferred a frame so it runs AFTER the
      // browser's fullscreen transition instead of competing with it — keeps the toggle smoother.
      requestAnimationFrame(() => {
        // In "auto" the effective mode flips (overlay⇄docked) with fullscreen — re-apply fully.
        if (siteMode() === "auto") { applyMode(); return; }
        if (effectiveMode() === "overlay" && prefs.boundToPlayer) applyBoundMode();
      });
    })
  );

  // --- hotkeys ---
  // 1. Toggle visibility — same as the × button / chat bubble (hide ⇄ return to the chosen mode).
  // 2. Focus input — reveal chat (if hidden) and put the caret in the message box.
  function toggleVisibility() {
    if (effectiveMode() === "hidden") setSiteMode(siteMode());
    else setSiteMode("hidden");
  }
  function focusChatInput() {
    const reveal = () => { root.classList.remove("meridian-idle"); bumpActivity(); focusInputEnd(); };
    if (effectiveMode() === "hidden") setSiteMode(siteMode()).then(reveal);
    else reveal();
  }
  // Blur the input and (in overlay mode) collapse the bars — same end state as Esc / the idle timer.
  function unfocusChatInput() {
    closeSuggest();
    els.input.blur();
    root.classList.add("meridian-idle");
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  document.addEventListener("keydown", (e) => {
    // comboFromEvent requires a modifier, so plain typing in our input never reaches a hotkey.
    const combo = comboFromEvent(e);
    if (!combo) return;
    if (prefs.hotkeyToggle && combo === prefs.hotkeyToggle) { e.preventDefault(); toggleVisibility(); }
    else if (prefs.hotkeyFocus && combo === prefs.hotkeyFocus) {
      e.preventDefault();
      // Pressing the focus hotkey while the input is already focused toggles back off.
      if (document.activeElement === els.input) unfocusChatInput();
      else focusChatInput();
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

  // --- emote name/provider tooltip ---
  // One shared tooltip on `root` (escapes the messages-box overflow that clipped the old per-emote
  // ::after on the top line / near the edges). Shown on hover via delegation; flips below when there
  // isn't room above.
  const emoteTip = document.createElement("div");
  emoteTip.className = "meridian-emote-tip";
  root.appendChild(emoteTip);
  let tipWrap = null;
  function showEmoteTip(wrap) {
    if (wrap === tipWrap) return;   // mouseover re-fires within the same emote — skip the layout reads
    tipWrap = wrap;
    const label = wrap.dataset.label || "";
    if (!label) return;
    emoteTip.textContent = label;
    emoteTip.classList.add("show");
    const rr = root.getBoundingClientRect();
    const er = wrap.getBoundingClientRect();
    const tw = emoteTip.offsetWidth, th = emoteTip.offsetHeight;
    let left = (er.left - rr.left) + er.width / 2;
    left = Math.max(tw / 2 + 4, Math.min(rr.width - tw / 2 - 4, left));
    emoteTip.style.left = left + "px";
    const above = (er.top - rr.top) - 6;
    if (above - th < 2) {                               // not enough room above → drop below
      emoteTip.classList.add("below");
      emoteTip.style.top = (er.bottom - rr.top + 6) + "px";
    } else {
      emoteTip.classList.remove("below");
      emoteTip.style.top = above + "px";
    }
  }
  function hideEmoteTip() { tipWrap = null; emoteTip.classList.remove("show"); }
  els.messages.addEventListener("mouseover", (e) => {
    const wrap = e.target.closest?.(".meridian-emote-wrap");
    if (wrap) showEmoteTip(wrap);
  });
  els.messages.addEventListener("mouseout", (e) => {
    const wrap = e.target.closest?.(".meridian-emote-wrap");
    // Only hide when actually leaving the wrap — not when crossing between its own children.
    if (wrap && !wrap.contains(e.relatedTarget)) hideEmoteTip();
  });

  // --- autoscroll + scrollbar visibility ---
  let userScrollUntil = 0;
  let scrollbarTimer = null;
  function showScrollbar() {
    els.messages.classList.add("scrolling");
    if (scrollbarTimer) clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(() => els.messages.classList.remove("scrolling"), 800);
  }
  function setResumePill(show) { els.resume.classList.toggle("show", !!show); }
  function resumeAutoscroll() {
    userScrollUntil = 0;
    setResumePill(false);
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  els.messages.addEventListener("wheel", () => {
    if (prefs.autoscroll) { userScrollUntil = Date.now() + 8000; setResumePill(true); }
    showScrollbar();
  }, { passive: true });
  els.resume.addEventListener("click", (e) => { e.stopPropagation(); resumeAutoscroll(); });
  els.resume.addEventListener("mousedown", (e) => e.stopPropagation());
  // If the user manually scrolls back down to the bottom, immediately re-engage autoscroll (no need
  // to wait out the 8 s timeout). Only acts while paused; doesn't flash the scrollbar.
  els.messages.addEventListener("scroll", () => {
    hideEmoteTip();   // content moved under the cursor → drop the (now stale) emote tooltip
    if (!prefs.autoscroll || !userScrollUntil) return;
    const m = els.messages;
    // Generous threshold (~1.5 lines): on a fast chat the bottom keeps moving as messages arrive
    // while paused, so an exact-bottom test can never be hit. Near-bottom is enough to re-engage.
    if (m.scrollHeight - m.scrollTop - m.clientHeight <= 28) resumeAutoscroll();
  }, { passive: true });
  // resume autoscroll after 8s; snap to bottom
  setInterval(() => {
    if (!prefs.autoscroll) { setResumePill(false); return; }
    if (userScrollUntil && Date.now() >= userScrollUntil) resumeAutoscroll();
  }, 500);

  // Initial mount + connect — only if this page has a video (syncPageActive → applyMode).
  syncPageActive();

  // --- timeline highlights ---
  // Two layers, both live-streams-only, rendered over the seekbar:
  //   1. A "most-replayed"-style WAVE driven by chat activity (msgs/sec). Height is relative
  //      (renormalized to the running peak every minute) and the horizontal resolution adapts
  //      to stream length (~10 s/point for a 10 min stream → ~2 min/point for 6 h), recomputed
  //      every 10 min. No threshold.
  //   2. EMOTE highlights — when ≥ threshold unique viewers spam one emote in ~12 s, a small
  //      emote sits on the wave at that moment. Near-together emotes are grouped (one shown +
  //      a "+N" badge); grouping also caps the total rendered at ~50. Requires the wave.
  const SVGNS = "http://www.w3.org/2000/svg";
  const HIGHLIGHT_CAP = 300;    // max emote highlights kept in memory (and persisted) per video
  const density = new DensityTracker({ baseRes: 2 });
  const highlights = new Map(); // key -> { name, url, count, threshold, wallTs, vt, behindLive }
  const hlEngine = new HighlightEngine({
    windowMs: highlightWindow() * 1000,            // per-channel/global; refreshed below, not per-occurrence
    getThreshold: highlightThreshold,
    onHighlight: addHighlight,
    onUpdate: bumpHighlight
  });
  // Push the resolved window into the engine on channel switch / pref change (keeps the per-message
  // hot path a plain field read instead of re-resolving the channel + clamping every occurrence).
  function applyHighlightWindow() { hlEngine.windowMs = highlightWindow() * 1000; }
  let waveLayer = null;
  let lastSeries = null, lastSpan = 0, lastStart = 0, lastOff = 0;
  let densityRes = 5, densityPeak = 1, lastPeakAt = 0, lastResAt = 0;
  // Cached seekbar stream-time live edge so the per-message hot path can timestamp density in the
  // SAME coordinate space as the emote markers (no DOM read per message). Refreshed by the 2 s loop.
  let liveEdgeVt = 0, liveEdgeAt = 0;
  function waveColor() { return prefs.highlightColor || "#b388ff"; }
  function applyWaveColor() {
    if (!waveLayer) return;
    const c = waveColor();
    waveLayer.querySelectorAll("#meridianWaveGrad stop").forEach((st) => st.setAttribute("stop-color", c));
    const tl = waveLayer.querySelector(".meridian-wave-topline");
    if (tl) tl.setAttribute("stroke", c);
  }
  let highlightsKey = "";
  let saveHlTimer = null;
  let densityKey = "";
  let saveDensityTimer = null;
  // Refreshed by the 2 s render loop so the per-message hot path needs no DOM access.
  let densityArmed = false;
  let atLiveCached = true; // whether playback is at/near the live edge (refreshed by the 2 s loop)

  // Only record while the viewer is at the live edge. When they scrub back to replay, the wave +
  // emote detection key off the live edge, so we pause recording (existing markers stay correctly
  // positioned by their stored stream-time, and clicking one still seeks to it).
  function atLiveEdge(s) {
    const v = s.v;
    if (!v || !Number.isFinite(v.currentTime)) return true;
    return (s.end - v.currentTime) <= 30; // within 30 s of the live edge counts as "live"
  }

  function highlightThreshold() {
    const ch = (lastJoined || "").toLowerCase();
    const per = ch && prefs.highlightThresholds?.[ch];
    return Math.max(3, (per ?? prefs.highlightThreshold) | 0 || 5);
  }
  // Rolling unique-viewer window (seconds, clamped 2..120): per-channel override else the global.
  function highlightWindow() {
    const ch = (lastJoined || "").toLowerCase();
    const per = ch && prefs.highlightWindows?.[ch];
    const sec = (per ?? prefs.highlightWindowSec) | 0 || 12;
    return Math.max(2, Math.min(120, sec));
  }
  function highlightOffset() { const n = prefs.highlightOffsetSec; return Number.isFinite(n) ? Math.max(0, n) : 5; }
  function isLiveStream() {
    // `video.duration` is unreliable on YouTube live (often finite), so prefer the adapter's
    // DOM-based live check (e.g. the .ytp-live-badge); fall back to duration if unavailable.
    if (typeof SITE.isLive === "function") return SITE.isLive();
    const v = SITE.getVideo?.();
    return !!(v && v.duration === Infinity);
  }
  // The wave is shown either LIVE (recording in real time) or in REPLAY on the finished VOD — a
  // YouTube livestream keeps the same `watch?v=<id>` URL after it ends, so we re-key the persisted
  // wave/markers by that videoId and replay them on the archive. `replayLoaded` is set by
  // loadHighlights once persisted data for a non-live video has been read in.
  let replayLoaded = false;
  function waveActive() {
    if (!(SITE.hasTimeline && prefs.highlightTimeline)) return false;
    return isLiveStream() || replayLoaded;
  }
  // We only RECORD while genuinely live (on a VOD the IRC carries the channel's *current* chat,
  // which must never be written into the archived timeline).
  function recordingActive() { return waveActive() && isLiveStream(); }
  function emoteHighlightsActive() { return waveActive() && prefs.highlightEnabled; }

  function videoSeekable() {
    if (SITE.isAd?.()) return null; // ad playing — the seekbar shows the ad, not the stream
    const v = SITE.getVideo?.();
    // Prefer the progress bar's OWN scale (aria-valuemin/valuemax) — that's exactly the range
    // YouTube uses to draw the scrubber, so mapping against it keeps our markers/wave pixel-synced
    // with the bar (both position AND span). `video.seekable` is only a fallback: its `.end`
    // freezes on live, which is what made the timeline drift out of scale.
    const bar = SITE.findSeekbar?.();
    if (bar) {
      const min = parseFloat(bar.getAttribute("aria-valuemin"));
      const max = parseFloat(bar.getAttribute("aria-valuemax"));
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) return { v, start: min, end: max };
    }
    if (v && v.seekable && v.seekable.length) {
      const start = v.seekable.start(0);
      const end = v.seekable.end(v.seekable.length - 1);
      if (end > start) return { v, start, end };
    }
    return null;
  }

  function feedHighlights(m) {
    // Hot path (runs per message) — no DOM here (`densityArmed`/`liveEdgeVt` refreshed by the 2 s
    // loop). Density is keyed by the seekbar's STREAM-TIME (the same coordinate the emote markers
    // use) so the wave and the emotes scroll/scale in exact lockstep and never drift apart. We
    // extrapolate the live edge forward from the last sample by wall-clock elapsed.
    if (m.self || !densityArmed || !atLiveCached || liveEdgeVt <= 0) return; // pause when replaying behind live
    density.add(liveEdgeVt + (Date.now() - liveEdgeAt) / 1000, 1);
    if (!prefs.highlightEnabled) return;
    const user = (m.user || "").toLowerCase();
    const seen = new Set();
    for (const e of m.emotes || []) {
      if (e.name && !seen.has(e.name)) {
        seen.add(e.name);
        hlEngine.ingest(e.name, `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/1.0`, user, m.ts);
      }
    }
    const map = emoteReg?.currentMap();
    if (map && map.size && m.text) {
      for (const tok of m.text.split(/\s+/)) {
        if (tok && !seen.has(tok)) {
          const em = map.get(tok);
          if (em) { seen.add(tok); hlEngine.ingest(tok, em.url, user, m.ts); }
        }
      }
    }
  }

  function addHighlight(h) {
    const s = videoSeekable();
    if (!s) return;
    // Store the surge's stream-time = the live edge (bar's aria-valuemax) as it was when the
    // surge's first emote arrived, so it maps onto the seekbar with YouTube's own coordinates and
    // scrolls/scales in exact lockstep. `behindLive` shifts the off-anchor mode to the viewer's
    // playback position instead of the live edge.
    const edge = s.end - Math.max(0, (Date.now() - h.firstTs) / 1000);
    highlights.set(h.key, {
      key: h.key, name: h.name, url: h.url, count: h.count, threshold: h.threshold,
      wallTs: h.firstTs, vt: edge, behindLive: Math.max(0, edge - s.v.currentTime)
    });
    // Bound memory: a long stream can produce thousands of surges. Keep only the most recent
    // HIGHLIGHT_CAP (Map preserves insertion order → evict the oldest). Matches the storage cap so
    // nothing extra lingers in RAM. Clustering already limits what's *rendered* to ~50.
    while (highlights.size > HIGHLIGHT_CAP) highlights.delete(highlights.keys().next().value);
    renderEmotes();
    scheduleSaveHighlights();
  }
  function bumpHighlight(u) {
    const rec = highlights.get(u.key);
    if (!rec) return;
    rec.count = u.count; // picked up by the next renderEmotes() pass (2 s loop)
    scheduleSaveHighlights();
  }

  // The stream-time a highlight points at: its detection live-edge, shifted into the past by the
  // reaction-time offset (and, in off-anchor mode, by how far behind live the viewer was).
  function highlightVt(rec) {
    const behind = (prefs.highlightAnchorLive === false) ? (rec.behindLive || 0) : 0;
    return rec.vt - highlightOffset() - behind;
  }
  // Horizontal fraction (0..1) on the seekbar for a highlight — mapped through the bar's own
  // scale (aria-valuemin..aria-valuemax), so it scrolls AND scales in lockstep with the scrubber.
  function highlightFrac(rec, s) {
    const span = s.end - s.start;
    if (span <= 0) return null;
    return (highlightVt(rec) - s.start) / span;
  }

  function seekTo(t) {
    const s = videoSeekable();
    if (!s) return;
    s.v.currentTime = Math.max(s.start, Math.min(s.end, t));
  }

  // --- wave + emote rendering ---
  function ensureWaveLayer() {
    const bar = SITE.findSeekbar?.();
    if (!bar) return null;
    if (waveLayer && waveLayer.parentElement === bar) return waveLayer;
    if (waveLayer && waveLayer.parentElement) waveLayer.remove();
    waveLayer = document.createElement("div");
    waveLayer.className = "meridian-wave-layer";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "meridian-wave-svg");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("viewBox", "0 0 100 100");
    const defs = document.createElementNS(SVGNS, "defs");
    const grad = document.createElementNS(SVGNS, "linearGradient");
    grad.setAttribute("id", "meridianWaveGrad");
    grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
    grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
    // Non-linear: opaque only near the crest (top), falling off fast so the body stays faint —
    // taller peaks read as brighter, low activity stays subtle. Color is the user's wave color.
    const wc = waveColor();
    for (const [off, op] of [[0, 1], [18, 0.72], [45, 0.42], [100, 0.16]]) {
      const st = document.createElementNS(SVGNS, "stop");
      st.setAttribute("offset", off + "%");
      st.setAttribute("stop-color", wc);
      st.setAttribute("stop-opacity", String(op));
      grad.appendChild(st);
    }
    defs.appendChild(grad);
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("class", "meridian-wave-path");
    path.setAttribute("fill", "url(#meridianWaveGrad)");
    // Crisp white outline tracing only the top crest of the wave (separate stroked path).
    const topline = document.createElementNS(SVGNS, "path");
    topline.setAttribute("class", "meridian-wave-topline");
    topline.setAttribute("fill", "none");
    topline.setAttribute("stroke", wc);
    svg.append(defs, path, topline);
    const emotes = document.createElement("div");
    emotes.className = "meridian-wave-emotes";
    waveLayer.append(svg, emotes);
    bar.appendChild(waveLayer);
    return waveLayer;
  }

  // The seekbar's span in seconds = aria-valuemax − aria-valuemin (the DVR window the bar shows).
  // On sites without a real DVR seekbar the adapter supplies a fixed window (Kick: last 5 min).
  function waveWindow(s) {
    if (SITE.waveSpanSec) return SITE.waveSpanSec;
    return Math.max(10, s.end - s.start);
  }
  // Stream-time window for the wave. Density is keyed by the seekbar's stream-time (same as emote
  // markers). Activity recorded at live edge `st` reacted to video moment `st − offset`, so querying
  // [s.start+off, s.end+off] and plotting each bucket at `(t − off)` exactly fills the visible bar
  // [s.start, s.end] — sliding the whole wave left by the reaction offset, in lockstep with the
  // emote markers (which subtract the same offset). One coordinate space → no drift between layers.
  function streamWindow(s) {
    const off = highlightOffset();
    return { start: s.start + off, end: s.end + off, span: Math.max(10, s.end - s.start), off };
  }

  function recomputeResIfDue(now, s) {
    if (lastResAt && now - lastResAt < 30000) return; // every 30 s — fine, gradual resolution steps
    lastResAt = now;
    densityRes = density.resolutionFor(waveWindow(s));
  }
  function recomputePeakIfDue(now, s) {
    if (lastPeakAt && now - lastPeakAt < 20000) return; // every 20 s
    lastPeakAt = now;
    const w = streamWindow(s);
    let mx = 0;
    for (const p of density.series(w.start, w.end, densityRes)) if (p.v > mx) mx = p.v;
    densityPeak = mx || 1;
  }

  function renderWave() {
    const s = videoSeekable();
    if (!waveLayer || !s) return;
    const w = streamWindow(s);
    const series = density.series(w.start, w.end, densityRes);
    lastSeries = series; lastSpan = w.span; lastStart = s.start; lastOff = w.off;
    const path = waveLayer.querySelector(".meridian-wave-path");
    const topline = waveLayer.querySelector(".meridian-wave-topline");
    const svg = waveLayer.querySelector("svg");
    const n = series.length;
    if (n < 2) { path.setAttribute("d", ""); if (topline) topline.setAttribute("d", ""); return; }
    const H = 100;
    const peak = densityPeak || 1;
    const pts = series.map((p, i) => ({ x: i, y: H - Math.min(1, p.v / peak) * (H - 4) }));
    svg.setAttribute("viewBox", `0 0 ${n - 1} ${H}`);
    // Quadratic-smoothed crest commands, shared by the filled area and the white top outline.
    let curve = "";
    for (let i = 1; i < n; i++) {
      const xc = (pts[i - 1].x + pts[i].x) / 2, yc = (pts[i - 1].y + pts[i].y) / 2;
      curve += ` Q ${pts[i - 1].x} ${pts[i - 1].y.toFixed(2)} ${xc} ${yc.toFixed(2)}`;
    }
    curve += ` L ${n - 1} ${pts[n - 1].y.toFixed(2)}`;
    const start = `0 ${pts[0].y.toFixed(2)}`;
    // Filled area: down the left edge, across the crest, down the right edge, close along baseline.
    path.setAttribute("d", `M 0 ${H} L ${start}${curve} L ${n - 1} ${H} Z`);
    // White outline: just the crest curve, no fill.
    if (topline) topline.setAttribute("d", `M ${start}${curve}`);
  }

  // Normalized wave height (0..1) at a horizontal fraction — used to perch emotes on top.
  function waveHeightAtFrac(frac) {
    if (!lastSeries || lastSeries.length < 2 || lastSpan <= 0) return 0.4;
    const step = Math.max(density.baseRes, densityRes);
    const st = lastStart + frac * lastSpan + lastOff; // stream-time bucket at this plotted fraction
    const idx = Math.round((st - lastSeries[0].t) / step);
    const p = lastSeries[Math.max(0, Math.min(lastSeries.length - 1, idx))];
    return Math.min(1, (p?.v || 0) / (densityPeak || 1));
  }

  // Geometry of the lane-stacked emote markers, mirrored in overlay.css (.meridian-wave-layer
  // is WAVE_GEO.layer tall; the wave SVG occupies the bottom WAVE_GEO.band px). Emote markers
  // never move horizontally (that would lie about the timestamp) — when two surges are too close
  // they bump UP a lane, and a stem + dot ties each one to its exact moment on the wave crest.
  // lane = bubble-center px from the layer bottom. Two lanes, generously spaced (well > bubble) so
  // stacked markers read as clearly separate and the timeline stays uncluttered. The stats tooltip
  // is mounted on the player and positions itself.
  const WAVE_GEO = { layer: 86, band: 30, bubble: 16, lanes: [40, 70] };

  // Format a stream-time offset (seconds from stream start) as h:mm:ss / m:ss.
  function fmtStreamTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  // --- Surge hover tooltip ---------------------------------------------------------------------
  // A single shared tooltip mounted on the PLAYER (not nested in the seekbar) so it escapes
  // YouTube's chrome stacking context and always sits in front of — and directly above — YouTube's
  // own scrub-preview thumbnail, matched to that preview's width. Shown on emote hover.
  let surgeTip = null, surgeTipLead = null;
  function ensureSurgeTip() {
    const player = SITE.findPlayer?.();
    if (!player) return null;
    if (surgeTip && surgeTip.parentElement === player) return surgeTip;
    if (surgeTip) surgeTip.remove();
    surgeTip = document.createElement("div");
    surgeTip.className = "meridian-surge-tip";
    player.appendChild(surgeTip);
    return surgeTip;
  }
  // YouTube's currently-visible scrubber tooltip (storyboard frame + timestamp), if any.
  function ytPreviewEl() {
    const player = SITE.findPlayer?.();
    if (!player) return null;
    for (const el of player.querySelectorAll(".ytp-tooltip")) {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return el;
    }
    return null;
  }
  function buildSurgeTipContent(lead, frac, secondary) {
    // msgs/min reads bigger (and more intuitively "intense") than msgs/sec — peak density is a
    // per-second rate, so ×60.
    const rate = Math.round(waveHeightAtFrac(frac) * (densityPeak || 1) * 60);
    const time = fmtStreamTime(highlightVt(lead));
    const tip = surgeTip;
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "meridian-surge-tip-head";
    const thumb = document.createElement("img");
    thumb.src = lead.url; thumb.alt = "";
    const ht = document.createElement("div");
    ht.className = "meridian-surge-tip-htxt";
    const nm = document.createElement("div"); nm.className = "meridian-surge-tip-name";
    nm.textContent = lead.name;
    const tm = document.createElement("div"); tm.className = "meridian-surge-tip-time"; tm.textContent = time;
    ht.append(nm, tm);
    head.append(thumb, ht);
    tip.append(head);
    // Secondary emotes in this group → a stacked-card pill of the top 3, with "+N" beyond that.
    if (secondary && secondary.length) {
      const pill = document.createElement("div");
      pill.className = "meridian-surge-tip-cluster";
      const stack = document.createElement("span");
      stack.className = "meridian-surge-tip-stack";
      for (const rec of secondary.slice(0, 3)) {
        const im = document.createElement("img");
        im.src = rec.url; im.alt = rec.name; im.loading = "lazy";
        stack.appendChild(im);
      }
      pill.appendChild(stack);
      const extra = secondary.length - 3;
      if (extra > 0) {
        const more = document.createElement("span");
        more.className = "meridian-surge-tip-more";
        more.textContent = "+" + extra;
        pill.appendChild(more);
      }
      tip.appendChild(pill);
    }
    const stats = document.createElement("div");
    stats.className = "meridian-surge-tip-stats";
    stats.innerHTML = `<div class="meridian-surge-tip-rate">${rate}<span>msg/min</span></div>` +
      `<div class="meridian-surge-tip-uniq"><b>${lead.count || 0}</b> spamming</div>`;
    tip.append(stats);
  }
  // Position the shared tooltip directly above YouTube's preview, matched to its width; if the
  // preview isn't up, fall back to floating above the seekbar at the marker's x.
  function positionSurgeTip(frac) {
    const tip = surgeTip, player = SITE.findPlayer?.();
    if (!tip || !player) return;
    const pr = player.getBoundingClientRect();
    const prev = ytPreviewEl();
    let leftPx, bottomPx, widthPx;
    if (prev) {
      const r = prev.getBoundingClientRect();
      widthPx = r.width;
      leftPx = r.left - pr.left + r.width / 2;
      bottomPx = pr.bottom - r.top + 8;            // perch just above the preview
    } else {
      const sb = SITE.findSeekbar?.();
      const sr = sb && sb.getBoundingClientRect();
      widthPx = 168;
      leftPx = sr ? (sr.left - pr.left + frac * sr.width) : pr.width * frac;
      bottomPx = (sr ? pr.bottom - sr.top : 0) + 100;
    }
    // Keep the tooltip within the player horizontally.
    const half = widthPx / 2;
    leftPx = Math.max(half + 4, Math.min(pr.width - half - 4, leftPx));
    tip.style.width = widthPx + "px";
    tip.style.left = leftPx + "px";
    tip.style.bottom = bottomPx + "px";
  }
  // Auto-hide the tooltip after a few idle seconds, mirroring YouTube hiding its scrub preview when
  // the cursor stops moving — otherwise a stationary hover leaves our tip floating indefinitely.
  let surgeTipIdle = null;
  function armSurgeTipIdle() {
    if (surgeTipIdle) clearTimeout(surgeTipIdle);
    surgeTipIdle = setTimeout(hideSurgeTip, 2500);
  }
  function showSurgeTip(lead, frac, secondary) {
    if (!ensureSurgeTip()) return;
    surgeTipLead = { lead, frac, secondary };
    buildSurgeTipContent(lead, frac, secondary);
    positionSurgeTip(frac);
    surgeTip.style.display = "block";
    armSurgeTipIdle();
  }
  function hideSurgeTip() {
    if (surgeTipIdle) { clearTimeout(surgeTipIdle); surgeTipIdle = null; }
    surgeTipLead = null;
    if (surgeTip) surgeTip.style.display = "none";
  }

  function renderEmotes() {
    if (!waveLayer) return;
    const box = waveLayer.querySelector(".meridian-wave-emotes");
    const s = videoSeekable();
    if (!emoteHighlightsActive() || !s) { box.replaceChildren(); return; }
    const recs = [];
    for (const rec of highlights.values()) {
      const frac = highlightFrac(rec, s);
      if (frac != null && frac >= 0 && frac <= 1) recs.push({ rec, frac });
    }
    const barW = SITE.findSeekbar?.()?.offsetWidth || 600;

    // One emote's footprint as a fraction of the bar. Markers are CENTERED and wide emotes render
    // up to 40px across (the `.meridian-wave-emote img` max-width), so a footprint based on the
    // square bubble (16px) let wide neighbours sit almost edge-to-edge. Use the max rendered width
    // plus breathing room so even the widest neighbours keep a clear gap; closer surges collapse
    // into a "+N". Resolution-independent (a 10 min and a 6 h stream group the same way).
    const MAX_EMOTE_W = 40;             // matches .meridian-wave-emote img max-width
    const EMOTE_W = MAX_EMOTE_W + 1;    // + tiny gap between adjacent markers
    const FP = EMOTE_W / barW;

    // Cluster surges into non-overlapping markers, each anchored on its STRONGEST surge.
    // Greedy by unique-viewer count (ties → earlier / left-most): walk surges strongest-first;
    // each one either starts a new marker, or — if it falls within one footprint (FP) of an
    // already-placed marker — is absorbed into the nearest such marker as a secondary. Because a
    // surge only ever claims its own FP, markers are guaranteed pairwise ≥ FP apart (no overlap)
    // while still sitting on the peak surge of their neighborhood. This avoids both failure modes:
    // anchoring at the leftmost item (marker drifts off the real peak) and single-linkage chaining
    // (a ramp of ever-stronger surges snowballing into one giant cluster — a new marker still only
    // claims its own FP, so dense regions get one marker per FP, not one marker total).
    const byStrength = recs.slice().sort((a, b) =>
      (b.rec.count || 0) - (a.rec.count || 0) || a.frac - b.frac);
    const markers = [];
    for (const item of byStrength) {
      let best = null, bestDist = Infinity;
      for (const m of markers) {
        const dist = Math.abs(item.frac - m.frac);
        if (dist < FP && dist < bestDist) { bestDist = dist; best = m; }
      }
      if (best) best.members.push(item);
      else markers.push({ lead: item.rec, frac: item.frac, members: [] });
    }

    // Finalize each marker: the "+N" badge / tooltip lists the OTHER distinct emote names absorbed
    // here (a repeat surge of the leader's own emote collapses into the leader, not the count).
    for (const m of markers) {
      const byName = new Map();
      for (const it of m.members) {
        if (it.rec.name === m.lead.name) continue;
        const ex = byName.get(it.rec.name);
        if (!ex || (it.rec.count || 0) > (ex.count || 0)) byName.set(it.rec.name, it.rec);
      }
      m.secondary = [...byName.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
      m.others = m.secondary.length;
    }

    markers.sort((a, b) => a.frac - b.frac);

    const accent = waveColor();
    const frag = document.createDocumentFragment();
    for (const m of markers) {
      const lead = m.lead, frac = m.frac, laneY = WAVE_GEO.lanes[0];
      const leftPct = (frac * 100) + "%";
      const crestPx = Math.max(2, waveHeightAtFrac(frac) * WAVE_GEO.band);

      // Stem + dot tie this marker to its exact moment on the wave crest.
      const stem = document.createElement("div");
      stem.className = "meridian-wave-stem";
      stem.style.left = leftPct;
      stem.style.bottom = crestPx + "px";
      stem.style.height = Math.max(0, (laneY - WAVE_GEO.bubble / 2) - crestPx) + "px";
      stem.style.background = `linear-gradient(${accent}, transparent)`;
      const dot = document.createElement("div");
      dot.className = "meridian-wave-dot";
      dot.style.left = leftPct;
      dot.style.bottom = crestPx + "px";
      dot.style.background = accent;
      frag.append(stem, dot);

      const el = document.createElement("div");
      el.className = "meridian-wave-emote";
      el.style.left = leftPct;
      el.style.bottom = laneY + "px";
      const img = document.createElement("img");
      img.src = lead.url; img.alt = lead.name; img.loading = "lazy";
      el.appendChild(img);
      if (m.others > 0) {
        const badge = document.createElement("span");
        badge.className = "meridian-wave-badge";
        badge.textContent = "+" + m.others;
        el.appendChild(badge);
      }
      el.addEventListener("mouseenter", () => showSurgeTip(lead, frac, m.secondary));
      el.addEventListener("mousemove", () => { if (surgeTipLead) { positionSurgeTip(frac); armSurgeTipIdle(); } });
      el.addEventListener("mouseleave", hideSurgeTip);
      if (SITE.canSeek === false) {
        el.style.cursor = "default";
      } else {
        el.addEventListener("click", (e) => {
          e.stopPropagation(); e.preventDefault();
          seekTo(highlightVt(lead));
        });
        el.addEventListener("mousedown", (e) => e.stopPropagation());
      }
      frag.appendChild(el);
    }
    box.replaceChildren(frag);
  }

  // --- persistence (emote highlights only; the density wave is live/session-derived) ---
  function hlStorageKey() {
    const vid = SITE.videoId?.() || lastJoined || HOST;
    return `meridian.highlights.${HOST}.${vid}`;
  }
  function scheduleSaveHighlights() {
    if (saveHlTimer) return;
    saveHlTimer = setTimeout(saveHighlights, 1500);
  }
  async function saveHighlights() {
    saveHlTimer = null;
    if (!highlightsKey || !prefs.highlightPersistEmotes) return;
    const arr = [...highlights.values()]
      .map(({ key, name, url, count, threshold, wallTs, vt, behindLive }) => ({ key, name, url, count, threshold, wallTs, vt, behindLive }))
      .slice(-HIGHLIGHT_CAP);
    try { await chrome.storage.local.set({ [highlightsKey]: arr }); } catch {}
  }
  // Density wave persistence (replay the intensity timeline on the VOD). Keyed off the same videoId.
  function densityStorageKey() {
    const vid = SITE.videoId?.() || lastJoined || HOST;
    return `meridian.density.${HOST}.${vid}`;
  }
  function scheduleSaveDensity() {
    if (saveDensityTimer || !prefs.highlightPersistDensity) return;
    saveDensityTimer = setTimeout(saveDensity, 4000);
  }
  async function saveDensity() {
    saveDensityTimer = null;
    if (!densityKey || !prefs.highlightPersistDensity || !density.size) return;
    try { await chrome.storage.local.set({ [densityKey]: density.serialize() }); } catch {}
  }
  async function loadHighlights() {
    const key = hlStorageKey();
    if (key === highlightsKey) return;
    highlightsKey = key;
    densityKey = densityStorageKey();
    highlights.clear();
    hlEngine.reset();
    // New stream/video — drop the previous stream's density wave so nothing carries over
    // (a channel can run several livestreams; each has a distinct videoId/key).
    density.reset();
    replayLoaded = false;
    const live = isLiveStream();
    // Bail only when the wave is entirely off (timeline pref or unsupported site). On a VOD we must
    // still read storage to discover whether there's an archived timeline to replay.
    if (!(SITE.hasTimeline && prefs.highlightTimeline)) return;
    try {
      const wantEmotes = prefs.highlightPersistEmotes, wantDensity = prefs.highlightPersistDensity;
      const o = await chrome.storage.local.get([
        ...(wantEmotes ? [key] : []),
        ...(wantDensity ? [densityKey] : []),
      ]);
      if (wantEmotes) for (const rec of o[key] || []) highlights.set(rec.key, rec);
      if (wantDensity && o[densityKey]) { density.restore(o[densityKey]); lastResAt = 0; lastPeakAt = 0; }
    } catch {}
    // On a finished VOD, flip on replay if anything was restored, so waveActive() turns true and the
    // 2 s loop starts drawing the archived wave/markers.
    if (!live) replayLoaded = (density.size > 0 || highlights.size > 0);
    renderEmotes();
  }

  // Called when the highlight prefs change (toggle on/off).
  function refreshHighlightState() {
    highlightsKey = ""; densityKey = ""; lastResAt = 0; lastPeakAt = 0;
    if (SITE.hasTimeline && prefs.highlightTimeline) {
      loadHighlights();
    } else {
      // Wave turned off entirely — tear down immediately.
      replayLoaded = false;
      if (waveLayer) waveLayer.style.display = "none";
      highlights.clear(); hlEngine.reset(); density.reset();
    }
  }

  // Render loop: rebuild the wave + reposition emotes as the live DVR window slides; re-home
  // the layer if the player rebuilt its progress bar; reload persisted emotes on video change.
  // Mark the player while our wave is on its seekbar, so CSS can lift YouTube's fullscreen
  // channel-logo / like-dislike overlays clear of the wave + emotes.
  function markWaveOnPlayer(show) { SITE.findPlayer?.()?.classList.toggle("meridian-has-wave", !!show); }
  setInterval(() => {
    // `densityArmed` gates the per-message RECORDING hot path (live only); the wave can still be
    // DISPLAYED in replay on a finished VOD.
    densityArmed = recordingActive();
    // Pick up video changes even while the wave is currently off — this is what lets a finished
    // livestream's VOD flip into replay (loadHighlights reads storage and sets `replayLoaded`).
    if (SITE.hasTimeline && prefs.highlightTimeline && hlStorageKey() !== highlightsKey) loadHighlights();
    // Stream ended while watching (live → VOD, same videoId): keep showing what we already recorded.
    if (!isLiveStream() && !replayLoaded && (density.size > 0 || highlights.size > 0)) replayLoaded = true;
    if (!waveActive()) { if (waveLayer) waveLayer.style.display = "none"; markWaveOnPlayer(false); return; }
    const s = videoSeekable();
    if (!s) { markWaveOnPlayer(false); return; }
    atLiveCached = atLiveEdge(s); // gates the per-message recording hot path
    liveEdgeVt = s.end; liveEdgeAt = Date.now(); // sample the seekbar live edge for the hot path
    const now = Date.now();
    // Keep density bounded. While recording with persistence on we keep (almost) the whole stream
    // so it can be replayed on the VOD; otherwise just the renderable window.
    if (densityArmed) {
      const keepSec = prefs.highlightPersistDensity ? 12 * 3600 : Math.max(waveWindow(s), 600) + highlightOffset();
      density.pruneBefore(s.end - keepSec);
      scheduleSaveDensity();
    }
    recomputeResIfDue(now, s);
    recomputePeakIfDue(now, s);
    // No seekbar right now (e.g. Kick controls hidden) → render nothing, so the wave + emotes
    // hide along with the timeline instead of floating over the video.
    const layer = ensureWaveLayer();
    if (!layer) { markWaveOnPlayer(false); return; }
    layer.style.display = "";
    markWaveOnPlayer(true);
    renderWave();
    renderEmotes();
  }, 2000);
  setInterval(() => hlEngine.prune(Date.now()), 15000);
  loadHighlights();

  // --- rendering ---
  // Twitch lets users pick any name color, including near-black ones that vanish on our dark
  // background. Raise only the HSL *lightness* floor — hue/saturation are preserved, so vivid
  // colors (blue, red, …) stay vivid and only genuinely dark names get lifted (black → grey).
  // Memoized: there are only ~16M possible colors but realistically a few hundred per channel,
  // so we compute each hex once instead of per message.
  const colorCache = new Map();
  function readableColor(hex) {
    if (!hex) return hex;
    let out = colorCache.get(hex);
    if (out !== undefined) return out;
    out = computeReadableColor(hex);
    if (colorCache.size > 4000) colorCache.clear(); // bound memory on pathological inputs
    colorCache.set(hex, out);
    return out;
  }
  function computeReadableColor(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
    if (!m) return hex;
    const r = parseInt(m[1].slice(0, 2), 16) / 255;
    const g = parseInt(m[1].slice(2, 4), 16) / 255;
    const b = parseInt(m[1].slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let l = (max + min) / 2;
    const MIN_L = 0.5;
    if (l >= MIN_L) return hex;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    l = MIN_L;
    const hue = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const to = (x) => Math.round(hue(p, q, x) * 255);
    return `rgb(${to(h + 1 / 3)}, ${to(h)}, ${to(h - 1 / 3)})`;
  }
  function renderMessage(m) {
    const el = document.createElement("div");
    el.className = "meridian-msg" + (m.type === "notice" ? " notice" : "") + (m.self ? " self" : "") + (m.action ? " action" : "");
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
      if (m.color && !m.self) name.style.color = readableColor(m.color);
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
    root.classList.toggle("no-outline", prefs.outlineEnabled === false);
    root.classList.toggle("text-shadow", prefs.textStyle === "shadow");
    root.classList.toggle("text-outline", prefs.textStyle === "outline");
    root.classList.toggle("text-bold", prefs.boldText === true);
  }
  function currentRect() {
    return { top: root.offsetTop, left: root.offsetLeft, width: root.offsetWidth, height: root.offsetHeight };
  }
  function showOverlay() { root.classList.remove("meridian-hidden"); applyBubbleVisibility(); }
  function hideOverlay() { root.classList.add("meridian-hidden"); applyBubbleVisibility(); }
  function applyBubbleVisibility() {
    // Bubble always shows (on an active has-video page) while the overlay is hidden, so the user
    // can bring chat back. The chat is the only way back, so it's never itself hidden.
    const show = pageActive && root.classList.contains("meridian-hidden");
    toggleBtn.classList.toggle("show", show);
  }

  // --- display mode (overlay / docked / hidden), per site ---
  // (lastVisibleMode / dockRetryTimer declared earlier to avoid a TDZ at setup.)
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  // The user's chosen *visible* mode for this site (auto/overlay/docked) — never "hidden".
  // Hiding is a transient flag (toggled by the bubble / × / hotkey), kept separate so the popup
  // dropdown always reflects the state the extension returns to when un-hidden.
  function siteMode() {
    const m = prefs.sites?.[HOST]?.mode;
    return (m === "overlay" || m === "docked" || m === "auto") ? m : "auto";
  }
  function siteHidden() { return prefs.sites?.[HOST]?.hidden === true; }
  // Concrete display mode after resolving the hidden flag + "auto".
  function effectiveMode() {
    if (siteHidden()) return "hidden";
    const m = siteMode();
    if (m !== "auto") return m;
    // Auto: floating overlay in fullscreen; docked otherwise — but only when the page actually
    // exposes a chat frame to dock into (VODs without live chat have none), else fall back to
    // overlay so chat is never left invisible.
    if (isFullscreen()) return "overlay";
    return SITE.findDockAnchor?.() ? "docked" : "overlay";
  }
  async function setSiteMode(mode) {
    const sites = { ...(prefs.sites || {}) };
    const entry = { ...(sites[HOST] || {}) };
    if (mode === "hidden") {
      entry.hidden = true; // keep the chosen visible mode so the bubble restores to it
    } else {
      entry.mode = mode;
      entry.hidden = false;
    }
    sites[HOST] = entry;
    prefs.sites = sites;
    prefs.hidden = entry.hidden === true; // keep legacy flag coherent
    await savePrefs();
    applyMode();
  }
  // Visual half — safe to run during setup (touches only DOM/classes, no irc/queue).
  function applyModeVisual() {
    // On a page with no video (home/search feed), keep everything torn down + invisible.
    if (!pageActive) { undock(); hideOverlay(); updateModeButton(); appliedMode = "inactive"; return; }
    const mode = effectiveMode();
    if (mode !== "hidden") lastVisibleMode = siteMode();
    appliedMode = mode;
    if (mode === "hidden") { undock(); hideOverlay(); updateModeButton(); return; }
    root.classList.remove("meridian-hidden");
    if (mode === "docked") dock(); else undock();
    applyBubbleVisibility();
    updateModeButton();
  }
  // Full apply (visual + connection) — used at runtime after everything is initialized.
  function applyMode() {
    applyModeVisual();
    if (!pageActive || effectiveMode() === "hidden") disconnectIRC();
    else if (!irc) ensureConnected();
  }
  // Mount/connect only when the page actually has a video; tear down when it doesn't (SPA nav).
  function syncPageActive() {
    const active = SITE.hasVideo?.() ?? true;
    if (active === pageActive) return;
    pageActive = active;
    applyMode();
  }
  function updateModeButton() {
    const docked = effectiveMode() === "docked";
    els.modeBtn.title = docked ? "Switch to overlay" : "Dock into the page";
    els.modeBtn.classList.toggle("active", docked);
  }
  // Docked mode overlays our chat *inside* the site's native chat frame (YouTube
  // `ytd-live-chat-frame#chat`, Kick `#channel-chatroom`) as an absolute panel, with a
  // [Site | Twitch] tab bar pinned over the top. Because everything is absolutely positioned
  // it consumes NO layout — so it can't push the page's chat send-button off-screen in
  // fullscreen, and it works in theater mode where the chat column collapses to width:0. On
  // the Twitch tab our opaque panel covers the native chat; on the native tab we hide our
  // panel and the site's chat shows through (the tab bar still floats over its top ~34px).
  function buildDockTabs() {
    const bar = document.createElement("div");
    bar.className = "meridian-dock-tabs";
    // Source-badge tabs: a colored dot per source (the site's brand color + Twitch violet) with an
    // accent underline on the active one, so it reads as "which chat am I looking at".
    const mkTab = (tab, label, color) => {
      const b = document.createElement("button");
      b.className = "meridian-dock-tab";
      b.dataset.tab = tab;
      b.style.setProperty("--tab-color", color);
      const dot = document.createElement("span");
      dot.className = "meridian-dock-tab-dot";
      const txt = document.createElement("span");
      txt.textContent = label;
      b.append(dot, txt);
      return b;
    };
    const native = mkTab("native", SITE.nativeChatLabel || "Site", SITE.brandColor || "#FF0033");
    const twitch = mkTab("twitch", "Twitch", "#9146FF");
    bar.append(native, twitch);
    bar.addEventListener("click", (e) => {
      const b = e.target.closest(".meridian-dock-tab");
      if (!b) return;
      dockChatTab = b.dataset.tab;
      applyDockTab();
    });
    return bar;
  }
  function applyDockTab() {
    if (!dockTabBar) return;
    const showTwitch = dockChatTab === "twitch";
    root.style.display = showTwitch ? "" : "none"; // opaque panel covers the native chat
    dockTabBar.querySelectorAll(".meridian-dock-tab").forEach((b) =>
      b.classList.toggle("active", (b.dataset.tab === "twitch") === showTwitch));
  }
  function dock() {
    const anchor = SITE.findDockAnchor?.();
    root.classList.add("meridian-docked");
    if (playerResizeObs) { playerResizeObs.disconnect(); playerResizeObs = null; }
    // Clear inline geometry/transform so the docked CSS controls layout (preserve --vars).
    ["position", "top", "left", "right", "width", "height", "transform"].forEach((p) => root.style.removeProperty(p));
    if (!anchor) {
      // No chat frame yet — keep the panel hidden so its absolute (viewport-relative) box doesn't
      // cover the whole screen while we wait, then retry.
      root.style.display = "none";
      if (!dockRetryTimer) dockRetryTimer = setTimeout(() => { dockRetryTimer = null; if (effectiveMode() === "docked") dock(); }, 800);
      return;
    }
    // Our absolute children anchor to the frame — give it a positioning context if it lacks one
    // (in theater the frame is already position:fixed, so leave that alone).
    if (anchor !== dockAnchor && getComputedStyle(anchor).position === "static") {
      anchor.style.position = "relative";
      dockAnchorPosSet = true;
    }
    dockAnchor = anchor;
    anchor.classList.add("meridian-dock-anchor");
    // Mount root + tab bar into the anchor FIRST, before any sizing — sizeDockAnchor() dispatches a
    // resize that can re-enter the layout, so if it ran before the mount a hiccup there would leave
    // root parented to the player with the docked class (= covering the whole player). Mount first.
    if (!dockTabBar || !anchor.contains(dockTabBar)) {
      dockTabBar = buildDockTabs();
      anchor.appendChild(dockTabBar);
    }
    if (root.parentElement !== anchor) anchor.appendChild(root);
    applyDockTab();
    observeDockLayout(anchor); // react instantly to theater / hide-chat toggles
    sizeDockAnchor(); // keep our panel full-height / reserve the theater strip
    if (dockRetryTimer) { clearTimeout(dockRetryTimer); dockRetryTimer = null; }
  }
  // Keep our docked panel laid out independently of the site's native chat — the user can hide
  // YouTube chat and ours stays put. Our panel is absolutely positioned (inset:0) inside the chat
  // frame, so when YouTube hides chat (display:none via [collapsed]/[hide-chat-frame]) our panel
  // would collapse with it. We do NOT re-open native chat (that made YouTube chat "re-enable
  // itself"); instead CSS overrides the display:none on `.meridian-dock-anchor`, and here we keep
  // the frame sized in each layout:
  //   • Normal layout — pin the frame's min-height to the player height (it stays in the column).
  //   • Theater with native chat hidden — YouTube would make the video FULL-BLEED (full width) and
  //     drop the chat column, which left our chat with nowhere to sit. We reserve the right strip
  //     ourselves: pad the player container by the chat width + nudge a resize so YouTube's player
  //     recomputes and shrinks the *video* to the left, then pin our frame into the reserved strip.
  //     This restores the normal theater layout (video left, our chat right) without touching
  //     native chat's hidden state. (Verified live: video shrinks 1185→798, chat sits flush beside.)
  // (THEATER_CHAT_W is declared near the top — it's used by dock() which can run during setup.)
  // Nudge the player to recompute the video size after we change the reserved width. Deferred so it
  // never fires inside dock()/sizeDockAnchor()'s call stack (a synchronous re-layout there could
  // re-home our panel mid-mount).
  function nudgePlayerResize() { setTimeout(() => window.dispatchEvent(new Event("resize")), 0); }
  // Watch the layout signals that flip our docked sizing (theater on/off, native chat hide/show)
  // so we re-run sizeDockAnchor the instant they change instead of waiting for the 2 s poll. Safe
  // from feedback loops: we only toggle inline position/padding, never these attributes.
  function observeDockLayout(anchor) {
    if (dockLayoutObs) dockLayoutObs.disconnect();
    dockLayoutObs = new MutationObserver(() => { if (root.classList.contains("meridian-docked")) scheduleSizeDock(); });
    const wf = document.querySelector("ytd-watch-flexy");
    if (wf) dockLayoutObs.observe(wf, { attributes: true, attributeFilter: ["theater", "full-bleed-player", "fullscreen"] });
    dockLayoutObs.observe(anchor, { attributes: true, attributeFilter: ["collapsed", "hide-chat-frame"] });
  }
  // Trailing-debounced sizing. On load YouTube flaps the theater / collapsed attributes for a few
  // seconds before settling; reacting to every flap re-ran the theater reservation (padding +
  // position:fixed + a player resize nudge) on and off, which forced YouTube to relayout the
  // player+chat wrapper repeatedly → the thin line flickering at its top for ~10 s. Debouncing
  // coalesces the burst so we only size against the SETTLED state (and never react to a transient
  // "collapsed" while the chat frame is still loading).
  function scheduleSizeDock() {
    if (sizeDebTimer) clearTimeout(sizeDebTimer);
    sizeDebTimer = setTimeout(() => { sizeDebTimer = null; sizeDockAnchor(); }, 200);
  }
  // While the theater-with-chat-hidden chat is pinned position:fixed, the YouTube player scrolls
  // with the page but our fixed panel doesn't — so it drifts until the 2 s poll re-pins it. Re-pin
  // on scroll (rAF-throttled) so it tracks the player immediately.
  function repinTheaterChat() {
    const a = dockAnchor;
    if (!a || !dockForcedFixed) return;
    const fb = document.querySelector("#full-bleed-container");
    if (!fb) return;
    const fr = fb.getBoundingClientRect();
    a.style.top = fr.top + "px";
    a.style.left = (fr.left + fr.width - THEATER_CHAT_W) + "px";
    a.style.height = fr.height + "px";
  }
  function theaterFullBleedContainer() {
    const wf = document.querySelector("ytd-watch-flexy");
    if (!wf || !wf.hasAttribute("theater") || isFullscreen()) return null;
    if (!wf.hasAttribute("full-bleed-player")) return null; // chat already reserving the column
    return document.querySelector("#full-bleed-container");
  }
  function clearTheaterReservation() {
    const fb = document.querySelector("#full-bleed-container");
    if (fb && fb.style.paddingRight) {
      fb.style.removeProperty("padding-right");
      fb.style.removeProperty("box-sizing");
      nudgePlayerResize();
    }
  }
  function sizeDockAnchor() {
    const a = dockAnchor;
    if (!a) return;
    const collapsed = a.hasAttribute("collapsed") || a.hasAttribute("hide-chat-frame");
    const fb = collapsed ? theaterFullBleedContainer() : null;
    if (fb) {
      // Theater + native chat hidden: reserve the right strip + pin our frame into it.
      if (fb.style.paddingRight !== THEATER_CHAT_W + "px") {
        fb.style.boxSizing = "border-box";
        fb.style.paddingRight = THEATER_CHAT_W + "px";
        nudgePlayerResize(); // make YouTube's player recompute the video size
      }
      const fr = fb.getBoundingClientRect();
      a.style.position = "fixed";
      a.style.top = fr.top + "px";
      // Pin the chat's LEFT flush to the (now-shrunk) video's right edge so there's no overlap.
      a.style.left = (fr.left + fr.width - THEATER_CHAT_W) + "px";
      a.style.right = "auto";
      a.style.width = THEATER_CHAT_W + "px";
      a.style.height = fr.height + "px";
      a.style.minHeight = fr.height + "px";
      dockForcedFixed = true;
      return;
    }
    // Any other state → drop the theater reservation + the fixed pin we may have set, then keep the
    // frame sized for the in-column (normal) layout via min-height.
    clearTheaterReservation();
    if (dockForcedFixed) {
      ["position", "top", "right", "left", "width", "height"].forEach((p) => a.style.removeProperty(p));
      if (dockAnchorPosSet) a.style.position = "relative";
      dockForcedFixed = false;
    }
    // Only pin a min-height when native chat is HIDDEN — then the frame would collapse and take our
    // absolutely-positioned panel down with it, so we hold it at the player height. When native chat
    // is VISIBLE (the docked-in-theater case the user saw flicker), YouTube already sizes the frame;
    // re-writing min-height on every 2 s poll while the player height settled on load kept reflowing
    // the rounded container and flickered its top outline for ~10 s. So leave it alone when visible
    // (and clear any pin we'd set), and keep the write idempotent when hidden.
    if (collapsed) {
      const ph = SITE.findPlayer?.()?.offsetHeight || 0;
      if (ph > 0) { const v = ph + "px"; if (a.style.minHeight !== v) a.style.minHeight = v; }
    } else if (a.style.minHeight) {
      a.style.removeProperty("min-height");
    }
  }
  function undock() {
    if (dockRetryTimer) { clearTimeout(dockRetryTimer); dockRetryTimer = null; }
    if (dockLayoutObs) { dockLayoutObs.disconnect(); dockLayoutObs = null; }
    const wasDocked = root.classList.contains("meridian-docked");
    clearTheaterReservation(); // restore the theater player to full width if we'd shrunk it
    if (dockAnchor) {
      dockAnchor.classList.remove("meridian-dock-anchor");
      // Clear every inline prop we may have set (min-height + the theater fixed-pin).
      ["min-height", "position", "top", "right", "left", "width", "height"].forEach((p) => dockAnchor.style.removeProperty(p));
      dockAnchorPosSet = false;
    }
    dockForcedFixed = false;
    if (dockTabBar) { dockTabBar.remove(); dockTabBar = null; }
    dockAnchor = null;
    root.style.display = "";
    if (!wasDocked && root.parentElement === document.documentElement) return;
    root.classList.remove("meridian-docked");
    applyBoundMode(); // re-homes root (player or documentElement) and restores overlay geometry
  }

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
      if (root.classList.contains("meridian-docked")) return; // no dragging while docked
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
      const _bp = prefs.boundToPlayer ? boundHost() : null;
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
      if (root.classList.contains("meridian-docked")) return; // grips are hidden when docked
      e.preventDefault();
      e.stopPropagation();
      root.classList.add("meridian-dragging");
      const w0 = root.offsetWidth;
      const h0 = root.offsetHeight;
      const left0 = root.offsetLeft;
      const top0 = root.offsetTop;
      const sx = e.clientX, sy = e.clientY;
      const minW = 240, minH = 160;
      const _rbp = prefs.boundToPlayer ? boundHost() : null;
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
    return SITE.findPlayer();
  }
  // When something goes fullscreen, only the fullscreen element subtree is painted — so the
  // overlay must live *inside* it or it vanishes (the Kick fullscreen bug). But on YouTube the
  // player itself is the fullscreen element, so keep binding to the player whenever it's within
  // the fullscreen subtree (root is already a child of it → visible, and drag math stays in the
  // same coordinate space). Only re-home into the fullscreen element when the player isn't in it.
  function boundHost() {
    const player = findPlayerElement();
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && !(player && fs.contains(player))) {
      const v = SITE.getVideo?.();
      if (v && (fs === v || fs.contains(v))) return fs;
    }
    return player;
  }

  function applyPlayerBoundRect() {
    const player = boundHost();
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
      const player = boundHost();
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
