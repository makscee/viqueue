# viqueue

viqueue is a minimalist pull-based ticket board for a private, single-operator dogfood environment. The CLI is `viq`; ticket IDs look like `ABC-123`. v0.4.1 remains a prerelease and is not production-ready.

## Pairing PoC contract

The HTTP JSON core is the only state machine. Authorization is intentionally small:

- one-time, short-lived device pairing codes;
- fixed paired device kind: `coordinator` or `worker`;
- simple roles used only as worker assignment groups.

A coordinator may create/edit/archive tickets, assign to a worker device or role, answer/review submissions, issue/revoke pairing, and manage roles. A worker may read assigned work, claim it atomically, post claim-fenced progress/questions/blockers/submissions, or release its claim. Roles grant no API permissions.

Assignment is launch authorization. Every HTTP, CLI, and `/viq` claim calls the same predicate: active paired worker, open ticket, exact device/role assignment, no unresolved blocker, and no current claim. Exact device/role assignments are preferred; eligible unassigned free-pool tickets may also be claimed atomically within project, role, and membership boundaries. Takeover is absent. There is no Start action, stored Ready state, generic scope system, or active `execution_authorities` path.

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

The browser board shows a pairing form when no valid local pairing exists. New coordinator-issued codes bind actor, kind, device ID, and device name, so code-only clients need only the one-time code; the browser retains ID/name inputs for legacy nullable codes. The board verifies `/v1/devices/me` and stores only the returned credential in `localStorage['viq.deviceCredential']`. Invalid/revoked credentials are cleared automatically, and **Disconnect this device** clears only browser-local state without revoking the server-side device.

MCP uses `VIQ_URL` and `VIQ_DEVICE_TOKEN` and exposes read-only device/task/status views; it cannot acquire or mutate claims. Install the existing package in a user's Pi profile with `pi install <Viq package>`. Subsequent Pi sessions for that Unix user discover:

```text
/viq PAIRING_CODE [--project KEY]
/viq status
/viq pause|resume|stop
```

`/viq PAIRING_CODE` pairs and starts the worker in the current visible Pi session; there is no separate worker command or launch ritual. Before every claim attempt it visibly runs `tools/vault-sync/vault-sync sync` in the current Vault and claims only after status proves a clean `CURRENT/EQUAL` canonical commit. The VIQ server remains the sole eligibility and atomic claim authority, and the complete returned ticket contract is injected unchanged with sanitized history. `viq_submit` visibly syncs again and submits the operator evidence plus the exact published commit only after publication succeeds; conflict, guard, or offline failure retains the fenced claim for retry.

Pairing writes JSON outside repositories at `${XDG_CONFIG_HOME:-~/.config}/viq/credential.json`, with directory mode 0700 and file mode 0600. Sessions for the same Unix user reuse it; other users do not. Ordinary root Pi is supported and receives a root-only file. Polling is a timer owned by that Pi session, stopped on session shutdown, with no daemon or duplicate lifecycle store. Explicit `VIQ_WORKER_LOCKDOWN=1` preserves the historical isolated-workspace/root refusal contour. Credentials stay out of prompts, status, tool results, argv, environment, and request bodies; the trusted Pi process necessarily can read its own Unix user's file.

An exact worker-only archive is built from clean committed `HEAD` with `npm run bundle:worker -- OUTPUT_DIR`. It includes `SOURCE_COMMIT`, `SOURCE_TREE`, the configured `package.json` discovery path, and only the worker extension/runtime. `scripts/install-viq-worker.sh` requires an explicit `VIQ_WORKER_ROOT`, exact candidate commit, and exact current predecessor before it creates a read-only release and atomically renames the `current` symlink. `scripts/rollback-viq-worker.sh` accepts only that installed candidate and the sealed predecessor; the VIQ-15 predecessor is `1398284ed89a6cf9395f129483f709e63c009286`. Tests and rehearsals must use an isolated root, never `/opt/viq-worker`.

## Migration and rollback

The forward migration creates `devices`, `pairing_codes`, and `device_roles`. The old `execution_authorities` table is retained only so rollback to the earlier build remains possible; candidate code neither joins, writes, consumes, nor exposes it. Install requires a local coordinator bootstrap before switching clients. Rollback restores the prior binary and database snapshot together; old binaries can still read their retained table.

The VIQ-15 cutover preflight and rollback intentionally do not pin whole-table row counts. Tickets, events, role memberships, and other unrelated live state may legitimately change between review and cutover and must be preserved. Global database safety is instead enforced by SQLite integrity, the exact schema digest, authenticated rollback artifacts, and source/SQLite-consistent-backup schema-and-count equality after writers stop. The reconciliation helper separately fails closed on the exact claims, open questions, actors, assignments, and timestamps that VIQ-15 changes.

The v0.2 importer remains explicit and never overwrites an existing target. `npm run bundle` refuses a dirty tree, records exact commit/tree identity, and creates a deterministic local archive. The installer writes an immutable release directory and atomically switches `current`, preserving `previous`; `rollback-local.sh` switches it back. When `VIQ_STORAGE` already exists, install requires an explicit offline confirmation and uses SQLite's backup API to capture and validate committed main/WAL state before any pointer change. Optional rollback restoration first creates and validates a SQLite-consistent post-candidate preservation copy, then prepares and validates the prior snapshot before replacing the database and removing stale sidecars; it likewise requires `VIQ_RESTORE_STORAGE=1`, `VIQ_STORAGE`, and offline confirmation. Uninstall removes launchers/pointers but preserves release and backup evidence. Nothing here publishes, deploys, or mutates live state.

viqueue is licensed under the [Apache License 2.0](LICENSE). See [SECURITY.md](SECURITY.md) for the bounded private-PoC threat model.
