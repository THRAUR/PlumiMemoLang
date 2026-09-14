#!/usr/bin/env bash
# Boots a throwaway server with seeded data and screenshots every screen at
# phone and desktop widths, printing any browser console errors.
#   scripts/qa.sh [port] [outdir]
set -u
PORT=${1:-3098}
OUT=${2:-/tmp/pml-qa}
DIR=$(mktemp -d /tmp/pml-qa-data.XXXX)
CH=${CHROME:-$HOME/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell}
cd "$(dirname "$0")/.."
mkdir -p "$OUT"
MEMOLANG_PORT=$PORT DATA_DIR=$DIR node server/index.js > "$DIR/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
sleep 1.5
node scripts/seed.mjs "http://127.0.0.1:$PORT" || echo "seed failed (routes missing?)"
for route in welcome today lessons review words challenge notes settings; do
  # 375x812 is the smallest phone the learner might use; 390x1400 shows more of a
  # long screen in one shot; 1200x1100 is the laptop rail layout.
  for spec in "375,812,s" "390,1400,m" "1200,1100,d"; do
    IFS=, read w h tag <<< "$spec"
    log="$OUT/$route-$tag.log"
    timeout 45 "$CH" --headless --disable-gpu --no-sandbox --hide-scrollbars --window-size=$w,$h \
      --enable-logging=stderr --v=0 --virtual-time-budget=6000 \
      --screenshot="$OUT/$route-$tag.png" "http://127.0.0.1:$PORT/#/$route" > "$log" 2>&1
    errs=$(grep -iE 'CONSOLE.*(error|uncaught|failed|TypeError|ReferenceError)' "$log" | grep -v 'favicon' | head -5)
    if [ -n "$errs" ]; then echo "!! $route ($tag):"; echo "$errs"; else echo "ok $route ($tag)"; fi
  done
done
echo "screenshots in $OUT · server log $DIR/server.log"
