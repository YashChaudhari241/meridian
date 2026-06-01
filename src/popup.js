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

// ---------- auth/status ----------
async function refreshStatus() {
  const s = await send("AUTH_STATUS");
  if (!s?.ok) return;
  $("#mode").value = s.mode;
  let cls, text;
  if (s.mode === "anonymous") { cls = "warn"; text = "Read-only (anonymous)"; }
  else if (s.cookieAvailable)  { cls = "ok"; text = `Using twitch.tv login: ${s.cookieLogin}`; }
  else                          { cls = "warn"; text = "Read-only — log into twitch.tv to chat"; }
  $("#status").innerHTML = `<div class="status-line ${cls}"><span class="dot"></span>${escapeHtml(text)}</div>`;
}

$("#mode").addEventListener("change", async (e) => { await send("MODE_SET", { mode: e.target.value }); refreshStatus(); });

// ---------- prefs load/save ----------
const defaults = {
  channel: "", mappings: {}, overrideChannel: "",
  chatDelaySec: 0, updateFrequencyMs: 0, autoscroll: true,
  hotkeyToggle: "", hotkeyFocusInput: "",
  opacity: 0.55, fontSize: 13, blurRadius: 6, maxMessages: 300,
  blurEnabled: true, bgEnabled: true, shadowEnabled: true,
  boundToPlayer: true,
  blockedWords: [], hideDeleted: false
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
  $("#autoscroll").checked = p.autoscroll !== false;
  $("#maxMessages").value = p.maxMessages ?? 300;
  $("#opacity").value = Math.round((p.opacity ?? 0.55) * 100);
  $("#opacityVal").textContent = `${Math.round((p.opacity ?? 0.55) * 100)}%`;
  $("#fontSize").value = p.fontSize ?? 13;
  $("#blurRadius").value = p.blurRadius ?? 6;
  $("#blurRadiusVal").textContent = `${p.blurRadius ?? 6}px`;
  $("#blurEnabled").checked = p.blurEnabled !== false;
  $("#bgEnabled").checked = p.bgEnabled !== false;
  $("#shadowEnabled").checked = p.shadowEnabled !== false;
  $("#hotkeyToggle").value = p.hotkeyToggle || "";
  $("#hotkeyFocusInput").value = p.hotkeyFocusInput || "";
  $("#boundToPlayer").checked = p.boundToPlayer !== false;
  $("#hideDeleted").checked = p.hideDeleted === true;
  $("#blockedWords").value = (p.blockedWords || []).join("\n");
}

// ---------- General ----------
function flash(btn, text = "Saved ✓") {
  const old = btn.textContent; btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}
// ---------- YouTube ----------
$("#boundToPlayer").addEventListener("change", async (e) => { await setPrefs({ boundToPlayer: e.target.checked }); });
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
$("#autoscroll").addEventListener("change", async (e) => {
  await setPrefs({ autoscroll: e.target.checked });
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
bindHotkey("hotkeyToggle",     "#hotkeyToggle",     "#hotkeyCapture",      "#hotkeyClear");
bindHotkey("hotkeyFocusInput", "#hotkeyFocusInput", "#hotkeyFocusCapture", "#hotkeyFocusClear");
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
  const o = await chrome.storage.local.get(UI_KEY);
  await activateTab(o[UI_KEY]?.tab || "general", false);
  await refreshStatus();
  await loadAllFields();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[PREFS_KEY]) return;
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && a.type !== "checkbox") return;
  loadAllFields();
});
