#!/usr/bin/env bash
set -euo pipefail
prefix="${VIQ_PREFIX:-$HOME/.local}"
app="$prefix/lib/viqueue"
bin="$prefix/bin"
mkdir -p "$app" "$bin"
cp -R bin src web docs release-notes package.json README.md LICENSE CHANGELOG.md CONTRIBUTING.md SECURITY.md "$app/"
ln -sfn "$app/bin/viq.js" "$bin/viq"
ln -sfn "$app/bin/viq-import.js" "$bin/viq-import"
cat >"$bin/viqueue-server" <<EOF
#!/usr/bin/env bash
exec node "$app/src/server.js" "\$@"
EOF
cat >"$bin/viq-mcp" <<EOF
#!/usr/bin/env bash
exec node "$app/src/mcp-server.js" "\$@"
EOF
ln -sfn viq-mcp "$bin/viqueue-mcp"
chmod +x "$app/bin/viq.js" "$app/bin/viq-import.js" "$bin/viqueue-server" "$bin/viq-mcp"
printf 'installed viqueue locally under %s\n' "$prefix"
printf 'ensure %s is on PATH\n' "$bin"
