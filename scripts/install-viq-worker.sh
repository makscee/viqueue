#!/usr/bin/env bash
set -euo pipefail
: "${VIQ_WORKER_ROOT:?set VIQ_WORKER_ROOT to an isolated install root}"
[[ $# -eq 3 ]] || { echo 'usage: install-viq-worker.sh ARCHIVE CANDIDATE_COMMIT EXPECTED_PREVIOUS_COMMIT' >&2; exit 64; }
archive=$(readlink -f "$1")
candidate=$2
previous=$3
[[ $candidate =~ ^[0-9a-f]{40}$ && $previous =~ ^[0-9a-f]{40}$ ]] || { echo 'commits must be exact 40-character hashes' >&2; exit 64; }
root=$(readlink -m "$VIQ_WORKER_ROOT")
releases=$root/releases
current=$root/current
[[ -L $current ]] || { echo 'current pointer is not a symlink' >&2; exit 1; }
[[ $(readlink -f "$current") == "$releases/$previous" ]] || { echo 'current pointer does not match expected previous commit' >&2; exit 1; }
[[ -d $releases/$previous && $(cat "$releases/$previous/SOURCE_COMMIT") == "$previous" ]] || { echo 'previous release identity mismatch' >&2; exit 1; }
work=$(mktemp -d "$root/.install.XXXXXX")
trap 'rm -rf "$work" "$root/.current.$$"' EXIT
tar -xzf "$archive" -C "$work" --no-same-owner
mapfile -t manifests < <(find "$work" -mindepth 2 -maxdepth 2 -name SOURCE_COMMIT -type f)
[[ ${#manifests[@]} -eq 1 && $(cat "${manifests[0]}") == "$candidate" ]] || { echo 'candidate release identity mismatch' >&2; exit 1; }
stage=${manifests[0]%/SOURCE_COMMIT}
[[ -f $stage/package.json && -f $stage/extensions/viq-worker/index.ts && -f $stage/extensions/viq-worker/worker-runtime.mjs && -f $stage/extensions/viq-worker/credential-store.mjs && -f $stage/extensions/viq-worker/vault-sync.mjs ]] || { echo 'worker package is incomplete' >&2; exit 1; }
node -e 'const p=require(process.argv[1]);if(p.pi?.extensions?.[0]!=="./extensions/viq-worker/index.ts")process.exit(1)' "$stage/package.json"
if [[ -e $releases/$candidate ]]; then
  [[ $(cat "$releases/$candidate/SOURCE_COMMIT") == "$candidate" ]] || { echo 'existing candidate identity mismatch' >&2; exit 1; }
else
  mkdir -p "$releases"
  mv "$stage" "$releases/$candidate"
  chmod -R a-w "$releases/$candidate"
fi
ln -s "$releases/$candidate" "$root/.current.$$"
mv -Tf "$root/.current.$$" "$current"
printf '%s\n' "$previous" > "$root/PREVIOUS_COMMIT"
chmod 0444 "$root/PREVIOUS_COMMIT"
printf 'installed=%s previous=%s\n' "$candidate" "$previous"
