#!/bin/bash
# Installs Encore:
#   - the server + web UI into ~/Library/Application Support/Encore
#   - the launcher app at ~/Applications/Encore.app
# Safe to re-run to update: runtime state (Google client, sign-in tokens,
# logs) lives alongside the code in that folder and is left untouched.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
support="$HOME/Library/Application Support/Encore"
app="$HOME/Applications/Encore.app"

if ! command -v node >/dev/null 2>&1; then
  echo "Encore needs Node.js 18+ (brew install node)." >&2
  exit 1
fi

mkdir -p "$support"
cp "$here/server.js" "$here/package.json" "$support/"
rsync -a --delete "$here/static/" "$support/static/"

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/app/Info.plist" "$app/Contents/Info.plist"
cp "$here/app/launcher" "$app/Contents/MacOS/launcher"
chmod +x "$app/Contents/MacOS/launcher"
cp "$here/app/icon.icns" "$app/Contents/Resources/icon.icns"
# Ad-hoc signature so macOS keeps a stable identity for the app across updates.
codesign --force --sign - "$app" >/dev/null 2>&1 || true

# An already-running old server would keep serving old code, so restart it
# (only if it was running) rather than leaving an open Encore window stranded.
if pids="$(lsof -tiTCP:8812 -sTCP:LISTEN 2>/dev/null)" && [ -n "$pids" ]; then
  kill $pids
  sleep 0.5
  (cd "$support" && nohup "$(command -v node)" server.js >> server.log 2>&1 & echo $! > server.pid)
  echo "Restarted the running Encore server on the new version."
fi

echo "Installed. Open Encore from ~/Applications."
