# ADR 0005: local release-candidate bundle

Status: accepted for local evaluation

Build a deterministic local tarball containing the already-built server, board, `viq`, MCP adapter, package metadata, Apache-2.0 license, public-source documentation, and reversible install/uninstall scripts. This advances everyday local use without publishing, registering names, changing domain behavior, or requiring elevated privileges.

`npm run bundle` creates ignored files under `release/`:

- `viqueue-v0.2.0-rc.tar.gz`
- `viqueue-v0.2.0-rc.tar.gz.sha256`

The installer defaults to `~/.local`, supports an isolated `VIQ_PREFIX`, and installs `viq`, `viqueue-server`, and `viqueue-mcp` launchers. Uninstall removes only installed application files and launchers; user-selected storage remains untouched. The integration test extracts the actual archive, installs into a temporary prefix, runs HTTP/board/CLI/MCP against durable storage, uninstalls, and verifies the data remains.

This is not publication or a production release. Apache-2.0 is approved and implemented. Trademark clearance and explicit publication authority remain gates.
