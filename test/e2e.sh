#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
work="$(mktemp -d)"; port="$((20000 + RANDOM % 20000))"; storage="$work/data.sqlite"
node --input-type=module - "$storage" "$work/credentials.json" <<'NODE'
import { Store } from './dist/src/store.js';
import { writeFileSync } from 'node:fs';
const [storage,file]=process.argv.slice(2),store=new Store(storage);await store.init();
const coordinator=await store.bootstrapCoordinator({id:'maks',name:'Maks'});
const code=await store.createPairingCode('maks',{intended_kind:'worker'});
const worker=await store.pairDevice({code:code.code,id:'worker-a',name:'Worker A'});
await store.close();writeFileSync(file,JSON.stringify({coordinator:coordinator.credential,worker:worker.credential}),{mode:0o600});
NODE
node dist/src/server.js --port="$port" --storage="$storage" >"$work/server.log" 2>&1 & pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
base="http://127.0.0.1:$port"; for _ in $(seq 1 100); do curl -sf "$base/health" >/dev/null && break; sleep .02; done
coordinator="$(node -pe "JSON.parse(require('fs').readFileSync(process.argv[1])).coordinator" "$work/credentials.json")"
worker="$(node -pe "JSON.parse(require('fs').readFileSync(process.argv[1])).worker" "$work/credentials.json")"
viq=(node dist/bin/viq.js); evidence="${VIQ_EVIDENCE_DIR:-$work/evidence}"; mkdir -p "$evidence"; out="$evidence/e2e-output.txt"; : >"$out"
trap 'status=$?; cat "$out"; exit "$status"' ERR
run(){ local credential=$1; shift; printf '$ viq'; local redact=0 arg; for arg in "$@"; do if ((redact)); then printf ' %q' '[REDACTED]'; redact=0; else printf ' %q' "$arg"; [[ "$arg" == --claim-token ]] && redact=1; fi; done; printf '\n'; VIQ_DEVICE_TOKEN="$credential" "${viq[@]}" "$@" --server "$base"; }
{
  run "$coordinator" project create ABC
  run "$coordinator" ticket create ABC tracer --assignment Agent
  session_capability="$(curl -sf -X POST -H "Authorization: Bearer $worker" -H 'Content-Type: application/json' --data '{}' "$base/v1/sessions" | jq -r .session_capability)"
  claim="$(VIQ_DEVICE_TOKEN="$worker" VIQ_SESSION_CAPABILITY="$session_capability" "${viq[@]}" ticket claim-next --server "$base")"
  jq 'del(.claim_token)' <<<"$claim"
  cid="$(jq -r .ticket.claim.claim_id<<<"$claim")"; token="$(jq -r .claim_token<<<"$claim")"
  VIQ_SESSION_CAPABILITY="$session_capability" run "$worker" ticket submit ABC-1 --claim-id "$cid" --claim-token "$token" --generation 1 --reviewer maks --message complete
  run "$coordinator" ticket accept ABC-1 --message accepted
  echo E2E_OK
} >"$out" 2>&1
cat "$out"
