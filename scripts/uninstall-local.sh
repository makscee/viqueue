#!/usr/bin/env bash
set -euo pipefail
prefix="${VIQ_PREFIX:-$HOME/.local}"
rm -f "$prefix/bin/viq" "$prefix/bin/viq-bootstrap" "$prefix/bin/viq-import" "$prefix/bin/viq-phone-auth" "$prefix/bin/viq-trace-tailscale-upstream" "$prefix/bin/viqueue-server" "$prefix/bin/viqueue-phone-gateway" "$prefix/bin/viq-mcp" "$prefix/bin/viqueue-mcp"
rm -f "$prefix/lib/viqueue/current" "$prefix/lib/viqueue/previous"
printf 'removed viqueue launchers/current pointer from %s; versioned releases and backups were preserved\n' "$prefix"
