#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_EVIDENCE_DIR:?VIQ_EVIDENCE_DIR is required}"
mkdir -p "$VIQ_EVIDENCE_DIR"
suite_tmp=$(mktemp -d)
trap 'rm -rf "$suite_tmp"' EXIT
mkdir "$suite_tmp/controller" "$suite_tmp/worker"
chmod 0755 "$suite_tmp" "$suite_tmp/worker"
export TMPDIR="$suite_tmp/controller"
export VIQ_WORKER_TMPDIR="$suite_tmp/worker"
if [[ $(id -u) -ne 0 ]]; then export VIQ_WORKER_USER="${VIQ_WORKER_USER:-$(id -un)}"; fi
export VIQ_EVIDENCE_DIR
bash test/e2e.sh
node test/browser-e2e.js
node test/coordinator-worker-browser-e2e.js
