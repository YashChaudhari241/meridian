import { DEFAULT_MAPPINGS, DEFAULT_KICK_MAPPINGS } from "./mappings.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const PREFS_KEY = "meridian.prefs";
const UI_KEY = "meridian.ui";

function send(type, extra = {}) { return chrome.runtime.sendMessage({ type, ...extra }); }
// Paint the accent-filled portion of a range slider (driven by CSS var --pct).
function setRangeFill(el) {
  const min = +el.min || 0, max = +el.max || 100;
  const pct = ((+el.value - min) / (max - min)) * 100;
  el.style.setProperty("--pct", pct + "%");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- tabs ----------
async function activateTab(name, persist = true) {
  const valid = new Set(["general", "youtube", "chat", "overlays", "timeline", "appearance", "hotkeys", "reset"]);
  if (!valid.has(name)) name = "general";
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === name));
  if (persist) await chrome.storage.local.set({ [UI_KEY]: { tab: name } });
}
$$(".tab").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));

// ---------- auth (official Twitch OAuth; anonymous read-only by default) ----------
// Lucide check glyph for the connection badge.
const CHECK_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const EYE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.94 10.94 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.94 10.94 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>`;

async function refreshStatus() {
  const s = await send("AUTH_STATUS");
  if (!s?.ok) return;
  const chip = $("#headerStatus");
  if (s.connected) {
    const who = s.displayName || s.login;
    $("#status").innerHTML =
      `<div class="status-line ok"><span class="badge">${CHECK_SVG}</span>` +
      `<span class="txt"><div class="title">Connected as ${escapeHtml(who)}</div>` +
      `<div class="meta">Read-only chat works without connecting.</div></span></div>`;
    chip.className = "ok";
    $("#headerStatusText").textContent = who;
  } else {
    $("#status").innerHTML =
      `<div class="status-line warn"><span class="badge">${EYE_SVG}</span>` +
      `<span class="txt"><div class="title">Anonymous read-only</div>` +
      `<div class="meta">Connect Twitch to send messages.</div></span></div>`;
    chip.className = "warn";
    $("#headerStatusText").textContent = "Anonymous";
  }
  $("#connectTwitch").style.display = s.connected ? "none" : "";
  $("#disconnectTwitch").style.display = s.connected ? "" : "none";
  // Functional setup helper (not a setting description): how to enable connecting.
  if (!s.clientIdSet) {
    $("#authMsg").textContent = "Add TWITCH_CLIENT_ID in src/config.js to enable connecting.";
    $("#redirectHelp").textContent = `OAuth Redirect URL: ${s.redirectUri}`;
  } else {
    if ($("#authMsg").textContent.startsWith("Add TWITCH_CLIENT_ID")) $("#authMsg").textContent = "";
    $("#redirectHelp").textContent = "";
  }
}
$("#connectTwitch").addEventListener("click", async () => {
  $("#authMsg").textContent = "Opening Twitch…";
  const r = await send("AUTH_CONNECT");
  $("#authMsg").textContent = r?.ok ? "Connected ✓" : (r?.error || "Connect failed");
  refreshStatus();
});
$("#disconnectTwitch").addEventListener("click", async () => {
  await send("AUTH_DISCONNECT");
  $("#authMsg").textContent = "";
  refreshStatus();
});

$("#extensionEnabled").addEventListener("change", async (e) => {
  await setPrefs({ extensionEnabled: e.target.checked });
  // Off ⇄ on mounts/unmounts the content script — reload the active tab to apply.
  if (activeTab?.id) chrome.tabs.reload(activeTab.id);
});

// ---------- prefs load/save ----------
// Default YouTube handle / Kick slug → Twitch channel mappings — shared with content.js (one source).
const defaults = {
  channel: "", mappings: { ...DEFAULT_MAPPINGS }, kickMappings: { ...DEFAULT_KICK_MAPPINGS }, overrideChannel: "",
  chatDelaySec: 0, updateFrequencyMs: 0, autoscroll: true,
  hotkeyToggle: "", hotkeyFocus: "", hotkeyPauseScroll: "",
  opacity: 0.51, fontSize: 13, blurRadius: 0, maxMessages: 300,
  blurEnabled: false, bgEnabled: true, shadowEnabled: false, outlineEnabled: true,
  boundToPlayer: true,
  blockedWords: [], hideDeleted: true,
  hidden: false, extensionEnabled: true,
  sites: {},
  highlightTimeline: true, highlightEnabled: true, highlightThreshold: 5, highlightThresholds: {}, highlightWindowSec: 12, highlightWindows: {}, highlightAnchorLive: true,
  highlightOffsetSec: 5, highlightColor: "#b388ff",
  highlightPersistEmotes: true, highlightPersistDensity: true, showViewers: false,
  emote7tv: true, emoteBttv: true, emoteFfz: true,
  textStyle: "shadow", boldText: true,
  ytLoadOn: "live", hideYoutubeChat: false, disconnectOnHide: false,
  markHighlightedMsgs: true, autoShowHide: false, autoShowWindowSec: 5, autoShowVisibleSec: 8,
  autoShowSurgeFactor: 3, autoShowMinRate: 4,
  floatingReactions: true, floatingReactionPath: 100, floatingReactionDurationMs: 1400
};
// Per-layout overlay/docked defaults — mirror content.js LAYOUT_MODE_DEFAULTS.
const LAYOUT_MODE_DEFAULTS = { default: "docked", theater: "docked", fullscreen: "overlay" };

async function getPrefs() {
  const o = await chrome.storage.local.get(PREFS_KEY);
  return { ...defaults, ...(o[PREFS_KEY] || {}) };
}
async function setPrefs(patch) {
  const cur = await getPrefs();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [PREFS_KEY]: next });
  return next;
}

function mappingsToText(m) {
  return Object.entries(m).map(([yt, tw]) => `@${yt} = ${tw}`).join("\n");
}
function parseMappings(text) {
  const out = {}; const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/^@?([A-Za-z0-9_.\-]+)\s*[=:]\s*#?([A-Za-z0-9_]+)\s*$/);
    if (!m) { errors.push(`line ${i + 1}: "${raw}"`); return; }
    out[m[1].toLowerCase()] = m[2].toLowerCase();
  });
  return { mappings: out, errors };
}

async function loadAllFields() {
  const p = await getPrefs();
  $("#mappings").value = mappingsToText(p.mappings || {});
  $("#kickMappings").value = mappingsToText(p.kickMappings || {});
  $("#delay").value = p.chatDelaySec ?? 0;
  $("#updateFreq").value = p.updateFrequencyMs ?? 0;
  $("#maxMessages").value = p.maxMessages ?? 300;
  const opPct = Math.round((p.opacity ?? 0.51) * 100);
  $("#opacity").value = opPct;
  $("#opacityVal").textContent = `${opPct}%`;
  setRangeFill($("#opacity"));
  $("#fontSize").value = p.fontSize ?? 13;
  $("#blurRadius").value = p.blurRadius ?? 0;
  $("#blurRadiusVal").textContent = `${p.blurRadius ?? 0}px`;
  setRangeFill($("#blurRadius"));
  $("#blurEnabled").checked = p.blurEnabled === true;
  $("#bgEnabled").checked = p.bgEnabled !== false;
  $("#shadowEnabled").checked = p.shadowEnabled === true;
  $("#outlineEnabled").checked = p.outlineEnabled !== false;
  $("#hotkeyToggle").value = p.hotkeyToggle || "";
  $("#hotkeyFocus").value = p.hotkeyFocus || "";
  $("#hotkeyPauseScroll").value = p.hotkeyPauseScroll || "";
  $("#boundToPlayer").checked = p.boundToPlayer !== false;
  $("#ytLoadOn").value = p.ytLoadOn === "all" ? "all" : "live";
  $("#hideDeleted").checked = p.hideDeleted === true;
  $("#disconnectOnHide").checked = p.disconnectOnHide === true;
  $("#markHighlightedMsgs").checked = p.markHighlightedMsgs !== false;
  $("#autoShowHide").checked = p.autoShowHide === true;
  $("#autoShowWindow").value = p.autoShowWindowSec ?? 5;
  $("#autoShowVisible").value = p.autoShowVisibleSec ?? 8;
  $("#autoShowSurgeFactor").value = p.autoShowSurgeFactor ?? 3;
  $("#autoShowMinRate").value = p.autoShowMinRate ?? 4;
  $("#floatingReactions").checked = p.floatingReactions !== false;
  $("#floatingReactionPath").value = p.floatingReactionPath ?? 100;
  $("#floatingReactionDuration").value = p.floatingReactionDurationMs ?? 1400;
  $("#showViewers").checked = p.showViewers === true;
  $("#blockedWords").value = (p.blockedWords || []).join("\n");
  $("#extensionEnabled").checked = p.extensionEnabled !== false;
  $("#highlightTimeline").checked = p.highlightTimeline === true;
  $("#highlightEnabled").checked = p.highlightEnabled === true;
  $("#highlightAnchorLive").checked = p.highlightAnchorLive !== false;
  // Per-channel threshold/window: scope to the channel the ACTIVE TAB is currently on (asked
  // directly via a content-script message — the global `_activeChannel` storage key can be stale
  // when several tabs are open). Fall back to the stored key, then to global.
  let liveChannel = "";
  try {
    if (activeTab?.id) {
      const r = await chrome.tabs.sendMessage(activeTab.id, { type: "GET_ACTIVE_CHANNEL" });
      liveChannel = (r?.channel || "").toLowerCase();
    }
  } catch { /* no content script on this tab (e.g. not YouTube/Kick) */ }
  const activeCh = liveChannel || (p._activeChannel || "").toLowerCase();
  const perCh = activeCh ? p.highlightThresholds?.[activeCh] : undefined;
  if (activeCh) {
    $("#highlightThreshold").value = Math.max(3, (perCh ?? p.highlightThreshold ?? 5));
    $("#thresholdLabel").textContent = `Emote highlight threshold for ${activeCh} (unique viewers)`;
    $("#highlightThresholdHint").textContent = perCh != null
      ? `per-channel · "Save" sets ${activeCh}, "Set global" sets the default (${p.highlightThreshold ?? 5})`
      : `using global default (${p.highlightThreshold ?? 5}) · "Save" sets ${activeCh}, "Set global" sets the default`;
  } else {
    $("#highlightThreshold").value = Math.max(3, p.highlightThreshold ?? 5);
    $("#thresholdLabel").textContent = "Emote highlight threshold (unique viewers)";
    $("#highlightThresholdHint").textContent = "no channel active — editing the global default";
  }
  // Per-channel window: same pattern as the threshold.
  const perWin = activeCh ? p.highlightWindows?.[activeCh] : undefined;
  if (activeCh) {
    $("#highlightWindow").value = Math.max(2, Math.min(120, (perWin ?? p.highlightWindowSec ?? 12)));
    $("#windowLabel").textContent = `Emote highlight window for ${activeCh} (seconds)`;
    $("#highlightWindowHint").textContent = perWin != null
      ? `per-channel · "Save" sets ${activeCh}, "Set global" sets the default (${p.highlightWindowSec ?? 12}s)`
      : `using global default (${p.highlightWindowSec ?? 12}s) · "Save" sets ${activeCh}, "Set global" sets the default`;
  } else {
    $("#highlightWindow").value = Math.max(2, Math.min(120, p.highlightWindowSec ?? 12));
    $("#windowLabel").textContent = "Emote highlight window (seconds)";
    $("#highlightWindowHint").textContent = "no channel active — editing the global default";
  }
  $("#highlightOffset").value = p.highlightOffsetSec ?? 5;
  $("#highlightColor").value = p.highlightColor || "#b388ff";
  $("#highlightColorAppearance").value = p.highlightColor || "#b388ff";
  $("#highlightPersistEmotes").checked = p.highlightPersistEmotes !== false;
  $("#highlightPersistDensity").checked = p.highlightPersistDensity !== false;
  $("#emote7tv").checked = p.emote7tv !== false;
  $("#emoteBttv").checked = p.emoteBttv !== false;
  $("#emoteFfz").checked = p.emoteFfz !== false;
  $("#textStyle").value = p.textStyle || "none";
  $("#boldText").checked = p.boldText === true;
  syncHighlightGating();
}
// Emote highlights can run independently of the chat-activity wave (the markers just render with no
// wave drawn behind them). Each dependent option is gated on whichever layer it actually affects.
function syncHighlightGating() {
  const timelineOn = $("#highlightTimeline").checked;
  const emotesOn = $("#highlightEnabled").checked;
  const gate = (sel, on) => {
    const dep = $(sel);
    dep.disabled = !on;
    dep.closest("label").style.opacity = on ? "" : "0.5";
  };
  gate("#highlightAnchorLive", timelineOn || emotesOn); // shifts both layers into the past
  gate("#highlightPersistDensity", timelineOn);          // wave only
  gate("#highlightPersistEmotes", emotesOn);             // emote markers only
}

// ---------- General ----------
function flash(btn, text = "Saved ✓") {
  const old = btn.textContent; btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}
// ---------- Site settings + per-site display mode ----------
let activeTab = null, activeHost = null, hostSupported = false;
function hostFromUrl(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } }
function isSupportedHost(h) { return /(^|\.)youtube\.com$/.test(h) || /(^|\.)kick\.com$/.test(h); }

async function detectActiveTab() {
  try { [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { activeTab = null; }
  activeHost = activeTab?.url ? hostFromUrl(activeTab.url) : null;
  hostSupported = activeHost ? isSupportedHost(activeHost) : false;
}

// Per-layout overlay/docked map for the active host, migrating a legacy site-wide `.mode`.
function layoutModesValue(p) {
  const e = p.sites?.[activeHost];
  if (e?.layoutModes) return { ...LAYOUT_MODE_DEFAULTS, ...e.layoutModes };
  if (e?.mode === "overlay") return { default: "overlay", theater: "overlay", fullscreen: "overlay" };
  if (e?.mode === "docked") return { default: "docked", theater: "docked", fullscreen: "docked" };
  return { ...LAYOUT_MODE_DEFAULTS };
}
async function writeLayoutMode(layout, mode) {
  const cur = await getPrefs();
  const sites = { ...(cur.sites || {}) };
  const entry = { ...(sites[activeHost] || {}) };
  entry.layoutModes = { ...layoutModesValue(cur), [layout]: mode };
  delete entry.mode;
  sites[activeHost] = entry;
  await setPrefs({ sites });
}
// Per-layout "hide native chat by default", with the legacy global flag as the Default-layout fallback.
function hideNativeValue(p) {
  const hn = p.sites?.[activeHost]?.hideNative || {};
  const legacy = p.hideYoutubeChat === true;
  return {
    default: typeof hn.default === "boolean" ? hn.default : legacy,
    theater: typeof hn.theater === "boolean" ? hn.theater : false,
    fullscreen: typeof hn.fullscreen === "boolean" ? hn.fullscreen : false
  };
}
async function writeHideNative(layout, hide) {
  const cur = await getPrefs();
  const sites = { ...(cur.sites || {}) };
  const entry = { ...(sites[activeHost] || {}) };
  entry.hideNative = { ...hideNativeValue(cur), [layout]: hide };
  sites[activeHost] = entry;
  await setPrefs({ sites });
}
function setNativeChatPill(group, hide) {
  group.querySelector('[data-val="show"]').classList.toggle("active", !hide);
  group.querySelector('[data-val="hide"]').classList.toggle("active", !!hide);
}
function syncNativeChatPills(p) {
  const hn = hideNativeValue(p);
  document.querySelectorAll(".split-pill[data-layout]").forEach((g) => {
    setNativeChatPill(g, hn[g.dataset.layout]);
  });
}

async function initSiteCard() {
  const card = $("#siteCard");
  const modeCard = $("#modeCard");
  const isYouTube = activeHost ? /(^|\.)youtube\.com$/.test(activeHost) : false;
  $("#ytLoadOnCard").style.display = isYouTube ? "" : "none";
  $("#hideYoutubeChatCard").style.display = isYouTube ? "" : "none";
  // Theater is a YouTube-only layout — hide its rows on Kick.
  $("#modeTheaterRow").style.display = isYouTube ? "" : "none";
  $("#hideNativeTheaterRow").style.display = isYouTube ? "" : "none";
  // Mappings are editable from ANY site (not just youtube.com / kick.com), so both editors show always.
  $("#ytMappingsCard").style.display = "";
  $("#kickMappingsCard").style.display = "";
  const modeSelects = ["#modeDefault", "#modeTheater", "#modeFullscreen"].map($);
  if (!activeHost || !/^https?:/.test(activeTab?.url || "")) {
    card.style.display = "none"; modeSelects.forEach((s) => (s.disabled = true)); return;
  }
  card.style.display = "";
  $("#siteEnabledLabel").textContent = activeHost;
  if (!hostSupported) {
    modeSelects.forEach((s) => (s.disabled = true));
    $("#siteHint").textContent = "Not a supported site. Meridian works on youtube.com and kick.com.";
    return;
  }
  modeSelects.forEach((s) => (s.disabled = false));
  $("#siteHint").textContent = "Supported site.";
  const p = await getPrefs();
  const lm = layoutModesValue(p);
  $("#modeDefault").value = lm.default;
  $("#modeTheater").value = lm.theater;
  $("#modeFullscreen").value = lm.fullscreen;
  syncNativeChatPills(p);
}

$("#modeDefault").addEventListener("change", (e) => { if (activeHost && hostSupported) writeLayoutMode("default", e.target.value); });
$("#modeTheater").addEventListener("change", (e) => { if (activeHost && hostSupported) writeLayoutMode("theater", e.target.value); });
$("#modeFullscreen").addEventListener("change", (e) => { if (activeHost && hostSupported) writeLayoutMode("fullscreen", e.target.value); });
$("#hideYoutubeChatCard").addEventListener("click", (e) => {
  const btn = e.target.closest(".split-pill-btn");
  if (!btn || !activeHost) return;
  const pill = btn.closest(".split-pill");
  const layout = pill?.dataset.layout;
  if (!layout) return;
  writeHideNative(layout, btn.dataset.val === "hide");
  setNativeChatPill(pill, btn.dataset.val === "hide");
});

// ---------- Site / player binding ----------
$("#boundToPlayer").addEventListener("change", async (e) => { await setPrefs({ boundToPlayer: e.target.checked }); });
$("#ytLoadOn").addEventListener("change", async (e) => { await setPrefs({ ytLoadOn: e.target.value }); });
$("#saveMappings").addEventListener("click", async () => {
  const { mappings, errors } = parseMappings($("#mappings").value);
  await setPrefs({ mappings });
  const count = Object.keys(mappings).length;
  const msg = $("#mappingsMsg");
  msg.textContent = errors.length
    ? `Saved ${count}. Skipped: ${errors.join("; ")}`
    : `Saved ${count} mapping${count === 1 ? "" : "s"} ✓`;
  msg.className = errors.length ? "err" : "hint";
  setTimeout(() => { msg.textContent = ""; msg.className = "hint"; }, 3000);
});
$("#saveKickMappings").addEventListener("click", async () => {
  const { mappings, errors } = parseMappings($("#kickMappings").value);
  await setPrefs({ kickMappings: mappings });
  const count = Object.keys(mappings).length;
  const msg = $("#kickMappingsMsg");
  msg.textContent = errors.length
    ? `Saved ${count}. Skipped: ${errors.join("; ")}`
    : `Saved ${count} mapping${count === 1 ? "" : "s"} ✓`;
  msg.className = errors.length ? "err" : "hint";
  setTimeout(() => { msg.textContent = ""; msg.className = "hint"; }, 3000);
});

// ---------- Chat ----------
$("#saveDelay").addEventListener("click", async () => {
  const v = Math.max(0, Math.min(600, parseInt($("#delay").value, 10) || 0));
  await setPrefs({ chatDelaySec: v });
  $("#delay").value = v;
  flash($("#saveDelay"));
});
$("#saveUpdateFreq").addEventListener("click", async () => {
  const v = Math.max(0, Math.min(2000, parseInt($("#updateFreq").value, 10) || 0));
  await setPrefs({ updateFrequencyMs: v });
  $("#updateFreq").value = v;
  flash($("#saveUpdateFreq"));
});
$("#saveMaxMessages").addEventListener("click", async () => {
  const v = Math.max(50, Math.min(2000, parseInt($("#maxMessages").value, 10) || 300));
  await setPrefs({ maxMessages: v });
  $("#maxMessages").value = v;
  flash($("#saveMaxMessages"));
});
$("#hideDeleted").addEventListener("change", async (e) => { await setPrefs({ hideDeleted: e.target.checked }); });
$("#disconnectOnHide").addEventListener("change", async (e) => { await setPrefs({ disconnectOnHide: e.target.checked }); });
$("#markHighlightedMsgs").addEventListener("change", async (e) => { await setPrefs({ markHighlightedMsgs: e.target.checked }); });
$("#autoShowHide").addEventListener("change", async (e) => { await setPrefs({ autoShowHide: e.target.checked }); });
$("#saveAutoShowWindow").addEventListener("click", async () => {
  const v = Math.max(1, Math.min(60, parseInt($("#autoShowWindow").value, 10) || 5));
  await setPrefs({ autoShowWindowSec: v });
  $("#autoShowWindow").value = v;
  flash($("#saveAutoShowWindow"));
});
$("#saveAutoShowVisible").addEventListener("click", async () => {
  const v = Math.max(1, Math.min(120, parseInt($("#autoShowVisible").value, 10) || 8));
  await setPrefs({ autoShowVisibleSec: v });
  $("#autoShowVisible").value = v;
  flash($("#saveAutoShowVisible"));
});
$("#saveAutoShowSurgeFactor").addEventListener("click", async () => {
  const v = Math.max(1.1, Math.min(20, parseFloat($("#autoShowSurgeFactor").value) || 3));
  await setPrefs({ autoShowSurgeFactor: v });
  $("#autoShowSurgeFactor").value = v;
  flash($("#saveAutoShowSurgeFactor"));
});
$("#saveAutoShowMinRate").addEventListener("click", async () => {
  const v = Math.max(1, Math.min(100, parseInt($("#autoShowMinRate").value, 10) || 4));
  await setPrefs({ autoShowMinRate: v });
  $("#autoShowMinRate").value = v;
  flash($("#saveAutoShowMinRate"));
});
$("#showViewers").addEventListener("change", async (e) => { await setPrefs({ showViewers: e.target.checked }); });
$("#floatingReactions").addEventListener("change", async (e) => { await setPrefs({ floatingReactions: e.target.checked }); });
$("#saveFloatingReactionPath").addEventListener("click", async () => {
  const v = Math.max(40, Math.min(280, parseInt($("#floatingReactionPath").value, 10) || 100));
  await setPrefs({ floatingReactionPath: v });
  $("#floatingReactionPath").value = v;
  flash($("#saveFloatingReactionPath"));
});
$("#saveFloatingReactionDuration").addEventListener("click", async () => {
  const v = Math.max(400, Math.min(4000, parseInt($("#floatingReactionDuration").value, 10) || 1400));
  await setPrefs({ floatingReactionDurationMs: v });
  $("#floatingReactionDuration").value = v;
  flash($("#saveFloatingReactionDuration"));
});
$("#highlightTimeline").addEventListener("change", async (e) => {
  await setPrefs({ highlightTimeline: e.target.checked });
  syncHighlightGating();
});
$("#highlightEnabled").addEventListener("change", async (e) => {
  await setPrefs({ highlightEnabled: e.target.checked });
  syncHighlightGating();
});
$("#highlightAnchorLive").addEventListener("change", async (e) => { await setPrefs({ highlightAnchorLive: e.target.checked }); });
$("#highlightPersistEmotes").addEventListener("change", async (e) => { await setPrefs({ highlightPersistEmotes: e.target.checked }); });
$("#highlightPersistDensity").addEventListener("change", async (e) => { await setPrefs({ highlightPersistDensity: e.target.checked }); });
$("#highlightColor").addEventListener("input", async (e) => {
  $("#highlightColorAppearance").value = e.target.value;
  await setPrefs({ highlightColor: e.target.value });
});
$("#highlightColorAppearance").addEventListener("input", async (e) => {
  $("#highlightColor").value = e.target.value;
  await setPrefs({ highlightColor: e.target.value });
});
$("#saveHighlightThreshold").addEventListener("click", async () => {
  const v = Math.max(3, Math.min(100000, parseInt($("#highlightThreshold").value, 10) || 5));
  const p = await getPrefs();
  const ch = (p._activeChannel || "").toLowerCase();
  if (ch) {
    const thresholds = { ...(p.highlightThresholds || {}), [ch]: v };
    await setPrefs({ highlightThresholds: thresholds });
    $("#highlightThresholdHint").textContent = `per-channel · "Save" sets ${ch}, "Set global" sets the default (${p.highlightThreshold ?? 5})`;
  } else {
    await setPrefs({ highlightThreshold: v });
  }
  $("#highlightThreshold").value = v;
  flash($("#saveHighlightThreshold"));
});
// Always writes the global/default threshold (used by any channel without its own override).
$("#saveGlobalThreshold").addEventListener("click", async () => {
  const v = Math.max(3, Math.min(100000, parseInt($("#highlightThreshold").value, 10) || 5));
  await setPrefs({ highlightThreshold: v });
  $("#highlightThreshold").value = v;
  flash($("#saveGlobalThreshold"));
  loadAllFields(); // refresh the hint to reflect the new global default
});
$("#saveHighlightWindow").addEventListener("click", async () => {
  const v = Math.max(2, Math.min(120, parseInt($("#highlightWindow").value, 10) || 12));
  const p = await getPrefs();
  const ch = (p._activeChannel || "").toLowerCase();
  if (ch) {
    const windows = { ...(p.highlightWindows || {}), [ch]: v };
    await setPrefs({ highlightWindows: windows });
    $("#highlightWindowHint").textContent = `per-channel · "Save" sets ${ch}, "Set global" sets the default (${p.highlightWindowSec ?? 12}s)`;
  } else {
    await setPrefs({ highlightWindowSec: v });
  }
  $("#highlightWindow").value = v;
  flash($("#saveHighlightWindow"));
});
// Always writes the global/default window (used by any channel without its own override).
$("#saveGlobalWindow").addEventListener("click", async () => {
  const v = Math.max(2, Math.min(120, parseInt($("#highlightWindow").value, 10) || 12));
  await setPrefs({ highlightWindowSec: v });
  $("#highlightWindow").value = v;
  flash($("#saveGlobalWindow"));
  loadAllFields(); // refresh the hint to reflect the new global default
});
$("#saveHighlightOffset").addEventListener("click", async () => {
  const v = Math.max(0, Math.min(120, parseInt($("#highlightOffset").value, 10) || 0));
  await setPrefs({ highlightOffsetSec: v });
  $("#highlightOffset").value = v;
  flash($("#saveHighlightOffset"));
});
$("#emote7tv").addEventListener("change", async (e) => { await setPrefs({ emote7tv: e.target.checked }); });
$("#emoteBttv").addEventListener("change", async (e) => { await setPrefs({ emoteBttv: e.target.checked }); });
$("#emoteFfz").addEventListener("change", async (e) => { await setPrefs({ emoteFfz: e.target.checked }); });
$("#clearHighlightCache").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("meridian.highlights.") || k.startsWith("meridian.density."));
  if (keys.length) await chrome.storage.local.remove(keys);
  const msg = $("#clearHighlightMsg");
  msg.textContent = `Cleared ${keys.length} cached timeline${keys.length === 1 ? "" : "s"} ✓`;
  setTimeout(() => (msg.textContent = ""), 2500);
});
$("#saveBlockedWords").addEventListener("click", async () => {
  const words = $("#blockedWords").value
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(words));
  await setPrefs({ blockedWords: unique });
  const msg = $("#blockedWordsMsg");
  msg.textContent = `Saved ${unique.length} word${unique.length === 1 ? "" : "s"} ✓`;
  setTimeout(() => (msg.textContent = ""), 2000);
});

// ---------- Appearance ----------
$("#opacity").addEventListener("input", async (e) => {
  const pct = parseInt(e.target.value, 10);
  $("#opacityVal").textContent = `${pct}%`;
  setRangeFill(e.target);
  await setPrefs({ opacity: pct / 100 });
});
$("#blurEnabled").addEventListener("change", async (e) => { await setPrefs({ blurEnabled: e.target.checked }); });
$("#blurRadius").addEventListener("input", async (e) => {
  const v = parseInt(e.target.value, 10);
  $("#blurRadiusVal").textContent = `${v}px`;
  setRangeFill(e.target);
  await setPrefs({ blurRadius: v });
});
$("#bgEnabled").addEventListener("change", async (e) => { await setPrefs({ bgEnabled: e.target.checked }); });
$("#shadowEnabled").addEventListener("change", async (e) => { await setPrefs({ shadowEnabled: e.target.checked }); });
$("#outlineEnabled").addEventListener("change", async (e) => { await setPrefs({ outlineEnabled: e.target.checked }); });
$("#textStyle").addEventListener("change", async (e) => { await setPrefs({ textStyle: e.target.value }); });
$("#boldText").addEventListener("change", async (e) => { await setPrefs({ boldText: e.target.checked }); });
$("#saveFontSize").addEventListener("click", async () => {
  const v = Math.max(10, Math.min(24, parseInt($("#fontSize").value, 10) || 13));
  await setPrefs({ fontSize: v });
  $("#fontSize").value = v;
  flash($("#saveFontSize"));
});

// ---------- Hotkeys ----------
function bindHotkey(prefKey, inputSel, captureSel, clearSel) {
  const input = $(inputSel);
  let capturing = false;
  $(captureSel).addEventListener("click", () => {
    capturing = true;
    input.value = "(press combo…)";
    input.focus();
  });
  input.addEventListener("keydown", async (e) => {
    if (!capturing) { e.preventDefault(); return; }
    e.preventDefault();
    const combo = comboFromEvent(e);
    if (!combo) return; // ignore lone modifier
    capturing = false;
    input.value = combo;
    await setPrefs({ [prefKey]: combo });
  });
  $(clearSel).addEventListener("click", async () => {
    capturing = false;
    input.value = "";
    await setPrefs({ [prefKey]: "" });
  });
}
bindHotkey("hotkeyToggle", "#hotkeyToggle", "#hotkeyToggleCapture", "#hotkeyToggleClear");
bindHotkey("hotkeyFocus",  "#hotkeyFocus",  "#hotkeyFocusCapture",  "#hotkeyFocusClear");

// Like comboFromEvent but allows a BARE single key (and a lone modifier) — for the hold-to-pause
// hotkey. Must match content.js's hotkeySpecFromEvent so saved specs compare equal at runtime.
function hotkeySpecFromEvent(e) {
  const k = e.key;
  if (["Control","Alt","Shift","Meta"].includes(k)) return k; // lone modifier
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const named = k === " " ? "Space" : (k.length === 1 ? k.toUpperCase() : k);
  parts.push(named);
  return parts.join("+");
}
// Capture for the hold hotkey: a non-modifier key (alone or with modifiers) finalizes on keydown; a
// lone modifier finalizes on keyup, so "hold Alt" can be captured without a follow-up key.
function bindHoldHotkey(prefKey, inputSel, captureSel, clearSel) {
  const input = $(inputSel);
  let capturing = false, pendingMod = null;
  const finalize = async (spec) => { capturing = false; pendingMod = null; input.value = spec; await setPrefs({ [prefKey]: spec }); };
  $(captureSel).addEventListener("click", () => { capturing = true; pendingMod = null; input.value = "(press a key…)"; input.focus(); });
  input.addEventListener("keydown", (e) => {
    if (!capturing) { e.preventDefault(); return; }
    e.preventDefault();
    if (["Control","Alt","Shift","Meta"].includes(e.key)) { pendingMod = e.key; input.value = `(${e.key}…)`; return; }
    finalize(hotkeySpecFromEvent(e));
  });
  input.addEventListener("keyup", (e) => {
    if (capturing && pendingMod && e.key === pendingMod) finalize(pendingMod);
  });
  $(clearSel).addEventListener("click", async () => { capturing = false; pendingMod = null; input.value = ""; await setPrefs({ [prefKey]: "" }); });
}
bindHoldHotkey("hotkeyPauseScroll", "#hotkeyPauseScroll", "#hotkeyPauseScrollCapture", "#hotkeyPauseScrollClear");
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const k = e.key;
  if (["Control","Alt","Shift","Meta"].includes(k)) return null;
  if (parts.length === 0) return null;
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}

// ---------- Reset / clear data ----------
function resetMsg(sel, text) {
  const el = $(sel);
  el.textContent = text;
  setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2500);
}
async function removeByPrefix(...prefixes) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => prefixes.some((p) => k.startsWith(p)));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
$("#resetDisconnect").addEventListener("click", async () => {
  await send("AUTH_DISCONNECT");
  $("#authMsg").textContent = "";
  refreshStatus();
  resetMsg("#resetDisconnectMsg", "Disconnected ✓");
});
$("#resetMappings").addEventListener("click", async () => {
  await setPrefs({ mappings: { ...DEFAULT_MAPPINGS }, kickMappings: { ...DEFAULT_KICK_MAPPINGS } });
  loadAllFields();
  resetMsg("#resetMappingsMsg", "Mappings reset ✓");
});
$("#resetThresholds").addEventListener("click", async () => {
  await setPrefs({ highlightThresholds: {}, highlightWindows: {} });
  resetMsg("#resetThresholdsMsg", "Channel overrides cleared ✓");
});
$("#resetEmoteMarkers").addEventListener("click", async () => {
  const n = await removeByPrefix("meridian.highlights.");
  resetMsg("#resetEmoteMarkersMsg", `Cleared ${n} marker set${n === 1 ? "" : "s"} ✓`);
});
$("#resetDensity").addEventListener("click", async () => {
  const n = await removeByPrefix("meridian.density.");
  resetMsg("#resetDensityMsg", `Cleared ${n} timeline${n === 1 ? "" : "s"} ✓`);
});
// Reset everything is destructive + hard to reverse — require a second confirming click.
let resetAllArmed = false, resetAllTimer = null;
function disarmResetAll() {
  resetAllArmed = false;
  if (resetAllTimer) { clearTimeout(resetAllTimer); resetAllTimer = null; }
  const btn = $("#resetAll");
  btn.classList.remove("armed");
  btn.textContent = "Reset extension";
}
$("#resetAll").addEventListener("click", async () => {
  if (!resetAllArmed) {
    resetAllArmed = true;
    const btn = $("#resetAll");
    btn.classList.add("armed");
    btn.textContent = "Click again to confirm";
    resetAllTimer = setTimeout(disarmResetAll, 4000);
    return;
  }
  disarmResetAll();
  await chrome.storage.local.clear();
  await loadAllFields();        // repaint the popup with defaults
  refreshStatus();
  if (activeTab?.id) chrome.tabs.reload(activeTab.id); // re-init the content script from defaults
  resetMsg("#resetAllMsg", "Everything reset ✓");
});

// ---------- init ----------
(async () => {
  // Populate the config from storage FIRST (fast, local) so the panels fill in immediately.
  // refreshStatus() messages the background service worker, which may be cold — don't block the
  // visible settings on that round-trip; let it fill the status card in when it resolves.
  const [, o] = await Promise.all([detectActiveTab(), chrome.storage.local.get(UI_KEY)]);
  await activateTab(o[UI_KEY]?.tab || "general", false);
  await Promise.all([loadAllFields(), initSiteCard()]);
  refreshStatus(); // fire-and-forget — updates the status card asynchronously
})();

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes[PREFS_KEY]) return;
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && a.type !== "checkbox" && a.type !== "color") return;
  loadAllFields();
  // Re-sync the per-layout mode selects + hide-native checkboxes (unless the user is editing one).
  const editingSiteCtl = a && (a.id?.startsWith("mode") || a.closest?.(".split-pill"));
  if (activeHost && !editingSiteCtl) initSiteCard();
});
