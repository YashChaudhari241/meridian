// Single source of truth for the seeded default channel mappings (YouTube handle / Kick slug →
// Twitch login). Imported by BOTH the content script (dynamic import) and the popup (static import)
// so there is exactly one place to edit. Keys are the lower-cased handle/slug, values the Twitch login.
export const DEFAULT_MAPPINGS = {
  eslcs: "eslcs",
  pgl: "pgl",
  blastpremier: "blastpremier",
  starladder_cs: "starladder_cs_en",
  valorantesports: "valorant",
  tenz: "tenz",
  ohnepixel: "ohnepixel"
};
export const DEFAULT_KICK_MAPPINGS = {
  eslcs: "eslcs",
  pgl: "pgl",
  pglcs2: "pglcs2",
  starladder: "starladder_cs_en"
};
