#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_WORKER_ROOT:?set VIQ_WORKER_ROOT to an isolated install root}"
[[ $# -eq 2 ]] || { echo 'usage: rollback-viq-worker.sh INSTALLED_CANDIDATE_COMMIT ROLLBACK_COMMIT' >&2; exit 64; }
candidate=$1
rollback=$2
[[ $candidate =~ ^[0-9a-f]{40}$ && $rollback =~ ^[0-9a-f]{40}$ ]] || { echo 'commits must be exact 40-character hashes' >&2; exit 64; }
root=$(readlink -m "$VIQ_WORKER_ROOT")
releases=$root/releases
current=$root/current
[[ -L $current && $(readlink -f "$current") == "$releases/$candidate" ]] || { echo 'current pointer does not match installed candidate' >&2; exit 1; }
[[ -d $releases/$rollback && $(cat "$releases/$rollback/SOURCE_COMMIT") == "$rollback" ]] || { echo 'rollback release identity mismatch' >&2; exit 1; }
[[ -f $root/PREVIOUS_COMMIT && $(cat "$root/PREVIOUS_COMMIT") == "$rollback" ]] || { echo 'sealed previous commit mismatch' >&2; exit 1; }
trap 'rm -f "$root/.current.$$"' EXIT
ln -s "$releases/$rollback" "$root/.current.$$"
mv -Tf "$root/.current.$$" "$current"
printf 'rolled_back=%s from=%s\n' "$rollback" "$candidate"
