// Twitch application Client ID for the official OAuth flow.
//
// Meridian links to Twitch through Twitch's sanctioned OAuth (chrome.identity.launchWebAuthFlow),
// NOT by reading twitch.tv cookies. To enable "Connect Twitch":
//   1. Register an application at https://dev.twitch.tv/console/apps
//   2. Add the OAuth Redirect URL shown in the popup's General tab
//      (it looks like https://<your-extension-id>.chromiumapp.org/)
//   3. Paste the application's Client ID below.
//
// Left blank, Meridian still works fully in anonymous read-only mode — "Connect Twitch" is the
// only thing that needs it.
export const TWITCH_CLIENT_ID = "pp5dd6catioplhn0m9jku3udf38zbj";

// Scopes requested when connecting: read chat + send chat messages.
export const TWITCH_SCOPES = ["chat:read", "chat:edit"];
