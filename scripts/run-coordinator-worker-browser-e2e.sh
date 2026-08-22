#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${TMPDIR:?set TMPDIR to an explicit external temp root (not /tmp)}"
: "${VIQ_WORKER_TMPDIR:?set VIQ_WORKER_TMPDIR to an explicit viq-worker-traversable external temp root}"
[[ $TMPDIR == /* && $VIQ_WORKER_TMPDIR == /* ]] || { echo 'absolute external temp roots required' >&2; exit 64; }
[[ $TMPDIR != /tmp && $TMPDIR != /tmp/* && $VIQ_WORKER_TMPDIR != /tmp && $VIQ_WORKER_TMPDIR != /tmp/* ]] || { echo '/tmp is not permitted for this proof' >&2; exit 64; }
install -d -m 0700 "$TMPDIR"
install -d -m 0755 "$VIQ_WORKER_TMPDIR"
export npm_config_cache=${npm_config_cache:-$TMPDIR/npm-cache}
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$TMPDIR/playwright-browsers}
mkdir -p "$npm_config_cache" "$PLAYWRIGHT_BROWSERS_PATH"
# package-lock.json pins Playwright 1.62.1; its local CLI pins the matching
# Chromium revision. Never use a network-resolved npx fallback.
npm ci --ignore-scripts
./node_modules/.bin/playwright install chromium
node test/coordinator-worker-browser-e2e.js
