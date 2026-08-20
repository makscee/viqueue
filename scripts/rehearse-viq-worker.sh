#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
exec 3>&1
: "${TMPDIR:?set TMPDIR to an explicit external temp root (not /tmp)}"
: "${VIQ_WORKER_TMPDIR:?set VIQ_WORKER_TMPDIR to an explicit viq-worker-traversable external temp root}"
[[ $EUID -eq 0 ]] || { printf 'WORKER_REHEARSAL_FAIL step=identity\n' >&3; exit 1; }
[[ $# -eq 4 ]] || { printf 'WORKER_REHEARSAL_FAIL step=arguments\n' >&3; exit 64; }
archive=$(readlink -f "$1")
candidate=$2
previous=$3
expected_sha=$4
[[ $TMPDIR == /* && $VIQ_WORKER_TMPDIR == /* && $TMPDIR != /tmp && $TMPDIR != /tmp/* && $VIQ_WORKER_TMPDIR != /tmp && $VIQ_WORKER_TMPDIR != /tmp/* ]] || { printf 'WORKER_REHEARSAL_FAIL step=temp-root\n' >&3; exit 64; }
[[ $candidate =~ ^[0-9a-f]{40}$ && $previous =~ ^[0-9a-f]{40}$ && $expected_sha =~ ^[0-9a-f]{64}$ ]] || { printf 'WORKER_REHEARSAL_FAIL step=identity-format\n' >&3; exit 64; }
install -d -m 0700 "$TMPDIR"
install -d -m 0755 "$VIQ_WORKER_TMPDIR"
work=$(mktemp -d "$VIQ_WORKER_TMPDIR/viq-worker-rehearsal.XXXXXX")
log=$work/rehearsal.log
chmod 0755 "$work"
touch "$log"; chmod 0600 "$log"
step=initialization
cleanup(){ rm -rf "$work"; }
failed(){ local rc=$?; printf 'WORKER_REHEARSAL_FAIL step=%s\n' "$step" >&3; cleanup; exit "$rc"; }
trap failed ERR
exec >"$log" 2>&1
step=source-lineage
[[ $(git rev-parse HEAD) == "$candidate" && -z $(git status --porcelain --untracked-files=normal) ]]
step=archive-authentication
[[ -f $archive && ! -L $archive && $(sha256sum "$archive" | cut -d' ' -f1) == "$expected_sha" ]]
root=$work/install
old=$root/releases/$previous
mkdir -p "$old"
chmod 0755 "$root" "$root/releases"
printf '%s\n' "$previous" > "$old/SOURCE_COMMIT"
chmod 0555 "$old"
ln -s "$old" "$root/current"
step=archive-install
VIQ_WORKER_ROOT="$root" bash scripts/install-viq-worker.sh "$archive" "$candidate" "$previous"
[[ $(readlink -f "$root/current") == "$root/releases/$candidate" && $(cat "$root/current/SOURCE_COMMIT") == "$candidate" ]]
step=real-uid-discovery-lifecycle
VIQ_WORKER_RELEASE="$root/current" VIQ_PI_WORKER_PROOF=1 bash scripts/run-coordinator-worker-browser-e2e.sh
step=archive-rollback
VIQ_WORKER_ROOT="$root" bash scripts/rollback-viq-worker.sh "$candidate" "$previous"
[[ $(readlink -f "$root/current") == "$old" && $(cat "$root/current/SOURCE_COMMIT") == "$previous" ]]
trap - ERR
printf 'WORKER_REHEARSAL_OK archive=%s uid=%s gid=%s discovery=viq-worker lifecycle=pass rollback=pass\n' "$expected_sha" "$(id -u viq-worker)" "$(id -g viq-worker)" >&3
cleanup
