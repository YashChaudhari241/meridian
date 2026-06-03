const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const PREFS_KEY = "meridian.prefs";
const UI_KEY = "meridian.ui";

function send(type, extra = {}) { return chrome.runtime.sendMessage({ type, ...extra }); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- tabs ----------
async function activateTab(name, persist = true) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === name));
  if (persist) await chrome.storage.local.set({ [UI_KEY]: { tab: name } });
}
$$(".tab").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));

// ---------- auth (official Twitch OAuth; anonymous read-only by default) ----------
async function refreshStatus() {
  const s = await send("AUTH_STATUS");
  if (!s?.ok) return;
  let cls, text;
  if (s.connected) { cls = "ok"; text = `Connected as ${s.displayName || s.login}`; }
  else { cls = "warn"; text = "Anonymous read only"; }
  $("#status").innerHTML = `<div class="status-line ${cls}"><span class="dot"></span>${escapeHtml(text)}</div>`;
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
// Default YouTube handle / Kick slug → Twitch channel mappings (mirrors content.js DEFAULT_MAPPINGS).
const DEFAULT_MAPPINGS = {
  eslcs: "eslcs", pgl: "pgl", blastpremier: "blastpremier",
  starladder_cs: "starladder_cs_en", starladder: "starladder_cs_en",
  valorantesports: "valorant", tenz: "tenz", ohnepixel: "ohnepixel"
};
const defaults = {
  channel: "", mappings: { ...DEFAULT_MAPPINGS }, overrideChannel: "",
  chatDelaySec: 0, updateFrequencyMs: 0, autoscroll: true,
  hotkeyToggle: "", hotkeyFocus: "",
  opacity: 0.51, fontSize: 13, blurRadius: 0, maxMessages: 300,
  blurEnabled: false, bgEnabled: true, shadowEnabled: false, outlineEnabled: true,
  boundToPlayer: true,
  blockedWords: [], hideDeleted: true,
  hidden: false, extensionEnabled: true,
  sites: {},
  highlightTimeline: true, highlightEnabled: true, highlightThreshold: 5, highlightAnchorLive: true,
  highlightOffsetSec: 5, highlightColor: "#b388ff",
  emote7tv: true, emoteBttv: true, emoteFfz: true,
  textStyle: "shadow", boldText: true,
  ytLoadOn: "live"
};

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
  $("#delay").value = p.chatDelaySec ?? 0;
  $("#updateFreq").value = p.updateFrequencyMs ?? 0;
  $("#maxMessages").value = p.maxMessages ?? 300;
  $("#opacity").value = Math.round((p.opacity ?? 0.51) * 100);
  $("#opacityVal").textContent = `${Math.round((p.opacity ?? 0.51) * 100)}%`;
  $("#fontSize").value = p.fontSize ?? 13;
  $("#blurRadius").value = p.blurRadius ?? 0;
  $("#blurRadiusVal").textContent = `${p.blurRadius ?? 0}px`;
  $("#blurEnabled").checked = p.blurEnabled === true;
  $("#bgEnabled").checked = p.bgEnabled !== false;
  $("#shadowEnabled").checked = p.shadowEnabled === true;
  $("#outlineEnabled").checked = p.outlineEnabled !== false;
  $("#hotkeyToggle").value = p.hotkeyToggle || "";
  $("#hotkeyFocus").value = p.hotkeyFocus || "";
  $("#boundToPlayer").checked = p.boundToPlayer !== false;
  $("#ytLoadOn").value = p.ytLoadOn === "all" ? "all" : "live";
  $("#hideDeleted").checked = p.hideDeleted === true;
  $("#blockedWords").value = (p.blockedWords || []).join("\n");
  $("#extensionEnabled").checked = p.extensionEnabled !== false;
  $("#highlightTimeline").checked = p.highlightTimeline === true;
  $("#highlightEnabled").checked = p.highlightEnabled === true;
  $("#highlightAnchorLive").checked = p.highlightAnchorLive !== false;
  $("#highlightThreshold").value = Math.max(3, p.highlightThreshold ?? 5);
  $("#highlightOffset").value = p.highlightOffsetSec ?? 5;
  $("#highlightColor").value = p.highlightColor || "#b388ff";
  $("#emote7tv").checked = p.emote7tv !== false;
  $("#emoteBttv").checked = p.emoteBttv !== false;
  $("#emoteFfz").checked = p.emoteFfz !== false;
  $("#textStyle").value = p.textStyle || "none";
  $("#boldText").checked = p.boldText === true;
  syncHighlightGating(p.highlightTimeline === true);
}
// Emote highlights only make sense when the wave is on.
function syncHighlightGating(timelineOn) {
  for (const sel of ["#highlightEnabled", "#highlightAnchorLive"]) {
    const dep = $(sel);
    dep.disabled = !timelineOn;
    dep.closest("label").style.opacity = timelineOn ? "" : "0.5";
  }
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

function siteModeValue(p) {
  const m = p.sites?.[activeHost]?.mode;
  return (m === "overlay" || m === "docked" || m === "auto") ? m : "auto";
}

async function initSiteCard() {
  const card = $("#siteCard");
  const sel = $("#siteMode");
  const isYouTube = activeHost ? /(^|\.)youtube\.com$/.test(activeHost) : false;
  $("#ytLoadOnCard").style.display = isYouTube ? "" : "none";
  if (!activeHost || !/^https?:/.test(activeTab?.url || "")) {
    card.style.display = "none"; sel.disabled = true; return;
  }
  card.style.display = "";
  $("#siteEnabledLabel").textContent = activeHost;
  if (!hostSupported) {
    sel.disabled = true;
    $("#siteHint").textContent = "Not a supported site. Meridian works on youtube.com and kick.com.";
    return;
  }
  sel.disabled = false;
  $("#siteHint").textContent = "Supported site.";
  const p = await getPrefs();
  sel.value = siteModeValue(p);
}

$("#siteMode").addEventListener("change", async (e) => {
  if (!activeHost || !hostSupported) return;
  const v = e.target.value; // auto | overlay | docked
  const cur = await getPrefs();
  const sites = { ...(cur.sites || {}) };
  sites[activeHost] = { ...(sites[activeHost] || {}), mode: v, hidden: false };
  await setPrefs({ sites });
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
$("#highlightTimeline").addEventListener("change", async (e) => {
  const on = e.target.checked;
  await setPrefs(on ? { highlightTimeline: true } : { highlightTimeline: false, highlightEnabled: false });
  if (!on) $("#highlightEnabled").checked = false;
  syncHighlightGating(on);
});
$("#highlightEnabled").addEventListener("change", async (e) => { await setPrefs({ highlightEnabled: e.target.checked }); });
$("#highlightAnchorLive").addEventListener("change", async (e) => { await setPrefs({ highlightAnchorLive: e.target.checked }); });
$("#highlightColor").addEventListener("input", async (e) => { await setPrefs({ highlightColor: e.target.value }); });
$("#saveHighlightThreshold").addEventListener("click", async () => {
  const v = Math.max(3, Math.min(100000, parseInt($("#highlightThreshold").value, 10) || 5));
  await setPrefs({ highlightThreshold: v });
  $("#highlightThreshold").value = v;
  flash($("#saveHighlightThreshold"));
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
  const keys = Object.keys(all).filter((k) => k.startsWith("meridian.highlights."));
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
  await setPrefs({ opacity: pct / 100 });
});
$("#blurEnabled").addEventListener("change", async (e) => { await setPrefs({ blurEnabled: e.target.checked }); });
$("#blurRadius").addEventListener("input", async (e) => {
  const v = parseInt(e.target.value, 10);
  $("#blurRadiusVal").textContent = `${v}px`;
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
  if (activeHost && hostSupported && a !== $("#siteMode")) {
    $("#siteMode").value = siteModeValue(await getPrefs());
  }
});
