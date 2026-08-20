# viqueue

viqueue is a minimalist pull-based ticket board for a private, single-operator dogfood environment. The CLI is `viq`; ticket IDs look like `ABC-123`. v0.4.1 remains a prerelease and is not production-ready.

## Pairing PoC contract

The HTTP JSON core is the only state machine. Authorization is intentionally small:

- one-time, short-lived device pairing codes;
- fixed paired device kind: `coordinator` or `worker`;
- simple roles used only as worker assignment groups.

A coordinator may create/edit/archive tickets, assign to a worker device or role, answer/review submissions, issue/revoke pairing, and manage roles. A worker may read assigned work, claim it atomically, post claim-fenced progress/questions/blockers/submissions, or release its claim. Roles grant no API permissions.

Assignment is launch authorization. Every HTTP, CLI, and `/viq-worker` claim calls the same predicate: active paired worker, open ticket, exact device/role assignment, no unresolved blocker, and no current claim. Unassigned pickup and takeover are absent. There is no Start action, stored Ready state, generic scope system, or active `execution_authorities` path.

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

The browser board shows a pairing form when no valid local pairing exists. Enter a coordinator-issued one-time code plus a device ID/name; the board verifies `/v1/devices/me` and stores only the returned credential in `localStorage['viq.deviceCredential']`. Invalid/revoked credentials are cleared automatically, and **Disconnect this device** clears only browser-local state without revoking the server-side device.

MCP uses `VIQ_URL` and `VIQ_DEVICE_TOKEN` and exposes read-only device/task/status views; it cannot acquire or mutate claims. The bundled Pi extension provides:

```text
/viq-worker pair CODE [--id ID] [--name NAME]
/viq-worker start [--project KEY]
/viq-worker status|pause|resume|stop
```

It writes the device credential outside the workspace at `${XDG_STATE_HOME:-~/.local/state}/viq-worker/device-credential`, owner-only mode 0600, keeps it out of prompts/status/tool results, refuses root, and exposes only claim-fenced Viq progress/question/block/submit/release tools.

## Migration and rollback

The forward migration creates `devices`, `pairing_codes`, and `device_roles`. The old `execution_authorities` table is retained only so rollback to the earlier build remains possible; candidate code neither joins, writes, consumes, nor exposes it. Install requires a local coordinator bootstrap before switching clients. Rollback restores the prior binary and database snapshot together; old binaries can still read their retained table.

The v0.2 importer remains explicit and never overwrites an existing target. `npm run bundle` refuses a dirty tree, records exact commit/tree identity, and creates a deterministic local archive. The installer writes an immutable release directory and atomically switches `current`, preserving `previous`; `rollback-local.sh` switches it back. When `VIQ_STORAGE` already exists, install requires an explicit offline confirmation and uses SQLite's backup API to capture and validate committed main/WAL state before any pointer change. Optional rollback restoration first creates and validates a SQLite-consistent post-candidate preservation copy, then prepares and validates the prior snapshot before replacing the database and removing stale sidecars; it likewise requires `VIQ_RESTORE_STORAGE=1`, `VIQ_STORAGE`, and offline confirmation. Uninstall removes launchers/pointers but preserves release and backup evidence. Nothing here publishes, deploys, or mutates live state.

viqueue is licensed under the [Apache License 2.0](LICENSE). See [SECURITY.md](SECURITY.md) for the bounded private-PoC threat model.
