#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$script_dir"
prefix="${VIQ_PREFIX:-$HOME/.local}"
root="$prefix/lib/viqueue"
bin="$prefix/bin"
if [[ -f SOURCE_COMMIT ]]; then release_id=$(tr -d '\n' < SOURCE_COMMIT); else release_id=$(sha256sum src/store.js | cut -d' ' -f1); fi
[[ "$release_id" =~ ^[0-9a-f]{40,64}$ ]] || { echo 'invalid release identity' >&2; exit 1; }
if [[ -n "${VIQ_STORAGE:-}" && -f "$VIQ_STORAGE" && "${VIQ_SNAPSHOT_CONFIRMED_OFFLINE:-}" != 1 ]]; then echo 'existing VIQ_STORAGE requires VIQ_SNAPSHOT_CONFIRMED_OFFLINE=1' >&2; exit 1; fi
release="$root/releases/$release_id"
stage="$root/releases/.${release_id}.tmp"
backup_dir="$root/backups/$release_id"
mkdir -p "$root/releases" "$root/backups" "$bin"
[[ ! -e "$release" ]] || { echo "release already exists: $release" >&2; exit 1; }
rm -rf "$stage" "$backup_dir"
complete=0
cleanup(){ if [[ "$complete" != 1 ]]; then rm -rf "$stage" "$release" "$backup_dir"; fi; }
trap cleanup EXIT
mkdir -p "$stage"
cp -R bin src web docs release-notes extensions package.json README.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md "$stage/"
[[ ! -f SOURCE_COMMIT ]] || cp SOURCE_COMMIT "$stage/"
[[ ! -f SOURCE_TREE ]] || cp SOURCE_TREE "$stage/"
if [[ -n "${VIQ_STORAGE:-}" && -f "$VIQ_STORAGE" ]]; then
  mkdir -p "$backup_dir"
  node "$script_dir/sqlite-backup.js" "$VIQ_STORAGE" "$backup_dir/viqueue.sqlite"
  printf '%s\n' "$backup_dir/viqueue.sqlite" > "$stage/DB_BACKUP"
fi
mv "$stage" "$release"
app="$root/current"
ln -sfn "$app/bin/viq.js" "$bin/viq"
ln -sfn "$app/bin/viq-bootstrap.js" "$bin/viq-bootstrap"
ln -sfn "$app/bin/viq-recover-coordinator.js" "$bin/viq-recover-coordinator"
ln -sfn "$app/bin/viq-import.js" "$bin/viq-import"
rm -f "$bin/viq-phone-auth" "$bin/viq-trace-tailscale-upstream" "$bin/viqueue-phone-gateway"
cat >"$bin/viqueue-server" <<EOF
#!/usr/bin/env bash
app=\$(readlink -f "$root/current")
exec node "\$app/src/server.js" "\$@"
EOF
cat >"$bin/viq-mcp" <<EOF
#!/usr/bin/env bash
app=\$(readlink -f "$root/current")
exec node "\$app/src/mcp-server.js" "\$@"
EOF
ln -sfn viq-mcp "$bin/viqueue-mcp"
chmod +x "$release/bin/viq.js" "$release/bin/viq-bootstrap.js" "$release/bin/viq-recover-coordinator.js" "$release/bin/viq-import.js" "$bin/viqueue-server" "$bin/viq-mcp"
old=$(readlink -f "$root/current" 2>/dev/null || true)
if [[ -n "$old" && "$old" != "$release" ]]; then ln -sfn "$old" "$root/previous.tmp"; mv -Tf "$root/previous.tmp" "$root/previous"; fi
ln -sfn "$release" "$root/current.tmp"; mv -Tf "$root/current.tmp" "$root/current"
complete=1
trap - EXIT
printf 'installed viqueue release %s under %s\n' "$release_id" "$prefix"
printf 'ensure %s is on PATH\n' "$bin"
