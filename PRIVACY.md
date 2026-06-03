# Meridian — Privacy Policy

_Last updated: 2026-06-02_

Meridian is a browser extension that overlays Twitch chat on YouTube watch pages. It runs entirely in your browser. **It has no backend servers and does not collect, transmit, or sell any personal data.**

## What the extension reads

- **A Twitch OAuth token (only if you click "Connect Twitch").** Meridian links your account through Twitch's official OAuth flow (`chrome.identity.launchWebAuthFlow`) — it does **not** read any cookies. The resulting access token is stored locally in your browser and sent **only** to Twitch's own servers (`id.twitch.tv` for validation, `api.twitch.tv` for your display name, and `irc-ws.chat.twitch.tv` for chat connection). It is never sent to any third party or to the extension author. Click "Disconnect" to delete it.
- **Your YouTube channel-handle → Twitch channel mappings** that you enter in the extension's settings.
- **The current YouTube video's channel handle** (e.g. `@SomeChannel`), read from the page's DOM to look up the corresponding Twitch channel from your mappings.

## What the extension stores (locally, in your browser)

All stored via `chrome.storage.local`:

- Your preferences (overlay position/size, opacity, font size, mappings, hotkeys, blocked words, etc.).
- A 24-hour cache of public emote metadata from 7TV, BetterTTV, and FrankerFaceZ.

Nothing is uploaded anywhere. Clearing the extension or your browser data removes all of it.

## Network requests Meridian makes

- `id.twitch.tv` — the OAuth consent screen and validating the access token.
- `api.twitch.tv` — fetch your Twitch display name and resolve channel user-ids.
- `irc-ws.chat.twitch.tv` — connect to Twitch IRC chat (anonymous if not logged in).
- `7tv.io`, `api.betterttv.net`, `cdn.betterttv.net`, `api.frankerfacez.com` — fetch public emote sets for the channel you are watching.

Meridian does **not** contact any servers operated by the extension's author.

## Anonymous mode

By default — until you click "Connect Twitch" — the extension connects to Twitch IRC as an anonymous reader. You will be able to view chat but not send messages. No account data is read in this mode.

## Contact

Issues and questions: file an issue on the project's GitHub repository.
