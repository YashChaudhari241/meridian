#!/usr/bin/env bash
# Loads the unpacked extension into Chrome/Brave/Edge and opens chrome://extensions.
# Chrome will not auto-install unpacked extensions; you must click "Load unpacked"
# on first run and select this directory. This script opens that page for you.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="${MERIDIAN_PROFILE_DIR:-$DIR/.chrome-profile}"
mkdir -p "$PROFILE_DIR"

find_browser() {
  case "$(uname -s)" in
    Darwin)
      for app in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
        [ -x "$app" ] && { echo "$app"; return; }
      done
      ;;
    Linux)
      for b in google-chrome chrome chromium brave-browser microsoft-edge; do
        command -v "$b" >/dev/null 2>&1 && { command -v "$b"; return; }
      done
      ;;
  esac
  return 1
}

BROWSER="$(find_browser || true)"
if [ -z "${BROWSER:-}" ]; then
  echo "Could not find Chrome/Brave/Edge. Open chrome://extensions, enable Developer Mode,"
  echo "click 'Load unpacked', and select: $DIR"
  exit 0
fi

echo "Launching: $BROWSER"
echo "Profile:   $PROFILE_DIR"
echo "Extension: $DIR"
echo
echo "If this is the first run: on the opened chrome://extensions page, enable"
echo "Developer Mode (top-right) and click 'Load unpacked', selecting:"
echo "  $DIR"

exec "$BROWSER" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$DIR" \
  "chrome://extensions" \
  "https://www.youtube.com"
