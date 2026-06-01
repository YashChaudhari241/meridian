// Twitch auth via the user's existing twitch.tv login cookie, with an anonymous
// (read-only) fallback. No client id, no OAuth dance.
//
// Modes (stored in chrome.storage.local.meridian.authMode, default "auto"):
//   "auto"      → cookie if available, else anonymous
//   "cookie"    → cookie or anonymous
//   "anonymous" → always anonymous

const MODE_KEY = "meridian.authMode";
const TWITCH_COOKIE_URL = "https://www.twitch.tv";
const TWITCH_COOKIE_NAME = "auth-token";

async function getMode() {
  const o = await chrome.storage.local.get(MODE_KEY);
  return o[MODE_KEY] || "auto";
}
async function setMode(mode) {
  await chrome.storage.local.set({ [MODE_KEY]: mode });
}

async function validateToken(token) {
  const r = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` }
  });
  if (!r.ok) return null;
  return r.json(); // { login, user_id, expires_in, scopes, client_id }
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

async function getCookieAuth() {
  let cookie;
  try {
    cookie = await chrome.cookies.get({ url: TWITCH_COOKIE_URL, name: TWITCH_COOKIE_NAME });
  } catch { return null; }
  if (!cookie?.value) return null;
  const info = await validateToken(cookie.value);
  if (!info) return null;
  const displayName = await fetchDisplayName(cookie.value, info.client_id, info.login);
  return {
    kind: "cookie",
    accessToken: cookie.value,
    login: info.login,
    displayName,
    userId: info.user_id,
    scopes: info.scopes,
    clientId: info.client_id,
    expiresAt: Date.now() + (info.expires_in - 60) * 1000
  };
}

function anonymousAuth() {
  const n = Math.floor(Math.random() * 90000) + 10000;
  return { kind: "anonymous", accessToken: null, login: `justinfan${n}` };
}

async function resolveAuth() {
  const mode = await getMode();
  if (mode === "anonymous") return anonymousAuth();
  const cookie = await getCookieAuth();
  if (cookie) return cookie;
  return anonymousAuth();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "AUTH_GET":
          sendResponse({ ok: true, auth: await resolveAuth() });
          return;
        case "MODE_GET":
          sendResponse({ ok: true, mode: await getMode() });
          return;
        case "MODE_SET":
          await setMode(msg.mode);
          sendResponse({ ok: true });
          return;
        case "AUTH_STATUS": {
          const mode = await getMode();
          const cookie = await getCookieAuth();
          sendResponse({
            ok: true,
            mode,
            cookieAvailable: Boolean(cookie),
            cookieLogin: cookie?.login || null
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

chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie?.domain?.endsWith("twitch.tv") && info.cookie.name === TWITCH_COOKIE_NAME) {
    chrome.storage.local.set({ "meridian.cookieRev": Date.now() });
  }
});
