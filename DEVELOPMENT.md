# Meridian — Developer Guide

Setup, Twitch OAuth configuration, and debugging for working on Meridian. For the feature overview see [README.md](./README.md); for architecture notes see [CLAUDE.md](./CLAUDE.md).

---

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open a YouTube livestream or Kick channel — the overlay appears (read-only until you connect Twitch).

`setup.sh` launches a separate browser profile with the extension preloaded for testing.

The extension ID is pinned by the `key` field in `manifest.json`, so it stays constant across machines and reloads.

---

## Connecting Twitch (to send chat)

Meridian links accounts through Twitch's official OAuth flow (`chrome.identity.launchWebAuthFlow`) — it never reads cookies.

1. Register an app at **[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)**.
2. Set the **OAuth Redirect URL** to exactly (trailing slash included — Twitch matches it exactly):
   ```
   https://gfhjdkpmadgolegdcgpoboaanlfacklo.chromiumapp.org/
   ```
   This is the redirect for this repo's pinned extension ID. The popup's **General** tab always prints the live value — confirm it matches.
3. Copy the app's **Client ID** into `src/config.js` (`TWITCH_CLIENT_ID`).
4. Reload the extension, open the popup, and click **Connect Twitch**. **Disconnect** deletes the stored token.

### Stable extension ID

`manifest.json` ships a `key` (public key) so the extension ID — and therefore the redirect URL above — never changes. The matching private key (`meridian-key.pem`) is gitignored; keep it only if you plan to self-distribute a signed `.crx`. Losing it just means generating a new keypair (the ID changes).

### Publishing to the Chrome Web Store

The Store assigns its **own** signing key and a **different, permanent ID**, so the published redirect URL differs from the dev one. Either:

- Register both `https://<store-id>.chromiumapp.org/` and the dev URL on your Twitch app (Twitch allows multiple redirect URLs), **or**
- After the first upload, copy the Store-generated public key into your local `manifest.json` `key` so dev and published IDs match.

`TWITCH_CLIENT_ID` stays the same either way — only the redirect-URL list on the Twitch app needs the extra entry.

---

## Debugging

Chrome 137+ restricts `--load-extension`, so use **Brave** for live debugging:

```bash
bash debug/launch.sh [url]                                  # Brave + unpacked extension + remote debugging on :9344
CDP_PORT=9344 node debug/eval.mjs '<expr>'                  # evaluate in the YouTube tab
CDP_TARGET=sw CDP_PORT=9344 node debug/eval.mjs '<expr>'    # target the service worker
```

Set prefs by opening the popup page as a target and calling `chrome.storage.local.set` there. Don't use `chrome.runtime.reload()` to pick up code changes (it kills the unpacked extension) — relaunch the browser instead.

### Performance / overhead

```bash
CDP_PORT=9344 node debug/perf.mjs [durationSec=30] [intervalSec=2] [--label name]
```

Samples main-thread CPU, JS heap, DOM size, FPS, and layout/style churn per tick and prints a summary. It's whole-page (YouTube + extension), so to attribute overhead to Meridian, run it twice — once with the extension enabled, once disabled (popup → General → Extension enabled) — and compare. A burst of `layouts/s` in the first ~10 s after a reload indicates layout thrash. GPU isn't exposed over CDP — use `chrome://gpu` and the browser's **Task Manager** (Window → Task Manager) for per-process GPU/CPU.

---

## License

MIT License.
