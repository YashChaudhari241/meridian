# Meridian — Twitch Chat Overlay for YouTube

A Chrome MV3 extension that puts a draggable, transparent Twitch chat overlay on top of YouTube videos. Useful for watching tournament re-broadcasts, esports VODs, or any YouTube channel that has a corresponding Twitch chat you'd rather follow live than read after the fact.

## Features

- Transparent, draggable, resizable chat overlay anchored to the YouTube player (or fixed on the page).
- Auto-detects the video's channel handle and joins the mapped Twitch channel.
- Live Twitch IRC: badges, native emotes, plus 7TV / BetterTTV / FrankerFaceZ emotes (global + channel sets).
- Chat input with emote autocomplete, optional client-side delay, blocklist, hide-deleted-messages.
- Auth uses your existing twitch.tv login cookie — no app registration, no OAuth flow. Anonymous read-only mode if you're not logged in.
- Configurable hotkeys for toggling the overlay and focusing the chat input.
- Appearance: opacity, blur, blur radius, drop shadow, font size.

## Install (unpacked, for development)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Log into `twitch.tv` in the same browser profile to chat as your account; otherwise the overlay is read-only.

The `setup.sh` script launches a separate Chrome profile with the extension preloaded for testing.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save your preferences and a 24h emote cache. |
| `cookies` (twitch.tv only) | Read the existing `auth-token` cookie so you can chat as your Twitch account without re-logging in. |
| Host: `youtube.com` | Inject the overlay on watch pages. |
| Host: `*.twitch.tv`, `id.twitch.tv`, `api.twitch.tv` | Validate the token, fetch your display name, connect to chat. |
| Host: `7tv.io`, `betterttv.net`, `frankerfacez.com` | Fetch public emote sets. |

See [PRIVACY.md](./PRIVACY.md) for the full data handling policy.

## License

MIT — do whatever you like with it.
