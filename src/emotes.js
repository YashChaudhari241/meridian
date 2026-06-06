// 3rd-party emote registry: 7TV, BetterTTV, FrankerFaceZ.
// Channel emotes are loaded on demand (per channel JOIN) and cached in chrome.storage.local
// under `meridian.emotes.<channelLogin>` with a 24h TTL. Global sets are loaded once per
// extension session and cached longer.

// Bumped v2 → v3: older caches could have stored a partial set (e.g. 7TV failed on a network
// blip while BTTV/FFZ succeeded → non-empty result cached for 24 h without 7TV). v3 flushes them.
const CACHE_PREFIX = "meridian.emotes.v3.";
const GLOBAL_KEY = "meridian.emotes.v3.__global";
const CHANNEL_TTL = 24 * 60 * 60 * 1000; // 24h
const GLOBAL_TTL = 24 * 60 * 60 * 1000;

// Twitch FIRST-PARTY global emotes (Kappa, NotLikeThis, …). These never appear in any 3rd-party
// set, so without this map they couldn't be autocompleted, typed as input chips, or rendered in
// your OWN sent messages (the self-echo carries no IRC emote tags). Received ones already render
// via the IRC emote-tag offsets — this is purely so the *names* resolve to an image everywhere
// else. Curated, well-known name→id pairs (CDN-verified); the v2 emote CDN serves every id below.
// Merged at LOWEST priority (a 7TV/BTTV/FFZ emote of the same name wins), so it never overrides a
// channel's custom set. Provider "Twitch" is always enabled (not one of the toggleable providers).
const TWITCH_GLOBAL = {
  Kappa: 25, Keepo: 1902, KappaPride: 55338, KappaRoss: 70433, KappaClaus: 72748, PJSalt: 36,
  "4Head": 354, BabyRage: 22639, BloodTrail: 69, BrokeBack: 4057, cmonBruh: 84608, CoolCat: 58127,
  DansGame: 33, FailFish: 360, FrankerZ: 65, FUNgineer: 244, Kreygasm: 41, MingLee: 68856,
  NotLikeThis: 58765, OSFrog: 81248, ResidentSleeper: 245, SeemsGood: 64138, SwiftRage: 34,
  TriHard: 171, VoHiYo: 81274, WutFace: 28087, HeyGuys: 30259, Jebaited: 90129, EleGiggle: 4339,
  LUL: 425618, GivePLZ: 112290, TakeNRG: 112291, PogChamp: 305954156
};

export class EmoteRegistry {
  constructor({ getAuth, onChange, getEnabledProviders }) {
    this.getAuth = getAuth;
    this.onChange = onChange || (() => {});
    // Returns a Set of enabled provider names ("7TV"/"BTTV"/"FFZ"), or null = all enabled.
    this.getEnabledProviders = getEnabledProviders || (() => null);
    this.global = null;     // Map(name → emote)
    this.channel = null;    // Map(name → emote)
    this.currentChannel = "";
    this._merged = null;    // cached merged+filtered map (rebuilt when a set or the filter changes)
    this._mergedKey = "";   // signature of the enabled-provider filter the cache was built with
  }

  currentMap() {
    if (!this.global && !this.channel) return null;
    const enabled = this.getEnabledProviders();
    const key = enabled ? [...enabled].sort().join(",") : "*";
    if (this._merged && this._mergedKey === key) return this._merged;
    // Merge global + channel (channel overrides global on name collisions).
    let base;
    if (this.channel && this.global) {
      base = new Map(this.global);
      for (const [k, v] of this.channel) base.set(k, v);
    } else {
      base = this.channel || this.global;
    }
    // Filter to enabled providers (so users can keep only the sets they want). Twitch first-party
    // globals are always kept — they're not one of the toggleable 3rd-party providers.
    if (enabled) {
      const m = new Map();
      for (const [name, em] of base) if (em.provider === "Twitch" || enabled.has(em.provider)) m.set(name, em);
      this._merged = m;
    } else {
      this._merged = base;
    }
    this._mergedKey = key;
    return this._merged;
  }

  // `userId` (the channel's numeric Twitch id) is optional — when supplied (e.g. from
  // the IRC ROOMSTATE `room-id` tag) channel emotes load without Helix, so they work in
  // anonymous mode too. Called twice per join: once from syncChannel (globals + best-effort
  // channel) and again when ROOMSTATE arrives with the id; the second call retries channel
  // emotes only if the first attempt came up empty.
  async loadForChannel(channel, userId) {
    channel = (channel || "").toLowerCase();
    if (!channel) return;
    if (channel !== this.currentChannel) { this.currentChannel = channel; this.channel = null; this._merged = null; }
    await this._ensureGlobal();
    if (!this.channel || this.channel.size === 0) {
      await this._ensureChannel(channel, userId);
    }
    this.onChange();
  }

  // Add Twitch first-party globals to a map at lowest priority (never overrides an existing entry,
  // so a 3rd-party emote of the same name wins). Applied to `this.global` on every load path.
  _addTwitchGlobals(map) {
    for (const [name, id] of Object.entries(TWITCH_GLOBAL)) {
      if (!map.has(name)) map.set(name, { url: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`, provider: "Twitch" });
    }
    return map;
  }

  async _ensureGlobal() {
    if (this.global) return;
    const cached = await loadCache(GLOBAL_KEY);
    if (cached && cached.emotes && Object.keys(cached.emotes).length > 0
        && Date.now() - cached.fetchedAt < GLOBAL_TTL) {
      this.global = this._addTwitchGlobals(mapFromObject(cached.emotes));
      this._merged = null;
      return;
    }
    const emotes = {};
    const [sevenOk] = await Promise.all([
      fetch7tvGlobal(emotes).catch(() => false),
      fetchBttvGlobal(emotes).catch(() => {}),
      fetchFfzGlobal(emotes).catch(() => {})
    ]);
    this.global = this._addTwitchGlobals(mapFromObject(emotes));
    this._merged = null;
    // Only persist when 7TV succeeded too — otherwise a transient 7TV failure would bake a
    // 7TV-less set into the 24 h cache. Without caching, the next session simply refetches.
    if (sevenOk && Object.keys(emotes).length > 0) {
      await saveCache(GLOBAL_KEY, { fetchedAt: Date.now(), emotes });
    }
  }

  async _ensureChannel(channel, userId) {
    const key = CACHE_PREFIX + channel;
    const cached = await loadCache(key);
    if (cached && cached.emotes && Object.keys(cached.emotes).length > 0
        && Date.now() - cached.fetchedAt < CHANNEL_TTL) {
      this.channel = mapFromObject(cached.emotes);
      this._merged = null;
      return;
    }
    const id = userId || await this._resolveUserId(channel);
    if (!id) { this.channel = this.channel || new Map(); this._merged = null; return; } // retry once an id arrives
    const emotes = {};
    const results = await Promise.allSettled([
      fetch7tvChannel(id, emotes),
      fetchBttvChannel(id, emotes),
      fetchFfzChannel(id, emotes)
    ]);
    // fetch7tvChannel resolves true on success OR a clean 404 (channel has no 7TV set); only a
    // network/5xx error counts as "not ok" → don't cache, so we retry rather than cache partial.
    const sevenOk = results[0].status === "fulfilled" && results[0].value === true;
    this.channel = mapFromObject(emotes);
    this._merged = null;
    if (sevenOk && Object.keys(emotes).length > 0) {
      await saveCache(key, { fetchedAt: Date.now(), emotes });
    }
  }

  async _resolveUserId(login) {
    // Keyless first: FFZ exposes the numeric Twitch id via room-by-name (works anonymously).
    const ffzId = await resolveViaFfz(login);
    if (ffzId) return ffzId;
    // Authed fallback via Helix (only available in cookie mode).
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

async function resolveViaFfz(login) {
  try {
    const r = await fetch(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(login)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.room?.twitch_id ? String(j.room.twitch_id) : null;
  } catch { return null; }
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
  if (!r.ok) return false;
  const j = await r.json();
  for (const e of j.emotes || []) { try { add7tv(out, e); } catch {} }
  return true;
}
async function fetch7tvChannel(userId, out) {
  const r = await fetch(`https://7tv.io/v3/users/twitch/${userId}`);
  if (r.status === 404) return true; // channel simply has no 7TV account — a valid empty result
  if (!r.ok) return false;
  const j = await r.json();
  for (const e of j.emote_set?.emotes || []) { try { add7tv(out, e); } catch {} }
  return true;
}
function add7tv(out, e) {
  if (!e || !e.name) return;
  const host = (e.data && e.data.host) || {};
  if (!host.url) return;
  const base = host.url.startsWith("//") ? `https:${host.url}` : host.url;
  const files = (Array.isArray(host.files) ? host.files : []).filter((f) => f && f.name);
  const isWebp = (f) => typeof f.format === "string" && f.format.toUpperCase() === "WEBP";
  const file = files.find((f) => isWebp(f) && f.name === "2x.webp")
            || files.find((f) => f.name === "2x.webp")
            || files.find((f) => f.name === "2x.avif")
            || files.find((f) => f.name.startsWith("2x."))
            || files.find(isWebp)
            || files[0];
  // Some emotes (often newly-added / animated) come back with an empty `files` list even though
  // they're in the set — the 7TV CDN still serves `2x.webp` for them, so construct it directly
  // instead of dropping the emote. (Fixes occasional missing emotes like MUGA / AAAA.)
  const fileName = file?.name || "2x.webp";
  out[e.name] = { url: `${base}/${fileName}`, provider: "7TV" };
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
