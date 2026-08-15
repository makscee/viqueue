#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_EVIDENCE_DIR:?VIQ_EVIDENCE_DIR is required}"
mkdir -p "$VIQ_EVIDENCE_DIR"
export VIQ_EVIDENCE_DIR
bash test/e2e.sh
bash test/mcp-e2e.sh
node test/browser-e2e.js
node test/phone-auth-e2e.js
