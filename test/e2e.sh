#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >/dev/null
work="$(mktemp -d)"
port="$((20000 + RANDOM % 20000))"
server_log="$work/server.log"
VIQ_TAKEOVER_TOKEN=secret node dist/src/server.js --port="$port" --storage="$work/data.json" >"$server_log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
base="http://127.0.0.1:$port"
for _ in $(seq 1 100); do curl -sf "$base/health" >/dev/null && break; sleep 0.02; done
curl -sf "$base/health" >/dev/null
viq=(node dist/bin/viq.js --server "$base" --json)
out="${VIQ_EVIDENCE_DIR:-evidence}/e2e-output.txt"
: >"$out"
record_viq() { printf '$ viq' >>"$out"; printf ' %q' "$@" >>"$out"; printf '\n' >>"$out"; "${viq[@]}" "$@" >>"$out" 2>&1; }

record_viq project create ABC
record_viq ticket create ABC "phase zero tracer"
record_viq ticket next --actor worker-a
record_viq ticket claim ABC-1 --actor worker-a --ttl-ms 1
sleep 0.02
record_viq ticket next --actor worker-b
record_viq ticket show ABC-1
record_viq ticket takeover ABC-1 --actor worker-b --ttl-ms 60000 --auth secret

old_token="$(sed -n '8p' "$out" | jq -r .claim_token)"
new_token="$(sed -n '14p' "$out" | jq -r .claim_token)"
set +e
record_viq ticket submit ABC-1 --actor worker-a --claim-token "$old_token" --generation 1 --evidence old
fenced_status=$?
set -e
printf 'exit=%s\n' "$fenced_status" >>"$out"
test "$fenced_status" -eq 3
record_viq ticket submit ABC-1 --actor worker-b --claim-token "$new_token" --generation 2 --evidence '{"tests":"green"}'

printf 'E2E_OK\n' >>"$out"
cat "$out"
