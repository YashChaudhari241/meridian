#!/usr/bin/env node
// Standalone check for emote loading. Mirrors the parsing logic in
// src/emotes.js so we can verify what's actually fetchable without poking
// at the browser. Usage:
//   node scripts/check-emotes.mjs            # globals only
//   node scripts/check-emotes.mjs <channel>  # globals + the channel's sets

const channel = process.argv[2] || null;

// --- parsing helpers (kept in sync with src/emotes.js) ---
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
function addBttv(out, e) {
  if (!e?.code || !e?.id) return;
  out[e.code] = { url: `https://cdn.betterttv.net/emote/${e.id}/2x.${e.imageType || "webp"}`, provider: "BTTV" };
}
function addFfz(out, e) {
  if (!e?.name) return;
  const urls = (e.animated && (e.animated["2"] || e.animated["1"] || e.animated["4"])) ? e.animated : (e.urls || {});
  const url = urls["2"] || urls["1"] || urls["4"];
  if (!url) return;
  out[e.name] = { url: url.startsWith("//") ? "https:" + url : url, provider: "FFZ" };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function load7tvGlobal(out) {
  const j = await getJson("https://7tv.io/v3/emote-sets/global");
  for (const e of j.emotes || []) { try { add7tv(out, e); } catch {} }
}
async function loadBttvGlobal(out) {
  for (const e of await getJson("https://api.betterttv.net/3/cached/emotes/global")) addBttv(out, e);
}
async function loadFfzGlobal(out) {
  const j = await getJson("https://api.frankerfacez.com/v1/set/global");
  for (const id of j.default_sets || []) {
    for (const e of (j.sets?.[id]?.emoticons || [])) addFfz(out, e);
  }
}
async function load7tvChannel(userId, out) {
  const j = await getJson(`https://7tv.io/v3/users/twitch/${userId}`);
  for (const e of j.emote_set?.emotes || []) { try { add7tv(out, e); } catch {} }
}
async function loadBttvChannel(userId, out) {
  const j = await getJson(`https://api.betterttv.net/3/cached/users/twitch/${userId}`);
  for (const e of j.channelEmotes || []) addBttv(out, e);
  for (const e of j.sharedEmotes || []) addBttv(out, e);
}
async function loadFfzChannel(userId, out) {
  const j = await getJson(`https://api.frankerfacez.com/v1/room/id/${userId}`);
  for (const setId of Object.keys(j.sets || {})) {
    for (const e of j.sets[setId].emoticons || []) addFfz(out, e);
  }
}

function report(label, before, after) {
  const added = Object.keys(after).length - before;
  console.log(`  ${label.padEnd(8)} +${added}`);
}

const globals = {};
let n = 0;
console.log("globals:");
await load7tvGlobal(globals).catch((e) => console.log("  7TV    FAIL:", e.message));   report("7TV", n, globals); n = Object.keys(globals).length;
await loadBttvGlobal(globals).catch((e) => console.log("  BTTV   FAIL:", e.message));  report("BTTV", n, globals); n = Object.keys(globals).length;
await loadFfzGlobal(globals).catch((e) => console.log("  FFZ    FAIL:", e.message));   report("FFZ", n, globals); n = Object.keys(globals).length;
console.log(`  total: ${Object.keys(globals).length}`);

function probe(map, name) {
  const e = map[name];
  console.log(`  ${name.padEnd(16)} ${e ? `[${e.provider}] ${e.url}` : "(absent)"}`);
}
console.log("\nprobe globals:");
for (const n of ["KEKW", "FeelsGoodMan", "OMEGALUL", "monkaS", "PepeLaugh", "Pog", "Sadge", "POGGERS"]) probe(globals, n);

if (channel) {
  console.log(`\nchannel '${channel}':`);
  // Resolve twitch user id via 7TV's user-by-login (no auth required).
  let userId = null;
  try {
    // 7TV doesn't expose login lookup directly; use the public IVR endpoint as a no-auth helper.
    const u = await getJson(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(channel)}`);
    userId = Array.isArray(u) ? u[0]?.id : u?.id;
  } catch (e) {
    console.log("  user lookup failed:", e.message);
  }
  if (!userId) { console.log("  could not resolve user id, aborting channel checks"); process.exit(0); }
  console.log(`  user id: ${userId}`);
  const ch = {};
  let cn = 0;
  await load7tvChannel(userId, ch).catch((e) => console.log("  7TV    FAIL:", e.message));   report("7TV", cn, ch); cn = Object.keys(ch).length;
  await loadBttvChannel(userId, ch).catch((e) => console.log("  BTTV   FAIL:", e.message));  report("BTTV", cn, ch); cn = Object.keys(ch).length;
  await loadFfzChannel(userId, ch).catch((e) => console.log("  FFZ    FAIL:", e.message));   report("FFZ", cn, ch); cn = Object.keys(ch).length;
  console.log(`  total: ${Object.keys(ch).length}`);
  console.log("\nprobe channel:");
  for (const n of ["KEKW", "FeelsGoodMan", "OMEGALUL", "monkaS", "PepeLaugh", "Pog", "Sadge", "POGGERS"]) probe(ch, n);
}
