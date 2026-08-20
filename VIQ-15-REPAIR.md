# VIQ-15 bounded repair pass (historical; superseded)

> **Superseded:** This records the blocked execution-authority/Pi canary repair lineage. The accepted pairing PoC design explicitly removes that authority model from the active path. Use `PAIRING-POC-RESULT.md` for the candidate handoff.

Date: 2026-08-20 UTC
Owner: `viq15-dogfood-cutover` / `tower-pi`

## Decision

The bounded repair is ready for independent re-review.

The unsafe root systemd lane was never re-enabled. It is now persistently masked at `/etc/systemd/system/viq-lane.service -> /dev/null`, inactive, and its original unit is preserved mode 0600 as `viq-lane.service.viq15-unsafe-disabled` plus in the exact prestate snapshot.

The primary worker path is now the user-directed Pi-native extension `/viq-worker`, installed for one dedicated unprivileged Unix user and proven with a real authenticated-board tracer. No standalone broker/executor service is active or presented as product UX.

## Authoritative corrections applied

### No separate Start interaction

`88e6782 fix: gate worker claims on explicit human Start` was local-only, never deployed, and was reverted cleanly by `9a47e95`.

Replacement lineage:

- `df0dbc2` — trusted assignment provenance confers single-use internal execution authority;
- `93e9cd1` — unresolved structured blockers fence assignment-triggered launch;
- `a0d80f15441b5b9b1e3d2c8a45ffa6460b7a5f3b` — final tested/deployed repair head, tree `4abe157ef0b013fc307eaee964c6276fdaa5d44e`.

There is no `Start execution` button or stored Ready flag. Creating/editing through authenticated trusted ingress and assigning to an actor or role atomically writes a fenced, single-use `execution_authorities` ledger record. Ordinary local/MCP assignment does not. `claimNext` requires:

- open, unclaimed, non-archived, non-deleted ticket;
- current trusted assignment authority matching the exact actor or one of its roles;
- no unresolved structured blocker.

The authority is consumed in the same `BEGIN IMMEDIATE` transaction as claim acquisition. Assignment change, archive, delete, state transition, or non-lane claim revokes it. UI derives `Waiting` versus `Ready for agent` from ledger truth.

### Pi-native worker scope reset

The earlier standalone broker/executor investigation is preserved at `/root/work/viq15-lane-runtime`:

- safe broker prototype: `92f9756`, follow-up `61f41e0`;
- explicit supersession commit: `07d260ac40fc000476958dd10fbe31206e12458b`, tree `ca376ab4d0014a6d1a5bded7c1cbef1356ab8df1`.

It was never enabled or deployed as the worker product. Its pointer was removed and its temporary Unix users/state were deleted. The source/release evidence remains for review only.

## Deployed core and ingress

- Core commit: `a0d80f15441b5b9b1e3d2c8a45ffa6460b7a5f3b`.
- Core tree: `4abe157ef0b013fc307eaee964c6276fdaa5d44e`.
- Immutable release: `/opt/viqueue/releases/a0d80f15441b5b9b1e3d2c8a45ffa6460b7a5f3b`.
- `/opt/viqueue/current` resolves to that exact release.
- Bundle SHA-256: `bd22bdc3248acf7515fa97874e9ae6b67347d6b4707aa5f4a6f46171ade6a708`.
- `viqueue.service` and `viqueue-phone-gateway.service` are active.
- Core remains loopback-only on 7373; authenticated gateway remains loopback-only on 7443; Tailscale Serve still targets 7443.
- Unauthenticated tailnet `/v1/projects` remains HTTP 403.

A root-owned, group-readable `/etc/viqueue/ingress.env` (root:viqueue, 0640) carries a generated internal ingress credential. No value appears in prompts, argv, source, logs, evidence, or this report. The gateway strips every client `x-viq-*` header and injects internal assignment provenance only after device request authentication. Core/operator units consume the same protected boundary. No existing assignment was retroactively authorized; migration created zero authority rows.

Final DB integrity is `ok`: 4 projects, 20 tickets, 18 claim rows, 146 events, 5 actors, 4 roles, 6 memberships, 19 questions, 1 consumed authority row, and 1 resolved blocker row.

## Pi-native `/viq-worker`

### Source and installation

- Repository: `/root/work/viq-worker-extension`.
- Installed source commit: `1398284ed89a6cf9395f129483f709e63c009286`.
- Tree: `bfdbe508fc9ca09c5be9dcbd83a3d2b100818682`.
- Immutable package: `/opt/viq-worker/releases/1398284ed89a6cf9395f129483f709e63c009286`.
- Pointer: `/opt/viq-worker/current`.
- Normal Pi package install, user settings:
  - `/opt/viq-worker/current`
  - `/opt/viq-worker-provider/void-code.ts`

UX:

```text
/viq-worker start [--actor ID] [--project KEY]
/viq-worker status
/viq-worker pause
/viq-worker resume
/viq-worker stop
```

The extension performs deterministic idle polling without model calls, atomically calls `claimNext`, keeps claim credentials only in extension-process memory, injects only sanitized ticket/history context, and exposes narrow `viq_progress`, `viq_question`, `viq_block`, `viq_submit`, and `viq_release` tools. Ending a model turn does not clear or advance a claim. Submit/release pauses with `rotation_required`; another ticket requires a fresh Pi session rather than a hidden supervisor.

Shutdown attempts an explicit release. A hard crash cannot recover the token from disk; the next start detects a current actor claim and fails closed with `orphan_claim_requires_operator` instead of pulling another ticket.

### Unprivileged boundary

- Dedicated user: `viq-worker`, UID 994, no sudo/docker/system groups.
- Workspace root: `/var/lib/viq-worker/jobs`, mode 0700.
- Canary workspace: `/var/lib/viq-worker/jobs/canary-viq17`.
- Separate Herdr session: `viq-worker-canary2`, run as UID/GID 994 with `NoNewPrivs=1`, `CapEff=0`, `ProtectSystem=strict`, `ProtectHome=yes`, private devices/tmp, and no root Herdr execution session.
- Canary Herdr service was manually started as a transient, non-enabled unit and is now inactive.

While worker lockdown is active:

- built-in shell/user-bash is blocked;
- read/write/edit/find/grep/ls are confined to the owned ticket workspace;
- root SSH, `/root/work`, Docker socket, sudo, and systemd mutation are denied by both extension and Unix/systemd boundaries;
- transient provider bootstrap is consumed and unlinked before Pi starts.

The provider handoff is a canary-only, root-provisioned JSON in `/run/viq-worker`, 0400 and owned by `viq-worker`. The launcher validates it, unlinks it, and sets relay data only in the unprivileged Pi process environment. Tool lockdown begins at session startup, before `/viq-worker start`, so model-visible tools cannot read process credentials. Final `/run/viq-worker/provider.json` is absent.

Relevant hashes:

- provider extension: `6d929e481058830195354d4dbbf0053d657fbf0e1d79c0d07680c4a27b55f6c2`;
- unprivileged Herdr binary: `3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253`;
- worker launcher: `c991607837c554ed5e61bd10f59d305df5cc393ea9ee00fe5f1e527d8b23dcd1`;
- provider provisioner: `0ef4aaf17d665557a9c6248a7993586603847036c7257e276f432094d7b33a4b`.

## Real repaired tracer

Tracer: `VIQ-17` — **VIQ-15 unprivileged Pi-native tracer**.

Final state: done, no claim, no current execution authority, zero unresolved blockers, assigned to `viq-safe-pi`.

Exact lifecycle:

```text
ticket_created
> execution_authority_granted
> assigned
> execution_authority_consumed
> claimed
> progress
> question_asked
> blocked
> question_answered
> block_resolved
> progress
> submitted
> question_asked
> question_answered
> accepted
```

Evidence:

- created and assigned through authenticated browser ingress;
- assignment produced authority and `Ready for agent` without a separate Start action;
- `/viq-worker start --actor viq-safe-pi --project VIQ` automatically claimed it;
- visible unprivileged Pi ran in Herdr pane `w1:p1`;
- Pi created only workspace-relative `receipt.txt`, owner `viq-worker`, 25 bytes, exact content `UNPRIVILEGED PI WORKER OK`;
- SHA-256: `6f3b5cc9837d7bbb19213094032e6383cfa28e2efd8cc2cd07b3ff4be9479700`;
- the model attempted shell hashing and the extension denied shell access;
- Pi posted progress, asked a reviewer, created a structured blocker, and retained the claim;
- Maks answered in Viq with an independently computed hash and resolved the blocker;
- the same claimed Pi context posted progress and submitted;
- Maks accepted through the authenticated board;
- `/viq-worker stop` completed, the transient Pi/Herdr unit stopped, and no provider bootstrap remains.

Screenshots and sanitized ledger evidence:

- `/root/work/viq15-repair-evidence/pi-worker-tracer-assigned.png`
- `/root/work/viq15-repair-evidence/pi-worker-question-answered.png`
- `/root/work/viq15-repair-evidence/pi-worker-tracer-accepted.png`
- `/root/work/viq15-repair-evidence/viq17-ledger.json`
- `/root/work/viq15-repair-evidence/worker-boundary.txt`

## Fland legacy-writer guard

Applied guard source:

- repo: `/root/work/viq15-fland-guard`;
- commit: `081671510b8c19211f7cc039009ffd88336355ed`;
- tree: `e37324b27bb63e1230b20ffaaf591abe3a97f242`.

Installed Fland hashes:

- `kanban_db.py`: `59a2241e568cb2fd74afe1d61cb3df50fe78a12aea3837f3475fcbc4e034ac75`;
- `kanban.py`: `7988faf1edd377aa132be315d52ce3db93cbbdb0322f0acdc9a7c96923f175d9`;
- `semantic_drift/inventory.py`: `e73afb3077df0531ad19f0919e9cba6c020ddea86d5992a3a5ba05f3d09e6c63`.

`/etc/viq-authority/T0-AUTHORITY` is root:root 0444 on Fland. Central Kanban connection/transaction and commitment inventory mutation boundaries fail closed. `kanban list` remains readable without its former mini-dispatch side effect. Repeated post-T0 proof: historical list succeeds; forbidden create returns nonzero; task count remains 14/14; forbidden commitment update returns nonzero and inventory hash remains unchanged. `hermes-gateway.service` and `eva-hermes-dashboard.service` are active.

Exact Fland prestate: `/home/eva-hermes/.hermes/backups/viq15-guard-20260820T104500Z`.

## Tests and immutable evidence

Directory: `/root/work/viq15-repair-evidence`; checksums: `SHA256SUMS`.

- Core unit suite: 98 tests, 98 pass, 0 fail.
- Core build: pass.
- Core source/history secret scan: pass, zero high-confidence matches.
- Full CLI/MCP/browser/phone E2E: pass.
- Pi worker runtime tests: 2 pass, including trusted-only polling, authority redaction, no next pull after submit, shutdown release, and orphan-claim fail-closed behavior.
- Actual Pi package parse/load and real model/tool execution: pass in the canary.
- Literal credential artifact scan across core, worker, guard, and evidence: zero matches.
- Repair prestate checksum verification: all entries pass.

The first E2E attempt lacked isolated Playwright dependencies; after `npm install` in the worktree, a browser expectation also required the corrected `Waiting` projection. The repaired exact-head E2E then passed. Core deploy script initially triggered its rollback trap from `systemctl is-active` exit 3 inside command substitution; prestate was restored, the guard was corrected, and poststate was independently verified before continuing. No unsafe execution unit was enabled during any attempt.

## Exact prestate and rollback

Tower prestate: `/var/lib/viqueue/backups/viq15-repair-20260820T102739Z`.

It contains checksummed online backups of core DB and gateway auth DB, old core/gateway/unsafe-lane units, exact old `/opt/viqueue/current` target, prior absent lane pointer, and captured Tailscale Serve JSON. `sha256sum -c checksums.sha256` passes.

### Tower rollback

```sh
systemctl stop viq-worker-herdr-canary2.service 2>/dev/null || true
systemctl stop viqueue-phone-gateway.service viqueue.service

PRE=/var/lib/viqueue/backups/viq15-repair-20260820T102739Z
install -o root -g root -m 0644 "$PRE/viqueue.service" /etc/systemd/system/viqueue.service
install -o root -g root -m 0644 "$PRE/viqueue-phone-gateway.service" /etc/systemd/system/viqueue-phone-gateway.service

mv /var/lib/viqueue/viqueue.sqlite /var/lib/viqueue/viqueue.sqlite.repair-poststate
rm -f /var/lib/viqueue/viqueue.sqlite-wal /var/lib/viqueue/viqueue.sqlite-shm
install -o viqueue -g viqueue -m 0640 "$PRE/viqueue.sqlite" /var/lib/viqueue/viqueue.sqlite

mv /var/lib/viqueue-phone-auth/phone-auth.sqlite /var/lib/viqueue-phone-auth/phone-auth.sqlite.repair-poststate
rm -f /var/lib/viqueue-phone-auth/phone-auth.sqlite-wal /var/lib/viqueue-phone-auth/phone-auth.sqlite-shm
install -o viqueue -g viqueue -m 0600 "$PRE/phone-auth.sqlite" /var/lib/viqueue-phone-auth/phone-auth.sqlite

old=$(cat "$PRE/viqueue-current.txt")
ln -sfn "$old" /opt/viqueue/current.tmp
mv -Tf /opt/viqueue/current.tmp /opt/viqueue/current
rm -f /etc/viqueue/ingress.env

# Captured Serve prestate had one root handler. Restore its exact captured proxy target.
old_proxy=$(node -e "const x=require(process.argv[1]);console.log(Object.values(x.Web)[0].Handlers['/'].Proxy)" "$PRE/tailscale-serve.json")
tailscale serve reset
tailscale serve --bg --yes "$old_proxy"

runuser -u viq-worker -- env HOME=/var/lib/viq-worker PI_CODING_AGENT_DIR=/var/lib/viq-worker/.pi/agent pi remove /opt/viq-worker/current || true
runuser -u viq-worker -- env HOME=/var/lib/viq-worker PI_CODING_AGENT_DIR=/var/lib/viq-worker/.pi/agent pi remove /opt/viq-worker-provider/void-code.ts || true
rm -f /run/viq-worker/provider.json

# Keep the unsafe legacy lane masked even during rollback.
ln -sfn /dev/null /etc/systemd/system/viq-lane.service
systemctl daemon-reload
systemctl restart viqueue.service viqueue-phone-gateway.service
sha256sum -c "$PRE/checksums.sha256"
```

### Fland rollback

```sh
PRE=/home/eva-hermes/.hermes/backups/viq15-guard-20260820T104500Z
systemctl stop hermes-gateway.service eva-hermes-dashboard.service
install -o eva-hermes -g eva-hermes -m 0644 "$PRE/kanban_db.py" /home/eva-hermes/.hermes/hermes-agent/hermes_cli/kanban_db.py
install -o eva-hermes -g eva-hermes -m 0644 "$PRE/kanban.py" /home/eva-hermes/.hermes/hermes-agent/hermes_cli/kanban.py
install -o eva-hermes -g eva-hermes -m 0644 "$PRE/inventory.py" /home/eva-hermes/.hermes/semantic_drift/inventory.py
rm -f /etc/viq-authority/T0-AUTHORITY
systemctl restart hermes-gateway.service eva-hermes-dashboard.service
```

## Remaining bounded follow-ups

- Add a workspace hash tool so a worker can verify hashes without requesting a reviewer; the current tracer truthfully exercised question/block/resolution instead.
- Replace the canary-only transient relay bootstrap with a durable narrowly scoped provider credential service before unattended startup.
- Independent re-review should rerun the immutable test transcripts, inspect Pi tool gating/provider handoff, and rehearse both Tower and Fland rollback.

READY_FOR_REREVIEW
