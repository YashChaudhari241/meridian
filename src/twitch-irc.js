// Minimal Twitch IRC-over-WebSocket client.
// Usage:
//   const c = new TwitchIRC({ token, login, onMessage, onStatus });
//   c.connect(); c.join("channelname"); c.say("hi"); c.disconnect();

export class TwitchIRC {
  constructor({ token, login, displayName, anonymous = false, onMessage, onStatus, url }) {
    this.token = token;
    // Debug hook: point the IRC socket at a local mock server (perf reproduction). Defaults to the
    // real Twitch endpoint. Never set in production — only via prefs.debugIrcUrl in a debug profile.
    this.url = url || "wss://irc-ws.chat.twitch.tv:443";
    this.anonymous = anonymous || !token;
    this.login = login.toLowerCase();
    this.displayName = displayName || login;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.channel = null;
    this.reconnectDelay = 1000;
    this.shouldRun = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    this.shouldRun = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._open();
  }

  disconnect() {
    this.shouldRun = false;
    this._clearPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  join(channel) {
    const ch = channel.toLowerCase().replace(/^#/, "");
    if (this.channel === ch) return;
    if (this.channel && this.ws?.readyState === 1) {
      this.ws.send(`PART #${this.channel}`);
    }
    this.channel = ch;
    if (this.ws?.readyState === 1) this.ws.send(`JOIN #${ch}`);
  }

  leave() {
    if (this.channel && this.ws?.readyState === 1) {
      this.ws.send(`PART #${this.channel}`);
    }
    this.channel = null;
  }

  say(text) {
    if (this.anonymous) return false;
    if (!this.channel || this.ws?.readyState !== 1) return false;
    this.ws.send(`PRIVMSG #${this.channel} :${text}`);
    // echo locally — Twitch IRC doesn't send your own messages back
    this.onMessage({
      type: "msg",
      user: this.login,
      displayName: this.displayName,
      color: this.selfColor || null,
      text,
      badges: {},
      emotes: [],
      self: true,
      id: `local-${Date.now()}-${Math.random()}`,
      ts: Date.now()
    });
    return true;
  }

  _open() {
    if (!this.shouldRun) return;
    this.onStatus({ state: "connecting" });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      // membership → JOIN/PART + NAMES (353) so we can seed @-mention suggestions with
      // lurkers too. Twitch suppresses these for very large channels; we degrade gracefully.
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
      if (!this.anonymous) ws.send(`PASS oauth:${this.token}`);
      ws.send(`NICK ${this.login}`);
      this._startPing();
    };

    ws.onmessage = (e) => {
      const lines = e.data.split("\r\n").filter(Boolean);
      for (const line of lines) this._handleLine(line);
    };

    ws.onclose = () => {
      this._clearPing();
      if (this.ws === ws) this.ws = null;
      if (!this.shouldRun) return;
      this.onStatus({ state: "disconnected" });
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._open();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };

    ws.onerror = () => this.onStatus({ state: "error" });
  }

  _startPing() {
    this._clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === 1) this.ws.send("PING :tmi.twitch.tv");
    }, 4 * 60 * 1000);
  }
  _clearPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  _handleLine(line) {
    if (line.startsWith("PING")) {
      this.ws.send("PONG :tmi.twitch.tv");
      return;
    }
    const parsed = parseIRC(line);
    if (!parsed) return;

    switch (parsed.command) {
      case "001": // welcome
        this.onStatus({ state: "connected" });
        if (this.channel) this.ws.send(`JOIN #${this.channel}`);
        break;
      case "JOIN":
        if (parsed.nick === this.login) this.onStatus({ state: "joined", channel: this.channel });
        else if (parsed.nick) this.onMessage({ type: "join", channel: this.channel, user: parsed.nick, ts: Date.now() });
        break;
      case "353": { // RPL_NAMREPLY — current chatters at join time (membership cap)
        const ch = (parsed.args.find((a) => a.startsWith("#")) || "").replace(/^#/, "");
        const users = (parsed.trailing || "").split(" ").filter(Boolean);
        if (users.length) this.onMessage({ type: "names", channel: ch || this.channel, users, ts: Date.now() });
        break;
      }
      case "NOTICE":
        this.onMessage({ type: "notice", text: parsed.trailing, ts: Date.now() });
        break;
      case "CLEARCHAT":
        this.onMessage({ type: "clearchat", user: parsed.trailing || null, ts: Date.now() });
        break;
      case "CLEARMSG":
        this.onMessage({ type: "clearmsg", targetMsgId: parsed.tags["target-msg-id"], ts: Date.now() });
        break;
      case "ROOMSTATE": {
        // Sent on JOIN; `room-id` is the channel's numeric Twitch user id — lets us
        // load 3rd-party channel emotes without Helix (works in anonymous mode).
        const ch = (parsed.args[0] || "").replace(/^#/, "");
        const roomId = parsed.tags["room-id"];
        if (roomId) this.onMessage({ type: "roomstate", channel: ch, roomId, ts: Date.now() });
        break;
      }
      case "PRIVMSG": {
        const tags = parsed.tags;
        // CTCP /me actions arrive wrapped as "ACTION <text>". Unwrap so the inner
        // text (and its trailing emote) is clean — otherwise the control chars stay in the text
        // and break emote matching (e.g. "FeelsGoodMan" won't match). Twitch's emote-tag
        // offsets are relative to the unwrapped text, so parse emotes after stripping.
        let text = parsed.trailing || "";
        let action = false;
        const SOH = String.fromCharCode(1);
        if (text.startsWith(SOH + "ACTION ") && text.endsWith(SOH)) {
          text = text.slice(8, -1);
          action = true;
        }
        this.onMessage({
          type: "msg",
          id: tags.id,
          user: parsed.nick,
          displayName: tags["display-name"] || parsed.nick,
          color: tags.color || null,
          text,
          action,
          // Channel-points "Highlight My Message" redemptions arrive as a normal PRIVMSG carrying
          // msg-id=highlighted-message — surface it so the overlay can visually mark them.
          highlighted: tags["msg-id"] === "highlighted-message",
          badges: parseBadges(tags.badges),
          emotes: parseEmotes(tags.emotes, text),
          self: false,
          ts: Number(tags["tmi-sent-ts"]) || Date.now()
        });
        break;
      }
      case "GLOBALUSERSTATE":
      case "USERSTATE": {
        const dn = parsed.tags["display-name"];
        if (dn) this.displayName = dn;
        const color = parsed.tags["color"];
        if (color) this.selfColor = color;
        break;
      }
      case "RECONNECT":
        try { this.ws.close(); } catch {}
        break;
    }
  }
}

function parseIRC(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const kv of tagStr.split(";")) {
      const eq = kv.indexOf("=");
      const k = eq === -1 ? kv : kv.slice(0, eq);
      const v = eq === -1 ? "" : kv.slice(eq + 1);
      tags[k] = unescapeTag(v);
    }
  }
  let prefix = null;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailingIdx = rest.indexOf(" :");
  let params = rest;
  let trailing = "";
  if (trailingIdx !== -1) {
    params = rest.slice(0, trailingIdx);
    trailing = rest.slice(trailingIdx + 2);
  }
  const parts = params.split(" ");
  const command = parts[0];
  const args = parts.slice(1);
  const nick = prefix ? prefix.split("!")[0] : null;
  return { tags, prefix, nick, command, args, trailing };
}

function unescapeTag(v) {
  return v
    .replace(/\\:/g, ";")
    .replace(/\\s/g, " ")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function parseBadges(s) {
  if (!s) return {};
  return Object.fromEntries(s.split(",").map(b => b.split("/")));
}

function parseEmotes(s, text) {
  if (!s) return [];
  const out = [];
  const chars = Array.from(text); // unicode-aware
  for (const part of s.split("/")) {
    const [id, ranges] = part.split(":");
    if (!ranges) continue;
    for (const r of ranges.split(",")) {
      const [a, b] = r.split("-").map(Number);
      out.push({ id, start: a, end: b, name: chars.slice(a, b + 1).join("") });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}
