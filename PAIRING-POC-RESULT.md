# VIQ-15 pairing PoC result

Date: 2026-08-20 UTC

## Result

The bounded pairing PoC candidate is ready for independent re-review. It was implemented and validated only in `/root/worktrees/viq15-minimal-cutover`. No live service, production database, ticket, deployment pointer, gateway, or authentication state was changed.

Candidate commit: `98aad1589f6382bf3c20254a1c8228cac0e3d519`

Candidate tree: `478265fc84ec5cdfcd74810ca8fc8a3b156052b5`

Authoritative inputs:

- `/tmp/VIQ-POC-PAIRING-AUTH-DESIGN.md`: `1b6aafd39aff2505b803d236308f60d709681a3070d28bfdd2c0ff9ba5ea1d9e`
- `/tmp/VIQ-15-PAIRING-POC-BRIEF.md`: `b6f056d69d2bef002bc137db2a918061d29a1beb71630d655b5a70d247282894`

## Schema and trust delta

The PoC adds only:

```text
devices(id, name, kind=coordinator|worker, token_hash,
        status=active|revoked, created_at, revoked_at)
pairing_codes(code_hash, intended_kind, expires_at, used_at,
              created_by_device_id)
device_roles(device_id, role_id)
```

The first coordinator is created only by the local `viq-bootstrap` command. An active paired coordinator can create a short-lived one-time code. Exchange returns one random long-lived device credential once; only its SHA-256 hash is stored. Codes are hashed, expire, and are consumed transactionally. Revocation rejects future authentication and releases that device's active claims.

Permissions are fixed conditionals at HTTP ingress:

- coordinator: pair/revoke devices, manage flat assignment roles, create/edit/archive tickets, assign, resolve blockers, answer questions, and accept/reject;
- worker: read only its device/role-assigned work, atomically claim, and use its own claim for progress/question/block/submit/release;
- role membership never changes API permissions.

Every API path except health/static assets and unauthenticated one-time code exchange requires a paired device bearer credential. An authenticated worker is explicitly rejected from the exchange endpoint, pairing-code creation, assignment, role administration, question answering, acceptance, and other coordinator operations.

## Uniform claim contract

`Store.#eligible` and `Store.#claimable` are the shared predicate used by exact `claim`, `next`, and atomic `claimNext`:

```text
active paired device of kind worker
AND ticket state=open
AND assignment is that device or one of its flat roles
AND no unresolved blocker
AND no current claim
AND not archived/deleted
```

HTTP direct claim and claim-next call those store methods. CLI and MCP are authenticated thin HTTP clients, and `/viq-worker` calls claim-next. Tests cover unassigned, wrong-device, wrong-role, blocked, active-claim, revoked, direct HTTP, MCP, CLI, and Pi-runtime paths. Takeover is removed.

## Removed and superseded paths

- No active code grants, reads, consumes, revokes, joins, projects, or exposes `execution_authorities`.
- Clean PoC databases do not create that table.
- An already-existing table is left untouched and unused solely so a database can be rolled back with its matching prior binary.
- Operator-token and internal-assignment-provenance authorization are absent from the active server/client/MCP/CLI path.
- Unassigned pickup, separate Start, stored Ready, policy scopes, permission graphs, role inheritance, delegated grants, OAuth/SSO, multi-tenancy, takeover, scheduler, notifier, and worker supervisor were not added.
- `VIQ-15-FINAL.md` and `VIQ-15-REPAIR.md` are explicitly marked historical/superseded.
- `second-repair-evidence/` preserves the interrupted authority-repair RED checkpoint and is explicitly non-product historical evidence.

## Coordinator and worker UX

Coordinator/admin CLI:

```text
viq-bootstrap --storage FILE --id coord --name Coordinator
viq device pair-code --kind worker --device-token CREDENTIAL
viq device revoke DEVICE --device-token CREDENTIAL
viq role create|grant|revoke ... --device-token CREDENTIAL
viq ticket create|edit|accept ... --device-token CREDENTIAL
```

Pi-native worker:

```text
/viq-worker pair CODE [--id ID] [--name NAME]
/viq-worker start [--project KEY]
/viq-worker status|pause|resume|stop
```

The extension refuses pair/start as root. It stores the device credential outside the ticket workspace at `${XDG_STATE_HOME:-~/.local/state}/viq-worker/device-credential`, requires an owner-only non-symlink regular file and directory, and sends the credential only as the HTTP bearer header from extension runtime memory. Prompt, status, events, and normal tool results exclude device and claim credentials. Active file tools reject realpath/symlink escape and shell remains denied.

## Validation and exact outputs

Committed-source validation was run against candidate `98aad1589f6382bf3c20254a1c8228cac0e3d519`.

```text
focused pairing/MCP/CLI/Pi tests: 11 tests, 11 pass, 0 fail
full npm test suite:              103 tests, 103 pass, 0 fail
npm run build:                    built dist/
Pi TypeScript module parse:       extension_parse=ok
npm run scan:secrets:             0 high-confidence matches
git diff --check:                 empty output
```

The deterministic clean-tree bundle was built successfully:

```text
release/viqueue-v0.4.1-rc.tar.gz
SHA-256 77f4d0736a607297ce8cf19796e6ed1a9364f714a2a2f8e6c25e05a1b58d7e1f
```

`test/local-bundle.test.js` installs the archive into a disposable prefix, bootstraps a coordinator, pairs a worker, assigns and claims through installed CLI/server, loads MCP, installs a second immutable release, rolls back to the prior release, uninstalls launchers, and proves ticket data remains.

Exact logs and checksums are under `pairing-poc-evidence/`:

- `focused-tests.txt`
- `full-tests.txt`
- `build.txt`
- `extension-parse.txt`
- `secret-scan.txt`
- `bundle.txt`
- `diff-check.txt`
- `isolated-tracer.json`
- `SHA256SUMS`

## Isolated non-live tracer

`scripts/pairing-poc-tracer.js` used a new temporary SQLite file and loopback ephemeral server only. It performed:

```text
local coordinator bootstrap
> worker pairing-code issue/exchange
> project and reviewer role setup
> assignment to paired worker device
> /viq-worker runtime claim
> progress
> submit
> coordinator approval answer
> accepted/done
```

Sanitized result:

```json
{"ticket":{"id":"POC-1","state":"done","assignee":{"type":"device","id":"tracer-worker"},"claim":null,"unresolved_blockers":0},"paired_device":{"id":"tracer-worker","kind":"worker"},"prompt_count":1,"prompt_contains_device_credential":false,"event_contains_device_credential":false,"lifecycle":["ticket_created","assigned","claimed","progress","submitted","question_asked","question_answered","accepted"]}
```

No tracer credential was written to evidence.

## Release and rollback plan

No installation or pointer change was performed.

The bundle refuses a dirty tree and records `SOURCE_COMMIT` plus `SOURCE_TREE`. `install-local.sh` copies into an immutable `releases/<commit>` directory, preserves the old target as `previous`, then atomically changes `current`. Launch wrappers resolve the real current release before Node startup. If `VIQ_STORAGE` already exists, installation fails unless the operator explicitly confirms it is offline; the script verifies SQLite integrity and records a copy in the release's backup metadata.

`rollback-local.sh` atomically swaps `current` and `previous`. Optional database restoration requires all of:

```text
VIQ_RESTORE_STORAGE=1
VIQ_STORAGE=/exact/path/viqueue.sqlite
VIQ_SNAPSHOT_CONFIRMED_OFFLINE=1
```

It verifies backup integrity and preserves the post-candidate DB as `.pre-rollback`. Uninstall removes launchers/current pointers but deliberately preserves immutable releases and backups.

Before any future live cutover, an operator must stop writers, take and verify the deployment-specific database/gateway snapshots, bootstrap the first coordinator locally, install the candidate release, configure clients with device credentials, and only then switch traffic. That is an install plan, not authorization to deploy.

## Review findings closed

Fresh adversarial review found and this candidate fixed:

- workers could answer text questions: server and store now require coordinator device; regression added;
- clean DB still created the legacy authority table: clean schema now omits it; compatibility preservation is tested;
- extension depended on an unshipped `typebox`: dependency removed in favor of an inline closed JSON schema;
- bundles could attest dirty `HEAD`: bundling now refuses dirty source and records commit/tree;
- local install overwrote one mutable directory: install is versioned with tested rollback and optional verified offline DB restoration;
- Node launch through `current` symlink could fail its direct-main identity check: wrappers resolve the real release path; installed-server test passes.

## Residual bounded risks

- This is a private single-operator PoC, not public-internet or multi-tenant security.
- Device credentials are bearer secrets protected by local filesystem permissions, not hardware-backed keys.
- The browser coordinator UI currently expects a coordinator credential in local storage; the tested minimum admin/pairing surface is CLI. The historical phone-browser gateway is not an alternate PoC identity path and is not ready to front this candidate without a future explicit integration.
- Flat role membership is intentionally not a permission system. Coordinator membership in a reviewer role only controls question targeting; coordinator permission still comes solely from device kind.
- Existing databases may retain unused historical authority rows. They are neither exposed nor consulted; an independent review should confirm this by static search and temp migration.

READY_FOR_REREVIEW
