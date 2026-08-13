# ADR 0005: local release-candidate bundle

Status: accepted for local evaluation

Build a deterministic local tarball containing the already-built server, board, `viq`, MCP adapter, package metadata, README, and reversible install/uninstall scripts. This advances everyday local use without publishing, selecting a license, registering names, changing domain behavior, or requiring elevated privileges.

`npm run bundle` creates ignored files under `release/`:

- `viqueue-local-rc.tar.gz`
- `viqueue-local-rc.tar.gz.sha256`

The installer defaults to `~/.local`, supports an isolated `VIQ_PREFIX`, and installs `viq`, `viqueue-server`, and `viqueue-mcp` launchers. Uninstall removes only installed application files and launchers; user-selected storage remains untouched. The integration test extracts the actual archive, installs into a temporary prefix, runs HTTP/board/CLI/MCP against durable storage, uninstalls, and verifies the data remains.

This is not publication or an open-source release. The repository remains `private`/`UNLICENSED`; trademark clearance and license approval remain authority gates.
