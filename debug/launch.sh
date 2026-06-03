#!/usr/bin/env bash
# Launch Chrome with the Meridian extension loaded + remote debugging, for CDP-driven debugging.
# Usage: debug/launch.sh [url]   (then drive it with debug/eval.mjs)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${MERIDIAN_DEBUG_PROFILE:-$DIR/.debug-profile}"
PORT="${CDP_PORT:-9222}"
URL="${1:-https://www.youtube.com/watch?v=X7oISE-2jbw}"
mkdir -p "$PROFILE"
# Prefer Brave: Chrome 137+ neuters --load-extension (it silently doesn't load unpacked exts),
# whereas Brave still honours it. Override with $MERIDIAN_BROWSER.
BROWSER="${MERIDIAN_BROWSER:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"
[ -x "$BROWSER" ] || BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
echo "Launching $BROWSER  (CDP :$PORT, ext: $DIR)"
exec "$BROWSER" \
  --user-data-dir="$PROFILE" \
  --load-extension="$DIR" \
  --disable-extensions-except="$DIR" \
  --remote-debugging-port="$PORT" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  --no-first-run --no-default-browser-check \
  "$URL"
