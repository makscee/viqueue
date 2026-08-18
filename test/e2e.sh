#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
work="$(mktemp -d)"; port="$((20000 + RANDOM % 20000))"
VIQ_OPERATOR_TOKEN=secret node dist/src/server.js --port="$port" --storage="$work/data.sqlite" >"$work/server.log" 2>&1 & pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
base="http://127.0.0.1:$port"; for _ in $(seq 1 100); do curl -sf "$base/health" >/dev/null && break; sleep .02; done
viq=(node dist/bin/viq.js --server "$base" --json); evidence="${VIQ_EVIDENCE_DIR:-$work/evidence}"; mkdir -p "$evidence"; out="$evidence/e2e-output.txt"; : >"$out"
run(){ printf '$ viq'; local redact=0 arg; for arg in "$@"; do if ((redact)); then printf ' %q' '[REDACTED]'; redact=0; else printf ' %q' "$arg"; [[ "$arg" == --claim-token || "$arg" == --auth ]] && redact=1; fi; done; printf '\n'; "${viq[@]}" "$@"; }
{ run project create ABC; run actor create worker-a --name 'Worker A' --kind agent --auth secret; run actor create worker-b --name 'Worker B' --kind agent --auth secret; run actor create maks --name Maks --kind human --auth secret; run ticket create ABC tracer; claim="$("${viq[@]}" ticket claim ABC-1 --actor worker-a)"; jq 'del(.claim_token)' <<<"$claim"; cid="$(jq -r .ticket.claim.claim_id<<<"$claim")"; token="$(jq -r .claim_token<<<"$claim")"; run event post ABC-1 --claim-id "$cid" --actor worker-a --claim-token "$token" --generation 1 --message working; takeover="$("${viq[@]}" ticket takeover ABC-1 --actor worker-b --auth secret)"; jq 'del(.claim_token)' <<<"$takeover"; set +e; "${viq[@]}" ticket submit ABC-1 --claim-id "$cid" --actor worker-a --claim-token "$token" --generation 1 --reviewer maks; test $? -eq 3; set -e; ncid="$(jq -r .ticket.claim.claim_id<<<"$takeover")"; ntoken="$(jq -r .claim_token<<<"$takeover")"; run ticket submit ABC-1 --claim-id "$ncid" --actor worker-b --claim-token "$ntoken" --generation 2 --reviewer maks; run ticket accept ABC-1 --actor maks --auth secret; echo E2E_OK; } >"$out" 2>&1
cat "$out"
