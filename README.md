# viqueue

viqueue is a minimalist pull-based ticket board for a private, single-operator dogfood environment. The CLI is `viq`; ticket IDs look like `ABC-123`. v0.4.1 remains a prerelease and is not production-ready.

**Product-boundary authority:** [ADR 0013: Viq product charter](docs/adr-0013-product-charter.md). Viq coordinates work, not workers: independently started workers request fenced claims, while their runtimes and artifact systems execute and publish outside the Viq kernel. See the [documentation index](docs/README.md).

## Pairing PoC contract

The HTTP JSON core is the only state machine. Authorization is intentionally small:

- one-time, short-lived device pairing codes;
- fixed paired device kind: `coordinator` or `worker`;
- simple roles used only as worker assignment groups.

A coordinator may create/edit/archive tickets, assign to a worker device or role, answer/review submissions, issue/revoke pairing, and manage roles. A worker may read assigned work, claim it atomically, post claim-fenced progress/questions/blockers/submissions, or release its claim. Roles grant no API permissions.

The canonical external Browser/Board URL for the private alpha is **https://viq.makscee.ru**. Browser pairing and Board access start at that origin. `cc-worker.twin-pogona.ts.net` is legacy/internal transport where retained and is not a public or canonical Browser/Board URL.

Assignment establishes claim eligibility; it does not launch a process. Every HTTP, CLI, and `/viq` claim calls the same predicate: active paired worker, open ticket, exact device/role assignment, no unresolved blocker, and no current claim. Exact device/role assignments are preferred; eligible unassigned free-pool tickets may also be claimed atomically within project, role, and membership boundaries. Takeover is absent. There is no Start action, stored Ready state, generic scope system, or active `execution_authorities` path.

Claims remain durable generation-fenced locks until explicit release or submission. Claim and device credentials are returned only at creation/pairing, stored by hash in SQLite, and never included in ticket/model context.

## Bootstrap and run

Requires Node.js 22.

```sh
npm test
npm run build
viq-bootstrap --storage ./data/viqueue.sqlite --id coord --name "Coordinator"
node dist/src/server.js --storage=./data/viqueue.sqlite
```

`viq-bootstrap` is a local install action and prints the first coordinator credential once. Supply a credential with `--device-token` or `VIQ_DEVICE_TOKEN`:

```text
viq project create ABC --device-token COORDINATOR_CREDENTIAL
viq device pair-code --kind worker --device-token COORDINATOR_CREDENTIAL
viq role create tower-pi --name "Tower Pi" --device-token COORDINATOR_CREDENTIAL
viq role grant tower-worker tower-pi --device-token COORDINATOR_CREDENTIAL
viq ticket create ABC "Fix parser" --assignee-role tower-pi --device-token COORDINATOR_CREDENTIAL
viq ticket claim-next --project ABC --device-token WORKER_CREDENTIAL
```

The browser board shows a code-only pairing form when no valid local pairing exists. Browser redemption accepts only a server-bound coordinator-kind intent and resolves its actor, device ID, and device name on the server; legacy nullable and Worker intents fail closed on the Browser route. The board verifies the returned identity through `/v1/devices/me` and stores only the returned credential in `localStorage['viq.deviceCredential']`. Generic `/v1/devices/pair` accepts exactly `{code}` for a server-bound Worker intent; coordinator intents and ambiguous unbound legacy intents fail closed. Invalid/revoked credentials are cleared automatically, and **Disconnect this device** clears only browser-local state without revoking the server-side device.

MCP uses `VIQ_URL` and `VIQ_DEVICE_TOKEN` and exposes read-only device/task/status views; it cannot acquire or mutate claims. Install the existing package in a user's Pi profile with `pi install <Viq package>`. Subsequent Pi sessions for that Unix user discover:

```text
/viq pair WORKER_CODE
/viq status
/viq poll
/viq continue TICKET-ID
/viq pause|resume|stop
```

The bundled Pi adapter is a neutral Viq edge client. Ordinary `/viq poll` starts a persistent worker pool that atomically considers only tickets exactly assigned to the paired actor across all projects; it never takes unassigned or free-pool work. Blocking questions and terminal/release boundaries rotate the ordinary Pi process to a genuinely fresh model session; a small owner-only local checkpoint remembers only pool mode and an exact pending continuation ticket. After a human answers a blocking question, the fresh session re-reads that exact ticket, its questions, and history, then requests a normally fenced claim only for that ID; it never falls back to claim-next or another ticket. `/viq continue TICKET-ID` remains a compatible manual recovery command. `viq_submit` records a worker-authored outcome summary and backend-neutral immutable evidence references already produced elsewhere. The adapter does not synchronize repositories, execute artifact tooling, or publish artifacts.

## Migration and rollback

The forward migration creates `devices`, `pairing_codes`, and `device_roles`. The old `execution_authorities` table is retained only so rollback to the earlier build remains possible; candidate code neither joins, writes, consumes, nor exposes it. Install requires a local coordinator bootstrap before switching clients. Rollback restores the prior binary and database snapshot together; old binaries can still read their retained table.

The VIQ-15 cutover preflight and rollback intentionally do not pin whole-table row counts. Tickets, events, role memberships, and other unrelated live state may legitimately change between review and cutover and must be preserved. Global database safety is instead enforced by SQLite integrity, the exact schema digest, authenticated rollback artifacts, and source/SQLite-consistent-backup schema-and-count equality after writers stop. The reconciliation helper separately fails closed on the exact claims, open questions, actors, assignments, and timestamps that VIQ-15 changes.

The v0.2 importer remains explicit and never overwrites an existing target. `npm run bundle` refuses a dirty tree, records exact commit/tree identity, and creates a deterministic local archive. The installer writes an immutable release directory and atomically switches `current`, preserving `previous`; `rollback-local.sh` switches it back. When `VIQ_STORAGE` already exists, install requires an explicit offline confirmation and uses SQLite's backup API to capture and validate committed main/WAL state before any pointer change. Optional rollback restoration first creates and validates a SQLite-consistent post-candidate preservation copy, then prepares and validates the prior snapshot before replacing the database and removing stale sidecars; it likewise requires `VIQ_RESTORE_STORAGE=1`, `VIQ_STORAGE`, and offline confirmation. Uninstall removes launchers/pointers but preserves release and backup evidence. Nothing here publishes, deploys, or mutates live state.

viqueue is licensed under the [Apache License 2.0](LICENSE). See [SECURITY.md](SECURITY.md) for the bounded private-PoC threat model.
