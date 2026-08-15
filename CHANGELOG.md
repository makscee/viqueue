# Changelog

This project follows [Semantic Versioning](https://semver.org/) for package metadata. Before 1.0, minor releases may include compatible contract additions and documented breaking changes; patch releases contain compatible fixes. A version number does not imply publication or production readiness.

## [Unreleased]

No changes yet.

## [0.4.1] — exact Tailscale HTTPS upstream security successor

- Preserve loopback-only HTTP as the default phone-gateway upstream mode.
- Add an explicit `tailscale` address policy for one exact remote HTTPS DNS origin.
- Bind every new TLS socket to a freshly validated all-tailnet DNS answer set while retaining standard CA and hostname verification.
- Add adversarial upstream tests, read-only tailnet tracer, CLI help, and updated security operations documentation.

Release notes: [`release-notes/v0.4.1.md`](release-notes/v0.4.1.md).

## [0.4.0] — phone gateway prerelease

- Repair the human-first desktop/mobile queue and assignment presentation.
- Add the isolated single-phone proof gateway, one-use device pairing, request-bound signatures, local revocation, and staging security documentation.
- Add phone CLI/browser E2E coverage and package the gateway launchers.

Release notes: [`release-notes/v0.4.0.md`](release-notes/v0.4.0.md).

## [0.3.0]

- Added registered actors/roles, typed assignments, actor inbox cursors, fenced multi-question workflows, and explicit reviewer approval submission.
- Added transactional idempotent legacy actor migration and structured event metadata. — Daily Alpha core (unpublished)

- Replace JSON tracer storage with one SQLite file and four minimal domain tables.
- Replace lease/liveness semantics with durable explicit fenced claims.
- Add append-only events, edit/assign, release, review/accept/reopen, and four-column board.
- Add explicit fail-closed v0.2 JSON import.
- Keep HTTP as the single state machine behind CLI, MCP, and browser adapters.

Release notes: [`release-notes/v0.3.0.md`](release-notes/v0.3.0.md).

## [0.2.0] — early prerelease

- Prepare the Apache-2.0 source tree, public project hygiene, and GitHub CI without publishing packages.
- Add contribution, security, release-content, and versioning documentation.
- Add the responsive human Kanban projection and mobile state navigation.
- Add bounded, non-disruptive projection refresh.
- Add deterministic local install/uninstall bundle support.
- Preserve HTTP, `viq`, and MCP claim/takeover fencing semantics.

Release notes: [`release-notes/v0.2.0.md`](release-notes/v0.2.0.md).

## [0.1.0] — MCP tracer

- Add the HTTP-backed MCP stdio adapter and claim renewal.

## [0.0.0-phase0] — tracer bullet

- Add durable local storage, HTTP server, `viq`, claim expiry uncertainty, explicit takeover, fencing, and evidence submission.
