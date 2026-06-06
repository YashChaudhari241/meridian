// Configurable mock Twitch IRC server for perf reproduction (no deps; Node 22 globals).
//
// Speaks just enough Twitch IRC-over-WebSocket for the Meridian content script:
//   CAP/NICK/PASS handshake → 001 welcome → on JOIN: ROOMSTATE (+ room-id), 353 NAMES,
//   GLOBALUSERSTATE → then a stream of PRIVMSG lines at a controllable rate, with a
//   controllable user pool, a realistic emote pool (fetched live from 7TV + BTTV globals so
//   the client actually renders them), occasional native-emote tags, and triggerable emote
//   SURGES (N unique users spamming one emote for a window — drives the highlight engine).
//
// Point the extension at it with prefs.debugIrcUrl = "ws://localhost:7878".
//
// HTTP control (same port):
//   GET /            → status JSON
//   GET /set?rate=120&users=8000&emotes=2&native=0.1   → live-tune the base stream
//   GET /surge?emote=PogChamp&users=80&rate=40&dur=8   → trigger an emote surge
//   GET /burst?rate=300&dur=5                           → temporary rate spike (peak test)
//   GET /stop                                           → rate→0 (idle)
//
// Usage: node debug/mock-irc.mjs [port]
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 7878);
const CHANNEL = process.env.MOCK_CHANNEL || "mockchannel";
const ROOM_ID = process.env.MOCK_ROOM_ID || "12345678";

// ---- live config (mutable via HTTP) ----
const cfg = {
  rate: 100,        // base messages/sec
  users: 5000,      // distinct user pool size
  emotes: 1.5,      // avg 3rd-party emote tokens per message
  native: 0.08,     // probability a message also carries a native Twitch emote (IRC emotes tag)
};

// A temporary rate burst (peak test) and an emote surge, each with an end-time.
let burst = null;   // { rate, until }
let surge = null;   // { emote, users, rate, until, pool:[userIdx...] }

// ---- emote pool (fetched live so client renders them) ----
let EMOTES = ["Kappa", "PogChamp", "LUL", "Pog", "EZ", "Clap", "monkaS", "Sadge", "KEKW", "OMEGALUL"];
async function loadEmotes() {
  const names = new Set();
  try {
    const r = await fetch("https://7tv.io/v3/emote-sets/global");
    const j = await r.json();
    for (const e of j.emotes || []) if (e.name) names.add(e.name);
  } catch (e) { console.warn("7TV global fetch failed:", e.message); }
  try {
    const r = await fetch("https://api.betterttv.net/3/cached/emotes/global");
    const j = await r.json();
    for (const e of j || []) if (e.code) names.add(e.code);
  } catch (e) { console.warn("BTTV global fetch failed:", e.message); }
  if (names.size) EMOTES = [...names];
  console.log(`emote pool: ${EMOTES.length} names`);
}

// Native Twitch emotes: [name, id] — emitted via the IRC `emotes` tag with char offsets.
// Verified-live emote ids (some legacy ids like BibleThump/86 are retired and 404 at every scale).
const NATIVE = [["Kappa", "25"], ["PogChamp", "305954156"], ["4Head", "354"], ["LUL", "425618"], ["DansGame", "33"]];

// A few words to pad messages so they aren't 100% emotes.
const WORDS = "lets go this is insane what a play no way clutch gg ez omg poggers hold up actually crazy he is cracked nice one wow real he did it again".split(" ");

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function userName(i) { return `viewer${i}`; }

// Build one realistic PRIVMSG IRC line for a given user index.
function buildPrivmsg(userIdx, forceEmote) {
  const login = userName(userIdx);
  const color = ["#FF0000", "#00FF00", "#1E90FF", "#FF7F50", "#9ACD32", "#FFD700", "#FF69B4", ""][userIdx % 8];
  const id = crypto.randomUUID();
  const ts = Date.now();

  // Compose the message body: words + 3rd-party emote tokens (rendered client-side from text).
  const parts = [];
  const wordCount = 1 + rnd(4);
  for (let i = 0; i < wordCount; i++) parts.push(pick(WORDS));
  const nEm = forceEmote ? 1 : Math.random() < (cfg.emotes % 1) ? Math.ceil(cfg.emotes) : Math.floor(cfg.emotes);
  for (let i = 0; i < nEm; i++) {
    const at = rnd(parts.length + 1);
    parts.splice(at, 0, forceEmote && i === 0 ? forceEmote : pick(EMOTES));
  }
  let text = parts.join(" ");

  // Occasionally prepend a NATIVE emote so the IRC emotes-tag path is exercised too.
  let emotesTag = "";
  if (Math.random() < cfg.native) {
    const [nm, eid] = pick(NATIVE);
    text = nm + " " + text;
    emotesTag = `${eid}:0-${nm.length - 1}`;
  }

  const tags =
    `@badge-info=;badges=;client-nonce=${id.slice(0, 8)};color=${color};display-name=${login};` +
    `emotes=${emotesTag};first-msg=0;flags=;id=${id};mod=0;returning-chatter=0;room-id=${ROOM_ID};` +
    `subscriber=0;tmi-sent-ts=${ts};turbo=0;user-id=${1000000 + userIdx};user-type=`;
  return `${tags} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${CHANNEL} :${text}`;
}

// ---- WebSocket server (hand-rolled framing; text frames only) ----
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Set();

function sendFrame(sock, str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { sock.write(Buffer.concat([header, payload])); } catch {}
}

// Parse client→server frames (always masked). Yields complete text payloads.
function makeFrameParser(onText, onClose) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      const data = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.slice(off + maskLen + len);
      if (opcode === 0x8) { onClose(); return; }
      if (opcode === 0x1 || opcode === 0x0) onText(data.toString("utf8"));
      // opcode 0x9 (ping) / 0xA (pong) ignored
    }
  };
}

function handleClientLine(sock, line, state) {
  if (line.startsWith("CAP REQ")) {
    sendFrame(sock, ":tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
  } else if (line.startsWith("PASS")) {
    // ignore
  } else if (line.startsWith("NICK")) {
    state.nick = line.slice(5).trim() || "justinfan12345";
    // Welcome burst
    sendFrame(sock, `:tmi.twitch.tv 001 ${state.nick} :Welcome, GLHF!`);
    sendFrame(sock, `:tmi.twitch.tv 002 ${state.nick} :Your host is tmi.twitch.tv`);
    sendFrame(sock, `:tmi.twitch.tv 376 ${state.nick} :>`);
    sendFrame(sock, `@badge-info=;badges=;color=;display-name=${state.nick};emote-sets=0;user-id=999;user-type= :tmi.twitch.tv GLOBALUSERSTATE`);
  } else if (line.startsWith("JOIN")) {
    const ch = line.slice(5).replace(/^#/, "").trim() || CHANNEL;
    state.channel = ch;
    sendFrame(sock, `:${state.nick}!${state.nick}@${state.nick}.tmi.twitch.tv JOIN #${ch}`);
    sendFrame(sock, `@emote-only=0;followers-only=-1;r9k=0;room-id=${ROOM_ID};slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #${ch}`);
    // 353 NAMES — a sample of chatters so @-mention suggestions seed.
    const names = Array.from({ length: 60 }, (_, i) => userName(i)).join(" ");
    sendFrame(sock, `:${state.nick}.tmi.twitch.tv 353 ${state.nick} = #${ch} :${names}`);
    sendFrame(sock, `:${state.nick}.tmi.twitch.tv 366 ${state.nick} #${ch} :End of /NAMES list`);
  } else if (line.startsWith("PING")) {
    sendFrame(sock, "PONG :tmi.twitch.tv");
  } else if (line.startsWith("PART")) {
    state.channel = null;
  }
  // PRIVMSG from client (sent messages) — ignore; the client self-echoes.
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const q = u.searchParams;
  const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
  if (u.pathname === "/set") {
    if (q.has("rate")) cfg.rate = Math.max(0, num("rate"));
    if (q.has("users")) cfg.users = Math.max(1, num("users"));
    if (q.has("emotes")) cfg.emotes = Math.max(0, num("emotes"));
    if (q.has("native")) cfg.native = Math.max(0, Math.min(1, num("native")));
  } else if (u.pathname === "/surge") {
    const dur = num("dur", 8);
    surge = {
      emote: q.get("emote") || pick(EMOTES),
      users: Math.max(1, num("users", 60)),
      rate: Math.max(1, num("rate", 40)),
      until: Date.now() + dur * 1000,
    };
  } else if (u.pathname === "/burst") {
    const dur = num("dur", 5);
    burst = { rate: Math.max(0, num("rate", 300)), until: Date.now() + dur * 1000 };
  } else if (u.pathname === "/stop") {
    cfg.rate = 0; burst = null; surge = null;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ cfg, burst, surge, clients: clients.size, channel: CHANNEL, roomId: ROOM_ID, emotePool: EMOTES.length }, null, 2));
});

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const state = { nick: "justinfan", channel: null, sock };
  clients.add(state);
  const parser = makeFrameParser(
    (text) => { for (const line of text.split("\r\n").filter(Boolean)) handleClientLine(sock, line, state); },
    () => { clients.delete(state); try { sock.end(); } catch {} }
  );
  sock.on("data", parser);
  sock.on("close", () => clients.delete(state));
  sock.on("error", () => clients.delete(state));
});

// ---- the stream pump ----
// We tick every 50ms and emit floor/ceil of the per-tick quota so fractional rates work and
// bursts stay smooth. Surge messages are interleaved on top of the base rate.
let acc = 0, surgeAcc = 0;
const TICK = 50;
setInterval(() => {
  if (!clients.size) return;
  const now = Date.now();
  const baseRate = burst && now < burst.until ? burst.rate : cfg.rate;
  if (burst && now >= burst.until) burst = null;

  // Base stream.
  acc += (baseRate * TICK) / 1000;
  const nBase = Math.floor(acc);
  acc -= nBase;
  const lines = [];
  for (let i = 0; i < nBase; i++) lines.push(buildPrivmsg(rnd(cfg.users)));

  // Surge stream (unique users from a fixed pool spamming one emote).
  if (surge && now < surge.until) {
    surgeAcc += (surge.rate * TICK) / 1000;
    const nS = Math.floor(surgeAcc);
    surgeAcc -= nS;
    for (let i = 0; i < nS; i++) lines.push(buildPrivmsg(rnd(surge.users), surge.emote));
  } else if (surge && now >= surge.until) { surge = null; surgeAcc = 0; }

  if (!lines.length) return;
  const blob = lines.map((l) => l).join("\r\n") + "\r\n";
  for (const c of clients) sendFrame(c.sock, blob);
}, TICK);

// Listen on BOTH stacks. A default Node bind lands IPv6-only on macOS, so whether the browser
// resolves `localhost` → 127.0.0.1 (IPv4) or ::1 (IPv6) decides whether it connects — a flaky
// roulette. Bind 0.0.0.0 (all IPv4) on the main server and spin a second server on ::1 sharing the
// same handlers, so ws://localhost works no matter how it resolves.
function attach(srv) { srv.on("upgrade", (req, sock) => server.emit("upgrade", req, sock)); }
await loadEmotes();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock-irc on ws://localhost:${PORT} / ws://127.0.0.1:${PORT}  (channel #${CHANNEL}, room-id ${ROOM_ID})`);
  console.log(`control: curl localhost:${PORT}/  |  /set?rate=N  |  /surge?emote=X&users=N&rate=N&dur=S  |  /burst?rate=N&dur=S  |  /stop`);
});
// Second listener on IPv6 loopback, reusing the same request + upgrade handling.
const server6 = http.createServer((req, res) => server.emit("request", req, res));
server6.on("upgrade", (req, sock) => server.emit("upgrade", req, sock));
server6.listen(PORT, "::1", () => console.log(`  also on ws://[::1]:${PORT}`));
server6.on("error", (e) => console.warn("ipv6 listen skipped:", e.message));
