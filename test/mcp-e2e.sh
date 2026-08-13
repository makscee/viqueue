#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."; npm run build >/dev/null
work="$(mktemp -d)"; port="$((20000 + RANDOM % 20000))"; VIQ_OPERATOR_TOKEN=secret node dist/src/server.js --port="$port" --storage="$work/data.sqlite" >"$work/server.log" 2>&1 & pid=$!; trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
base="http://127.0.0.1:$port"; for _ in $(seq 1 100); do curl -sf "$base/health" >/dev/null && break; sleep .02; done
curl -sf -X POST "$base/v1/actors" -H 'content-type: application/json' -H 'authorization: Bearer secret' --data '{"id":"worker","name":"Worker","kind":"agent"}' >/dev/null
out="${VIQ_EVIDENCE_DIR:-evidence}/mcp-e2e-output.txt"; : >"$out"; run(){ VIQ_SERVER="$base" VIQ_OPERATOR_TOKEN=secret node test/mcp-e2e-client.js "$@"; }
{ run actor-create; run role-create; run role-grant; run create; run ticket-create; run claim | jq 'del(.structuredContent.claim_token) | (.content[0].text = "[claim response redacted]")'; run inbox; run events; echo MCP_E2E_OK; } >"$out" 2>&1; cat "$out"
