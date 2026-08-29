#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_EVIDENCE_DIR:?VIQ_EVIDENCE_DIR is required}"
proof="$(mktemp -d "${TMPDIR:-/tmp}/viq-e2e-diagnostics.XXXXXX")"
trap 'rm -rf "$proof"' EXIT
set +e
VIQ_EVIDENCE_DIR="$proof/evidence" VIQ_E2E_CLAIM_PROJECT=NULL bash test/e2e.sh >"$proof/stdout" 2>"$proof/stderr"
status=$?
set -e
test "$status" -eq 1
grep -q '"code":"project_not_found"' "$proof/stdout"
grep -q '"message":"project NULL not found"' "$proof/stdout"
if grep -Eq '(maks|worker-a)\.[A-Za-z0-9_-]{40,}' "$proof/stdout" "$proof/stderr"; then
  echo 'credential leaked by failure diagnostics' >&2
  exit 1
fi
echo E2E_FAILURE_DIAGNOSTICS_OK
