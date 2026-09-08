# viqueue

viqueue is a minimalist pull-based ticket board for a private, single-operator dogfood environment. The CLI is `viq`; ticket IDs look like `ABC-123`. v0.5.2 remains a prerelease and is not production-ready.

**Product-boundary authority:** [ADR 0013: Viq product charter](docs/adr-0013-product-charter.md). Viq coordinates work, not workers: independently started workers request fenced claims, while their runtimes and artifact systems execute and publish outside the Viq kernel. See the [documentation index](docs/README.md).

## Pairing PoC contract

The HTTP JSON core is the only state machine. Authorization is intentionally small:

- one-time, short-lived device pairing codes;
- fixed paired device kind: `coordinator` or `worker`;
- simple roles used only as worker assignment groups.

A coordinator may create/edit/archive tickets, assign to a worker device or role, answer/review submissions, issue/revoke pairing, and manage roles. A worker may read assigned work, claim it atomically, post claim-fenced progress/questions/blockers/submissions, release its claim, or directly complete claimed work. Roles grant no API permissions.

The canonical external Browser/Board URL for the private alpha is **https://viq.makscee.ru**. Browser pairing and Board access start at that origin. `cc-worker.twin-pogona.ts.net` is legacy/internal transport where retained and is not a public or canonical Browser/Board URL.

Assignment establishes claim eligibility; it does not launch a process. Every HTTP, CLI, and `/viq` claim calls the same predicate: active paired worker, open ticket, exact device/role assignment, no unresolved blocker, and no current claim. Exact device/role assignments are preferred; eligible unassigned free-pool tickets may also be claimed atomically within project, role, and membership boundaries. Takeover is absent. There is no Start action, stored Ready state, generic scope system, or active `execution_authorities` path.

Claims remain durable generation-fenced locks until explicit release, legacy submission, or direct completion. Claim and device credentials are returned only at creation/pairing, stored by hash in SQLite, and never included in ticket/model context.

## Bootstrap and run

Requires Node.js 22.

```sh
npm test
npm run build
viq-bootstrap --storage ./data/viqueue.sqlite --id coord --name "Coordinator"
node dist/src/server.js --storage=./data/viqueue.sqlite
```

`viq-bootstrap` is a local install action and prints the first coordinator credential once. Credential precedence for authenticated `viq` commands is explicit `--device-token`, non-empty `VIQ_DEVICE_TOKEN`, then the owner-only paired credential file. The default file is `$XDG_CONFIG_HOME/viq/credential.json` when that variable is set, otherwise `~/.config/viq/credential.json`; select a separate coordinator or worker identity with `--credential-file /absolute/path` or `VIQ_CREDENTIAL_FILE`. The selector is transport-neutral and the file must use the paired `{"credential":"..."}` format enforced by the safe loader; credentials are never printed by authenticated commands. Worker pairing binds an existing worker actor to the supplied device ID and name:

```text
viq project create ABC --device-token COORDINATOR_CREDENTIAL
viq device pair-code --kind worker --actor WORKER_ACTOR_ID --id WORKER_DEVICE_ID --name "Tower Worker" --device-token COORDINATOR_CREDENTIAL
viq ticket create ABC "Fix parser" --assignment Agent --device-token COORDINATOR_CREDENTIAL
# In the paired worker shell:
export VIQ_DEVICE_TOKEN=WORKER_CREDENTIAL
viq session open
export VIQ_SESSION_CAPABILITY=RETURNED_SESSION_CAPABILITY
viq ticket claim-next --project ABC
```

The worker CLI supports the complete fenced lifecycle. `device pair` redeems a one-time Worker code without an existing credential. `session open` returns a server-issued capability; keep it in `VIQ_SESSION_CAPABILITY`, never in argv. Claim output supplies the claim ID, claim token, and generation used by subsequent mutations.

```text
viq device pair WORKER_CODE --server http://127.0.0.1:17373
export VIQ_DEVICE_TOKEN=RETURNED_WORKER_CREDENTIAL
viq session open
export VIQ_SESSION_CAPABILITY=RETURNED_SESSION_CAPABILITY
viq ticket claim ABC-1
viq ticket progress ABC-1 --claim-id CLAIM_ID --claim-token CLAIM_TOKEN --generation 1 --request-id progress-1 --message "Implementation underway"
viq question list ABC-1 --status open
viq question ask ABC-1 --claim-id CLAIM_ID --claim-token CLAIM_TOKEN --generation 1 --request-id question-1 --text "Any constraints?" --blocking
viq session close
# In a coordinator shell:
viq question answer ABC-1 QUESTION_ID --answer "Proceed." --request-id answer-1
# Open a fresh worker session, reclaim ABC-1, and use its new claim fence:
viq ticket complete ABC-1 --claim-id NEW_CLAIM_ID --claim-token NEW_CLAIM_TOKEN --generation 2 --request-id completion-1 --outcome "Implemented and tested" --evidence urn:test:focused
viq session close
```

A blocking question releases its claim and moves the ticket to `Waiting`. `question answer TICKET QUESTION --answer TEXT [--request-id ID]` uses coordinator authority and reopens the ticket after the final blocking text answer; the worker must open a fresh session and reclaim it. Direct completion requires that live session capability, exact new claim fence, unique request ID, concise outcome, and zero or more repeatable opaque `--evidence` references. It atomically records completion and releases the claim; an exact retry returns the original result. Legacy `ticket submit` and coordinator `ticket accept` remain compatible review paths, but they are not required for direct completion. Viq records completion/provenance without certifying correctness or publication. These commands describe the local CLI contract, not deployment or live-service verification.

The browser board shows a code-only pairing form when no valid local pairing exists. Browser redemption accepts only a server-bound coordinator-kind intent and resolves its actor, device ID, and device name on the server; legacy nullable and Worker intents fail closed on the Browser route. The board verifies the returned identity through `/v1/devices/me` and stores only the returned credential in `localStorage['viq.deviceCredential']`. Generic `/v1/devices/pair` accepts exactly `{code}` for a server-bound Worker intent; coordinator intents and ambiguous unbound legacy intents fail closed. Invalid/revoked credentials are cleared automatically, and **Disconnect this device** clears only browser-local state without revoking the server-side device.

MCP uses `VIQ_URL` and `VIQ_DEVICE_TOKEN` and exposes read-only device/task/status views; it cannot acquire or mutate claims. Install the existing package in a user's Pi profile with `pi install <Viq package>`. Subsequent Pi sessions for that Unix user discover:

```text
/viq pair WORKER_CODE
/viq status
/viq poll
/viq take PROJECT-N
/viq once
/viq stop
/viq unpair
```

The bundled Pi adapter is a neutral Viq edge client. Ordinary `/viq poll` turns one interactive Pi process into one persistent worker lane that atomically considers generic `Agent` tickets across all projects; `Unassigned` and `Human` tickets are never claimed. `/viq take PROJECT-N [--credential-file /absolute/path]` instead creates a fresh preserved Pi session and claims only that exact ticket through the same HTTP session and claim-fence runtime path, with no fallback selection. Every ticket execution uses a new preserved Pi session, so no session contains two ticket IDs. A settled model turn does not free the lane: the extension first reads canonical Viq state and may only continue its same fenced claim. Blocking questions and terminal/release boundaries end that episode; later eligible work is reconstructed from canonical history in a fresh session. `/viq once` performs one diagnostic claim attempt without persistence.

For a runtime that already creates a fresh native Pi episode, typed `viq_take` accepts `ticket_id` and an optional absolute `credential_file`—never a token—and returns canonical non-secret ticket/history without injecting a duplicate prompt. It denies an active episode and denies reuse after completion, release, or another terminal boundary. `viq_complete` calls the existing public direct-completion API with a concise outcome and optional immutable opaque evidence references, then ends the episode under the same cleanup contract. Legacy `viq_submit` remains available for compatibility. One device may hold only one active claim, so concurrent lanes need distinct paired device identities and owner-only credential files; set `VIQ_CREDENTIAL_FILE` per Pi process or pass the explicit selector where supported. There is no automatic pairing or identity selection.

The Machines view shows worker state, heartbeats, and any current ticket without secrets. `viq_submit` records a structured backend-neutral Review Bundle already produced elsewhere. The adapter does not synchronize repositories, execute artifact tooling, publish artifacts, merge, release, or deploy.

## Migration and rollback

The forward migration creates `devices`, `pairing_codes`, and `device_roles`. The old `execution_authorities` table is retained only so rollback to the earlier build remains possible; candidate code neither joins, writes, consumes, nor exposes it. Install requires a local coordinator bootstrap before switching clients. Rollback restores the prior binary and database snapshot together; old binaries can still read their retained table.

The VIQ-15 cutover preflight and rollback intentionally do not pin whole-table row counts. Tickets, events, role memberships, and other unrelated live state may legitimately change between review and cutover and must be preserved. Global database safety is instead enforced by SQLite integrity, the exact schema digest, authenticated rollback artifacts, and source/SQLite-consistent-backup schema-and-count equality after writers stop. The reconciliation helper separately fails closed on the exact claims, open questions, actors, assignments, and timestamps that VIQ-15 changes.

The v0.2 importer remains explicit and never overwrites an existing target. `npm run bundle` refuses a dirty tree, records exact commit/tree identity, and creates a deterministic local archive. Human Accept records a compatibility-path decision and its provenance; it does not certify correctness, publication readiness, or publication. Separate `released` and `production-verified` ledger facts require human-supplied external references. This repository has no production deployment workflow or deploy authority for `viq.makscee.ru`; CI and the bundle are validation/local-evaluation paths only. The installer writes an immutable local release directory and atomically switches `current`, preserving `previous`; `rollback-local.sh` switches it back. When `VIQ_STORAGE` already exists, install requires an explicit offline confirmation and uses SQLite's backup API to capture and validate committed main/WAL state before any pointer change. Optional rollback restoration first creates and validates a SQLite-consistent post-candidate preservation copy, then prepares and validates the prior snapshot before replacing the database and removing stale sidecars; it likewise requires `VIQ_RESTORE_STORAGE=1`, `VIQ_STORAGE`, and offline confirmation. Uninstall removes launchers/pointers but preserves release and backup evidence. Nothing here publishes, deploys, or mutates live state.

viqueue is licensed under the [Apache License 2.0](LICENSE). See [SECURITY.md](SECURITY.md) for the bounded private-PoC threat model.
