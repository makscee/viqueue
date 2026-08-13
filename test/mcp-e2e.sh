#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >/dev/null
work="$(mktemp -d)"
port="$((20000 + RANDOM % 20000))"
VIQ_TAKEOVER_TOKEN=secret node dist/src/server.js --port="$port" --storage="$work/data.json" >"$work/server.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
base="http://127.0.0.1:$port"
for _ in $(seq 1 100); do curl -sf "$base/health" >/dev/null && break; sleep 0.02; done
curl -sf "$base/health" >/dev/null
viq=(node dist/bin/viq.js --server "$base" --json)
out="${VIQ_EVIDENCE_DIR:-evidence}/mcp-e2e-output.txt"
: >"$out"

record_viq() { printf '$ viq' >>"$out"; printf ' %q' "$@" >>"$out"; printf '\n' >>"$out"; "${viq[@]}" "$@" >>"$out" 2>&1; }
record_mcp() {
  printf '$ mcp' >>"$out"; printf ' %q' "$@" >>"$out"; printf '\n' >>"$out"
  VIQ_SERVER="$base" VIQ_TAKEOVER_TOKEN=secret node test/mcp-e2e-client.js "$@" >>"$out" 2>&1
}

record_mcp create
record_mcp ticket-create
record_viq ticket next --actor worker-a
record_viq ticket claim ABC-1 --actor worker-a --ttl-ms 1000
old_token="$(sed -n '8p' "$out" | jq -r .claim_token)"
record_mcp renew worker-a "$old_token" 1 100
sleep 0.12
record_viq ticket next --actor worker-b
record_mcp get
record_mcp takeover worker-b 60000
new_token="$(sed -n '16p' "$out" | jq -r .structuredContent.claim_token)"
set +e
record_viq ticket submit ABC-1 --actor worker-a --claim-token "$old_token" --generation 1 --evidence old
fenced_status=$?
set -e
printf 'exit=%s\n' "$fenced_status" >>"$out"
test "$fenced_status" -eq 3
record_mcp submit worker-b "$new_token" 2 '{"parity":"green"}'
printf 'MCP_E2E_OK\n' >>"$out"
cat "$out"
