// Twitch auth via the official OAuth flow (chrome.identity.launchWebAuthFlow), with an anonymous
// (read-only) fallback. We never read twitch.tv cookies — that would violate Twitch's Developer
// Services Agreement. The user explicitly connects their account; the resulting token is stored in
// chrome.storage.local and used as `oauth:<token>` for IRC.
//
// Default behavior: anonymous read-only until the user clicks "Connect Twitch" in the popup.

import { TWITCH_CLIENT_ID, TWITCH_SCOPES } from "./config.js";

const AUTH_KEY = "meridian.oauth"; // stored connected-account token + profile

async function getStoredAuth() {
  const o = await chrome.storage.local.get(AUTH_KEY);
  return o[AUTH_KEY] || null;
}
async function setStoredAuth(a) { await chrome.storage.local.set({ [AUTH_KEY]: a }); }
async function clearStoredAuth() { await chrome.storage.local.remove(AUTH_KEY); }

async function validateToken(token) {
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${token}` }
    });
    if (!r.ok) return null;
    return r.json(); // { login, user_id, expires_in, scopes, client_id }
  } catch { return null; }
}

async function fetchDisplayName(token, clientId, fallbackLogin) {
  try {
    const r = await fetch("https://api.twitch.tv/helix/users", {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId }
    });
    if (!r.ok) return fallbackLogin;
    const j = await r.json();
    return j.data?.[0]?.display_name || fallbackLogin;
  } catch { return fallbackLogin; }
}

function anonymousAuth() {
  const n = Math.floor(Math.random() * 90000) + 10000;
  return { kind: "anonymous", accessToken: null, login: `justinfan${n}` };
}

// Interactive connect: pop the Twitch consent screen and capture the token from the redirect.
async function connectInteractive() {
  if (!TWITCH_CLIENT_ID) {
    throw new Error("Set TWITCH_CLIENT_ID in src/config.js (register an app at dev.twitch.tv).");
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const authUrl = "https://id.twitch.tv/oauth2/authorize"
    + "?response_type=token"
    + `&client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent(TWITCH_SCOPES.join(" "))}`
    + `&state=${encodeURIComponent(state)}`
    + "&force_verify=true";

  const redirectResponse = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  // Token comes back in the URL fragment: #access_token=...&scope=...&state=...
  const hash = new URL(redirectResponse).hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  if (params.get("state") !== state) throw new Error("OAuth state mismatch — try again.");
  const token = params.get("access_token");
  if (!token) throw new Error(params.get("error_description") || "No access token returned.");
  const info = await validateToken(token);
  if (!info) throw new Error("Twitch rejected the token.");
  const displayName = await fetchDisplayName(token, info.client_id, info.login);
  const auth = {
    kind: "oauth",
    accessToken: token,
    login: info.login,
    displayName,
    userId: info.user_id,
    scopes: info.scopes,
    clientId: info.client_id,
    expiresAt: Date.now() + (info.expires_in - 60) * 1000
  };
  await setStoredAuth(auth);
  return auth;
}

// Resolve the auth used for IRC: the connected account if its token still validates, else anonymous.
async function resolveAuth() {
  const stored = await getStoredAuth();
  if (stored?.accessToken) {
    const info = await validateToken(stored.accessToken);
    if (info) return stored;
    await clearStoredAuth(); // expired / revoked → fall back to read-only
  }
  return anonymousAuth();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "AUTH_GET":
          sendResponse({ ok: true, auth: await resolveAuth() });
          return;
        case "AUTH_CONNECT": {
          const auth = await connectInteractive();
          sendResponse({ ok: true, auth });
          return;
        }
        case "AUTH_DISCONNECT":
          await clearStoredAuth();
          sendResponse({ ok: true });
          return;
        case "STREAM_INFO": {
          // Live viewer count via Helix Get Streams. Done here (not the content script) so it uses
          // the extension's host permission for api.twitch.tv and the stored OAuth token.
          const login = String(msg.login || "").toLowerCase();
          const stored = await getStoredAuth();
          if (!login || !stored?.accessToken || !stored?.clientId) { sendResponse({ ok: false }); return; }
          try {
            const r = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, {
              headers: { Authorization: `Bearer ${stored.accessToken}`, "Client-Id": stored.clientId }
            });
            const j = await r.json();
            const s = j?.data?.[0];
            sendResponse({ ok: true, live: !!s, viewers: s?.viewer_count ?? null });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          return;
        }
        case "AUTH_STATUS": {
          const stored = await getStoredAuth();
          const connected = Boolean(stored?.accessToken);
          sendResponse({
            ok: true,
            connected,
            login: connected ? stored.login : null,
            displayName: connected ? (stored.displayName || stored.login) : null,
            clientIdSet: Boolean(TWITCH_CLIENT_ID),
            redirectUri: chrome.identity.getRedirectURL()
          });
          return;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
