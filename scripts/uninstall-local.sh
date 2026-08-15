#!/usr/bin/env bash
set -euo pipefail
prefix="${VIQ_PREFIX:-$HOME/.local}"
rm -f "$prefix/bin/viq" "$prefix/bin/viq-import" "$prefix/bin/viq-phone-auth" "$prefix/bin/viqueue-server" "$prefix/bin/viqueue-phone-gateway" "$prefix/bin/viq-mcp" "$prefix/bin/viqueue-mcp"
rm -rf "$prefix/lib/viqueue"
printf 'removed local viqueue installation from %s\n' "$prefix"
