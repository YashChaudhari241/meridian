# Meridian — Twitch Chat Overlay for YouTube & Kick

A Chrome extension that overlays a live **Twitch chat** on top of **YouTube** and **Kick** video pages. Built for watching tournament re-broadcasts, esports streams, and co-streams where the conversation you actually want is happening in a Twitch channel.

Runs entirely in your browser — no backend, no tracking, no account required to read.

> Developers: see [DEVELOPMENT.md](./DEVELOPMENT.md) for install, Twitch setup, and debugging.

---

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save your preferences and a 24 h emote cache. |
| `identity` | Run Twitch's official OAuth flow when you click **Connect Twitch** (no cookies read). |
| `activeTab` | Let the popup read the current tab's host to show per-site settings. |
| Host: `youtube.com`, `kick.com` | Inject the overlay on watch / channel pages. |
| Host: `*.twitch.tv`, `id.twitch.tv`, `api.twitch.tv` | Validate the OAuth token, fetch your display name, connect to chat. |
| Host: `7tv.io`, `betterttv.net`, `frankerfacez.com` | Fetch public emote sets. |

See [PRIVACY.md](./PRIVACY.md) for the full data-handling policy.

---

## Features

### Overlay & display
- **Transparent, draggable, resizable** chat panel that you can place anywhere.
- **Three display modes, saved per site:**
  - **Overlay** — floating panel over the video.
  - **Docked** — an opaque panel embedded inside the site's native chat frame, with a **`[Site | Twitch]` tab switcher** so you can flip between the site's chat and Twitch chat. Survives theater and fullscreen.
  - **Auto** — overlay in fullscreen, docked otherwise.

### Chat
- **Live Twitch IRC**: badges, colors, `/me` actions, and case-correct display names.
- **Native Twitch emotes** plus **7TV / BetterTTV / FrankerFaceZ** (global **and** channel sets, each provider toggleable).
- **Emote & @-mention autocomplete** — prefix matching, Tab/Enter to complete; typed emotes become inline image chips.
- **Chat delay** (0–600 s) to sync chat with a delayed stream.
- **Render batching** to keep very fast channels smooth.
- **Blocklist** (hide messages by word) and **hide-deleted-messages** (remove moderated lines instead of dimming them).
- **Send messages** once you connect your Twitch account.

### Timeline highlights (YouTube livestreams)
- **Chat-activity wave** — a YouTube "most-replayed"-style density wave drawn over the live seekbar, scaled to chat messages-per-second. Resolution adapts to stream length.
- **Emote surge markers** — when enough unique viewers spam one emote in a short window, the emote is perched on the wave at that moment. **Click to seek** straight to it.
  
### Channels
- **Auto-detects** the YouTube channel handle / Kick slug and joins the mapped Twitch channel.
- **Channel mappings editor** (`handle = twitch_channel`), seeded with common esports channels (ESL, PGL, BLAST, StarLadder, Valorant, etc.).
- **Per-page override** — type any Twitch channel directly in the overlay header.

### Account & privacy
- **Anonymous read-only by default** — no login needed to watch chat.
- **Connect Twitch** through the official OAuth flow to send messages. **No cookies are ever read.** The token is stored locally and removable with one click.

### Appearance
- Background color, background blur (+ radius), panel drop shadow, panel outline.
- Text legibility: none / drop-shadow / outline, plus a bold-text toggle.
- Opacity and font-size controls.

### Hotkeys
- **Toggle visibility** and **focus input**, both configurable.

---

## License

MIT License.
