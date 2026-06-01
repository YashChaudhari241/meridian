// 3rd-party emote registry: 7TV, BetterTTV, FrankerFaceZ.
// Channel emotes are loaded on demand (per channel JOIN) and cached in chrome.storage.local
// under `meridian.emotes.<channelLogin>` with a 24h TTL. Global sets are loaded once per
// extension session and cached longer.

const CACHE_PREFIX = "meridian.emotes.v2.";
const GLOBAL_KEY = "meridian.emotes.v2.__global";
const CHANNEL_TTL = 24 * 60 * 60 * 1000; // 24h
const GLOBAL_TTL = 24 * 60 * 60 * 1000;

export class EmoteRegistry {
  constructor({ getAuth, onChange }) {
    this.getAuth = getAuth;
    this.onChange = onChange || (() => {});
    this.global = null;     // Map(name → emote)
    this.channel = null;    // Map(name → emote)
    this.currentChannel = "";
  }

  currentMap() {
    if (!this.global && !this.channel) return null;
    if (this.channel && this.global) {
      // channel overrides global
      const m = new Map(this.global);
      for (const [k, v] of this.channel) m.set(k, v);
      return m;
    }
    return this.channel || this.global;
  }

  async loadForChannel(channel) {
    channel = (channel || "").toLowerCase();
    if (!channel) return;
    if (channel === this.currentChannel && this.channel) return;
    this.currentChannel = channel;
    this.channel = null;
    await this._ensureGlobal();
    await this._ensureChannel(channel);
    this.onChange();
  }

  async _ensureGlobal() {
    if (this.global) return;
    const cached = await loadCache(GLOBAL_KEY);
    if (cached && cached.emotes && Object.keys(cached.emotes).length > 0
        && Date.now() - cached.fetchedAt < GLOBAL_TTL) {
      this.global = mapFromObject(cached.emotes);
      return;
    }
    const emotes = {};
    await Promise.all([
      fetch7tvGlobal(emotes).catch(() => {}),
      fetchBttvGlobal(emotes).catch(() => {}),
      fetchFfzGlobal(emotes).catch(() => {})
    ]);
    this.global = mapFromObject(emotes);
    if (Object.keys(emotes).length > 0) {
      await saveCache(GLOBAL_KEY, { fetchedAt: Date.now(), emotes });
    }
  }

  async _ensureChannel(channel) {
    const key = CACHE_PREFIX + channel;
    const cached = await loadCache(key);
    if (cached && cached.emotes && Object.keys(cached.emotes).length > 0
        && Date.now() - cached.fetchedAt < CHANNEL_TTL) {
      this.channel = mapFromObject(cached.emotes);
      return;
    }
    const userId = await this._resolveUserId(channel);
    if (!userId) { this.channel = new Map(); return; }
    const emotes = {};
    await Promise.allSettled([
      fetch7tvChannel(userId, emotes),
      fetchBttvChannel(userId, emotes),
      fetchFfzChannel(userId, emotes)
    ]);
    this.channel = mapFromObject(emotes);
    if (Object.keys(emotes).length > 0) {
      await saveCache(key, { fetchedAt: Date.now(), emotes });
    }
  }

  async _resolveUserId(login) {
    const auth = this.getAuth?.();
    if (!auth?.accessToken || !auth.clientId) return null;
    try {
      const r = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, "Client-Id": auth.clientId }
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.data?.[0]?.id || null;
    } catch { return null; }
  }
}

function mapFromObject(o) {
  const m = new Map();
  for (const [name, em] of Object.entries(o || {})) m.set(name, em);
  return m;
}

async function loadCache(key) {
  try {
    const o = await chrome.storage.local.get(key);
    return o[key] || null;
  } catch { return null; }
}
async function saveCache(key, val) {
  try { await chrome.storage.local.set({ [key]: val }); } catch {}
}

// ---------- 7TV ----------
async function fetch7tvGlobal(out) {
  const r = await fetch("https://7tv.io/v3/emote-sets/global");
  if (!r.ok) return;
  const j = await r.json();
  for (const e of j.emotes || []) { try { add7tv(out, e); } catch {} }
}
async function fetch7tvChannel(userId, out) {
  const r = await fetch(`https://7tv.io/v3/users/twitch/${userId}`);
  if (!r.ok) return;
  const j = await r.json();
  for (const e of j.emote_set?.emotes || []) { try { add7tv(out, e); } catch {} }
}
function add7tv(out, e) {
  if (!e || !e.name) return;
  const host = (e.data && e.data.host) || {};
  if (!host.url) return;
  const files = (Array.isArray(host.files) ? host.files : []).filter((f) => f && f.name);
  if (files.length === 0) return;
  const isWebp = (f) => typeof f.format === "string" && f.format.toUpperCase() === "WEBP";
  const file = files.find((f) => isWebp(f) && f.name === "2x.webp")
            || files.find((f) => f.name === "2x.webp")
            || files.find((f) => f.name === "2x.avif")
            || files.find((f) => f.name.startsWith("2x."))
            || files.find(isWebp)
            || files[0];
  if (!file) return;
  const base = host.url.startsWith("//") ? `https:${host.url}` : host.url;
  out[e.name] = { url: `${base}/${file.name}`, provider: "7TV" };
}

// ---------- BetterTTV ----------
async function fetchBttvGlobal(out) {
  const r = await fetch("https://api.betterttv.net/3/cached/emotes/global");
  if (!r.ok) return;
  for (const e of await r.json()) addBttv(out, e);
}
async function fetchBttvChannel(userId, out) {
  const r = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${userId}`);
  if (!r.ok) return;
  const j = await r.json();
  for (const e of j.channelEmotes || []) addBttv(out, e);
  for (const e of j.sharedEmotes || []) addBttv(out, e);
}
function addBttv(out, e) {
  if (!e?.code || !e?.id) return;
  out[e.code] = { url: `https://cdn.betterttv.net/emote/${e.id}/2x.${e.imageType || "webp"}`, provider: "BTTV" };
}

// ---------- FrankerFaceZ ----------
async function fetchFfzGlobal(out) {
  const r = await fetch("https://api.frankerfacez.com/v1/set/global");
  if (!r.ok) return;
  const j = await r.json();
  for (const id of j.default_sets || []) {
    const set = j.sets?.[id]; if (!set) continue;
    for (const e of set.emoticons || []) addFfz(out, e);
  }
}
async function fetchFfzChannel(userId, out) {
  const r = await fetch(`https://api.frankerfacez.com/v1/room/id/${userId}`);
  if (!r.ok) return;
  const j = await r.json();
  for (const setId of Object.keys(j.sets || {})) {
    for (const e of j.sets[setId].emoticons || []) addFfz(out, e);
  }
}
function addFfz(out, e) {
  if (!e?.name) return;
  // Prefer animated variants if present (FFZ "animated" field).
  const urls = (e.animated && (e.animated["2"] || e.animated["1"] || e.animated["4"])) ? e.animated : (e.urls || {});
  const url = urls["2"] || urls["1"] || urls["4"];
  if (!url) return;
  out[e.name] = { url: url.startsWith("//") ? "https:" + url : url, provider: "FFZ" };
}
