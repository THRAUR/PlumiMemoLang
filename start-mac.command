#!/bin/bash
# Double-click to start PlumiMemoLang on a Mac. The first time, it installs what the
# app needs; then it starts the app and opens it in your browser. Close this window
# (or press Ctrl+C) to stop the app. Your data stays in the data folder next to it.
cd "$(dirname "$0")" || exit 1

pause() { read -r -p "Press Enter to close this window. " _; }

need_node() {
  echo "Install the LTS version from https://nodejs.org, then double-click this file again."
  open "https://nodejs.org/en/download" 2>/dev/null
  pause
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "PlumiMemoLang needs Node.js 22.12 or newer, and Node.js is not installed."
  need_node
fi
if ! node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)"; then
  echo "PlumiMemoLang needs Node.js 22.12 or newer. This Mac has $(node -v)."
  need_node
fi

if [ ! -d node_modules ]; then
  echo "First start: installing what the app needs…"
  npm install --omit=dev || { pause; exit 1; }
fi

echo "Starting PlumiMemoLang. Close this window (or press Ctrl+C) to stop it."
npm run launch
pause
