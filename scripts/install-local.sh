#!/usr/bin/env bash
set -euo pipefail
prefix="${VIQ_PREFIX:-$HOME/.local}"
root="$prefix/lib/viqueue"
bin="$prefix/bin"
if [[ -f SOURCE_COMMIT ]]; then release_id=$(tr -d '\n' < SOURCE_COMMIT); else release_id=$(sha256sum src/store.js | cut -d' ' -f1); fi
[[ "$release_id" =~ ^[0-9a-f]{40,64}$ ]] || { echo 'invalid release identity' >&2; exit 1; }
if [[ -n "${VIQ_STORAGE:-}" && -f "$VIQ_STORAGE" && "${VIQ_SNAPSHOT_CONFIRMED_OFFLINE:-}" != 1 ]]; then echo 'existing VIQ_STORAGE requires VIQ_SNAPSHOT_CONFIRMED_OFFLINE=1' >&2; exit 1; fi
release="$root/releases/$release_id"
mkdir -p "$root/releases" "$root/backups" "$bin"
if [[ -e "$release" ]]; then echo "release already exists: $release" >&2; exit 1; fi
stage="$root/releases/.${release_id}.tmp"
rm -rf "$stage"; mkdir -p "$stage"
cp -R bin src web docs release-notes extensions package.json README.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md "$stage/"
[[ ! -f SOURCE_COMMIT ]] || cp SOURCE_COMMIT "$stage/"
[[ ! -f SOURCE_TREE ]] || cp SOURCE_TREE "$stage/"
mv "$stage" "$release"
if [[ -n "${VIQ_STORAGE:-}" && -f "$VIQ_STORAGE" ]]; then
  node --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();d.close();if(r.integrity_check!=='ok')process.exit(1)" "$VIQ_STORAGE"
  backup="$root/backups/$release_id"; mkdir -p "$backup"; cp -a "$VIQ_STORAGE" "$backup/viqueue.sqlite"; printf '%s\n' "$backup/viqueue.sqlite" > "$release/DB_BACKUP"
fi
old=$(readlink -f "$root/current" 2>/dev/null || true)
if [[ -n "$old" && "$old" != "$release" ]]; then ln -sfn "$old" "$root/previous.tmp"; mv -Tf "$root/previous.tmp" "$root/previous"; fi
ln -sfn "$release" "$root/current.tmp"; mv -Tf "$root/current.tmp" "$root/current"
app="$root/current"
ln -sfn "$app/bin/viq.js" "$bin/viq"
ln -sfn "$app/bin/viq-bootstrap.js" "$bin/viq-bootstrap"
ln -sfn "$app/bin/viq-import.js" "$bin/viq-import"
ln -sfn "$app/bin/viq-phone-auth.js" "$bin/viq-phone-auth"
ln -sfn "$app/bin/viq-trace-tailscale-upstream.js" "$bin/viq-trace-tailscale-upstream"
cat >"$bin/viqueue-server" <<EOF
#!/usr/bin/env bash
app=\$(readlink -f "$root/current")
exec node "\$app/src/server.js" "\$@"
EOF
cat >"$bin/viqueue-phone-gateway" <<EOF
#!/usr/bin/env bash
app=\$(readlink -f "$root/current")
exec node "\$app/src/phone-gateway.js" "\$@"
EOF
cat >"$bin/viq-mcp" <<EOF
#!/usr/bin/env bash
app=\$(readlink -f "$root/current")
exec node "\$app/src/mcp-server.js" "\$@"
EOF
ln -sfn viq-mcp "$bin/viqueue-mcp"
chmod +x "$release/bin/viq.js" "$release/bin/viq-bootstrap.js" "$release/bin/viq-import.js" "$release/bin/viq-phone-auth.js" "$release/bin/viq-trace-tailscale-upstream.js" "$bin/viqueue-server" "$bin/viqueue-phone-gateway" "$bin/viq-mcp"
printf 'installed viqueue release %s under %s\n' "$release_id" "$prefix"
printf 'ensure %s is on PATH\n' "$bin"
