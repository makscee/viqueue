#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_EVIDENCE_DIR:?VIQ_EVIDENCE_DIR is required}"
mkdir -p "$VIQ_EVIDENCE_DIR"
controller_root=${TMPDIR:-/tmp}
controller_tmp=$(mktemp -d "$controller_root/viq-e2e-controller.XXXXXX")
trap 'rm -rf "$controller_tmp"' EXIT
export TMPDIR="$controller_tmp"
export VIQ_EVIDENCE_DIR
bash test/e2e-failure-diagnostics.sh
bash test/e2e.sh
node test/browser-human-journey-e2e.js
node test/browser-e2e.js
