# VIQ-15 final — minimal forward-only dogfood cutover (historical; superseded)

> **Superseded:** This records failed root-lane lineage only. It is not an accepted install, operations, or rollback guide. The pairing PoC candidate and `PAIRING-POC-RESULT.md` replace its active recommendations without rewriting history.

Date: 2026-08-20 UTC
Owner: tower-pi

## Result

The minimum private dogfood path is live:

- a board-created ticket assigned to `tower-pi` is atomically selected and claimed by one prestarted Tower lane;
- its title, body, and Viq event history are the sole task context sent to a fresh visible Herdr/Pi pane;
- claim authority stays in `/run/viq-lane/current.json` mode 0600 and is never placed in prompts, terminal commands, ticket events, source, or evidence;
- the lane records progress and must submit, release, or block before another pull;
- Tailscale HTTPS now terminates at the authenticated browser gateway, not the unauthenticated core;
- the real tracer `VIQ-16` completed create, assign, claim, visible execution, progress, submit, and board acceptance;
- the forward-only T0 marker freezes new Command/commitments intake while preserving every legacy store.

## Exact revisions and deployment

### Audited prestate

- Dirty checkout preserved untouched: `/root/work/viqueue`, `f143ac5bc718eda791fbfc9e7bf5ae3a803a8747`, still ahead 3/behind 4 with only the two pre-existing modified screenshots.
- Core release: `/opt/viqueue/releases/0ab6f1dcb98e33f4c7f6e128f9e41feeaa7ca8f0`.
- Deployed source commit: `0ab6f1dcb98e33f4c7f6e128f9e41feeaa7ca8f0`.
- Reviewed VIQ-12 candidate: `7654b07b7867592c05a44ac3d9061b77f78027d9`, tree `c09e9829f8fd67e076238b350697b9d6c78664d6`.
- Core listener: `127.0.0.1:7373`; Tailscale Serve previously proxied directly to it.
- Store: `/var/lib/viqueue/viqueue.sqlite`, WAL mode, integrity `ok`.

### Live poststate

- Kernel implementation/deployed source: `154c6f731851cf09617726caa3036d76de3a2639` on branch `viq15-minimal-cutover`.
- Immutable core release: `/opt/viqueue/releases/154c6f731851cf09617726caa3036d76de3a2639`.
- Release bundle SHA-256: `f36a79bafd493d3a2a932e1847ec7b2cbdcc0823b19a28241e7006728e576d40`.
- External lane runtime release: `/opt/viq-lane/releases/6682a1cb0ce36232490dbbb722929a0be7ec1bd39fa1221e388fb37e30fc1e01`.
- Lane source hashes:
  - `viq-lane.mjs`: `f16690b41ba31f7047207a026f4d1c62c5ab865fbd918a38292c47e29d7a064c`
  - `viq-lane-action.mjs`: `8cf335b66e4d86aeed00bddae1ef7c713384665143b135fd4582f0304a5123f1`
- Active services: `viqueue.service`, `viqueue-phone-gateway.service`, `viq-lane.service`, and `herdr-void-vault.service`.
- Tailscale Serve target: `http://127.0.0.1:7443` (authenticated gateway).
- Core remains loopback-only at `127.0.0.1:7373` for trusted local worker/operator boundaries.
- T0: `/etc/viq-authority/T0-AUTHORITY`, root:root, mode 0444.
- Final DB: integrity `ok`; 4 projects, 19 tickets, 17 claim rows, 128 events, 4 actors, 4 roles, 6 memberships, 17 questions.

## Truthful board reconciliation

History was retained; nothing was deleted.

- Archived with explicit superseded/obsolete classification: `VIQ-1`, `VIQ-3`, `VIQ-4`, `VIQ-5`, `VIQ-6`, `VIQ-7`, `VIQ-8`, `VIQ-10`.
- `VIQ-14` received an explicit `REJECTED/CLOSED` note and was archived; its stale claim was released by archive.
- `VIQ-11` and `VIQ-12` remain done as the accepted audit/lineage chain.
- `VIQ-13` remains visible, open, and claimed because publication is still live separate work.
- `VIQ-15` remains visible, open, and claimed pending the coordinator's credentialed submit/accept events.
- Tracer `VIQ-16` is done.

## Backup, export, and restore evidence

### First live proof

Directory: `/root/worktrees/viq15-minimal-cutover/evidence/viq15/backup-proof`

- SQLite online backup integrity: `ok`.
- Disposable restore integrity: `ok`.
- Backup and restored SQLite SHA-256: `889ab11313188b7af03b1fdd4a3071c07b9fee252dadc1c7c27343b6e1886111`.
- Deterministic ledger export SHA-256: `0402f7e8cbd6ca583a0652c49845724a53bee35c337ca44a295b252c5ffebdb8`.
- A second export from the disposable restore was byte-identical.
- Export excludes `claim_id` and `token_hash`; artifact scan found no authority values.
- Private SQLite copies are confined to `/var/lib/viqueue/backups/viq15-20260820T092416Z`, owner `viqueue`, mode 0600.

### Exact cutover prestate

Directory: `/var/lib/viqueue/backups/viq15-cutover-20260820T093900Z`

Contains the online SQLite backup, exact old unit, exact old Tailscale Serve JSON, and `checksums.sha256`. `sha256sum -c` passes for all three files; backup integrity is `ok`.

## Authenticated ingress evidence

- Before: safe no-op probes showed unauthenticated `POST /v1/projects`, ticket edit, and claim requests reached core domain handlers rather than an ingress auth rejection.
- After: unauthenticated tailnet `GET /v1/projects` returns HTTP 403.
- Authenticated persistent browser returns HTTP 200, loads the board without page errors, and reads tracer `VIQ-16` as done.
- Local core `/health` returns `{"ok":true}`.
- MCP initializes as v0.4.1, exposes 32 tools, and includes `ticket_claim_next`.
- The browser gateway's active pairing was rotated after a killed test browser invalidated its local profile; the final profile was paired and verified, and no pairing material remains under `/run` or in evidence.
- One failed cutover probe allowed a transient pairing intent to appear in local command error output. It was immediately invalidated by deleting that new auth DB, then replaced. No claim credential was exposed and no durable credential artifact remains.

## Worker lane and tracer evidence

Tracer: `VIQ-16` — `VIQ-15 disposable dogfood tracer`.

Exact ledger lifecycle:

`ticket_created > assigned > claimed > progress > progress > submitted > question_asked > question_answered > accepted`

Key evidence:

- Creation actor: `maks`; assignment: actor `tower-pi`.
- Atomic claim: `tower-pi`, generation 1.
- Visible Herdr owner: `viq-viq-16`, pane `wC2:p1`, final status `done`.
- Receipt: `/root/work/viq15-tracer/receipt.txt`, exact 20-byte content `VIQ DOGFOOD TRACE OK`.
- Progress event records exact receipt verification.
- Submission evidence is the receipt path; claim was released on submit.
- Board acceptance note records that exact receipt and full tracer path were verified.
- `/run/viq-lane/current.json` is absent after submit, proving authority cleanup and pull-gate release.
- Lane service remains active and idle; no second ready assigned ticket was pulled.

Screenshots:

- `evidence/viq15/authenticated-board.png`
- `evidence/viq15/reconciled-board.png`
- `evidence/viq15/tracer-created-assigned.png`
- `evidence/viq15/tracer-accepted.png`
- `evidence/viq15/final-authenticated-board.png`

## Tests and self-audit

- Full kernel suite: 96 tests, 96 pass, 0 fail.
- Build: pass.
- Source secret scan: pass, 0 high-confidence matches.
- Runtime lane integration: pass (private authority file, prompt redaction, progress, submit, pull gate).
- Candidate against disposable production restore: health 200, atomic claim-next 200, browser 200/no page errors, DB integrity `ok`.
- Production: core/gateway/lane/Herdr services active; DB integrity `ok`; prestate checksums pass; unauthenticated tailnet API 403; MCP claim-next present; tracer done; lane authority cleared.
- Targeted artifact scan: no claim authority or pairing values in design, final/runtime source, or evidence text.
- Deployment script encountered three preflight defects (Serve config capture syntax, legacy Serve config capture behavior, and self-host DNS resolving to LAN instead of the Tailscale IP). Each failure invoked automatic rollback. Post-rollback checks proved old `0ab6f1d` ExecStart, Serve target `7373`, 101-event prestate, and DB integrity `ok` before retry.

## Exact rollback

Rollback intentionally returns to the pre-cutover state and therefore removes reconciliation/tracer/T0 mutations from the active DB while preserving the failed/poststate DB separately for forensics.

```sh
systemctl disable --now viq-lane.service viqueue-phone-gateway.service

tailscale serve reset
tailscale serve --bg --yes http://127.0.0.1:7373

install -o root -g root -m 0644 \
  /var/lib/viqueue/backups/viq15-cutover-20260820T093900Z/viqueue.service \
  /etc/systemd/system/viqueue.service
systemctl daemon-reload
systemctl stop viqueue.service

mv /var/lib/viqueue/viqueue.sqlite \
  /var/lib/viqueue/viqueue.sqlite.failed-$(date -u +%Y%m%dT%H%M%SZ)
rm -f /var/lib/viqueue/viqueue.sqlite-wal /var/lib/viqueue/viqueue.sqlite-shm
install -o viqueue -g viqueue -m 0640 \
  /var/lib/viqueue/backups/viq15-cutover-20260820T093900Z/viqueue.sqlite \
  /var/lib/viqueue/viqueue.sqlite

rm -f /etc/viq-authority/T0-AUTHORITY \
  /etc/systemd/system/viq-lane.service \
  /etc/systemd/system/viqueue-phone-gateway.service \
  /usr/local/bin/viq-lane-action
rm -rf /var/lib/viqueue-phone-auth
systemctl daemon-reload
systemctl restart viqueue.service

curl -fsS http://127.0.0.1:7373/health
sha256sum -c /var/lib/viqueue/backups/viq15-cutover-20260820T093900Z/checksums.sha256
```

Do not delete either immutable release or any legacy Command/commitments/Vault history during rollback.

## Remaining non-MVP backlog

- Historical import and any legacy classification not covered above.
- Publication capability (`VIQ-13`/rejected `VIQ-14`) as separate work.
- Generic `/viq-worker`, multiple lanes, scheduling, leases, presence, heartbeat, or remote launch.
- Mac mutation or public release.
- Broader IAM beyond the accepted private-alpha browser-device and claim-authority boundaries.
- A maintained coordinator-side hard guard for the organizational Command/commitments freeze; Tower has no running Hermes Command writer or local Command database, so T0 is a root-owned policy gate and all Tower actionable intake is now Viq-only.

MVP_READY
