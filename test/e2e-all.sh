#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_EVIDENCE_DIR:?VIQ_EVIDENCE_DIR is required}"
mkdir -p "$VIQ_EVIDENCE_DIR"
controller_root=${TMPDIR:-/tmp}
worker_root=${VIQ_WORKER_TMPDIR:-/var/tmp}
controller_tmp=$(mktemp -d "$controller_root/viq-e2e-controller.XXXXXX")
worker_tmp=$(mktemp -d "$worker_root/viq-e2e-worker.XXXXXX")
trap 'rm -rf "$controller_tmp" "$worker_tmp"' EXIT
chmod 0755 "$worker_tmp"
export TMPDIR="$controller_tmp"
export VIQ_WORKER_TMPDIR="$worker_tmp"
if [[ $(id -u) -ne 0 ]]; then export VIQ_WORKER_USER="${VIQ_WORKER_USER:-$(id -un)}"; fi
export VIQ_EVIDENCE_DIR
bash test/e2e-failure-diagnostics.sh
bash test/e2e.sh
node test/browser-human-journey-e2e.js
node test/browser-e2e.js
node test/coordinator-worker-browser-e2e.js
