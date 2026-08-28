# VIQ-15 — Minimum forward-only dogfood design

Status: superseded historical design; [ADR 0013](docs/adr-0013-product-charter.md) is authoritative for product boundaries, and ADR 0012 replaces this document's unassigned-claim and pairing guidance. Its lane/runtime and publication material is historical implementation drift, not a current feature or operational workflow. Do not implement or deploy this document.

Date: 2026-08-20 UTC
Owner: tower-pi
Status: implementation candidate

## Audited prestate

- Live ticket `VIQ-15` is open, assigned to `tower-pi`, and already claimed by `tower-pi`. Claim authority is not copied into this document.
- Production service: `viqueue.service`, loopback `127.0.0.1:7373`, SQLite `/var/lib/viqueue/viqueue.sqlite`, Node 22, unit `/etc/systemd/system/viqueue.service`.
- Deployed source: `/opt/viqueue/releases/0ab6f1dcb98e33f4c7f6e128f9e41feeaa7ca8f0`, source commit `0ab6f1dcb98e33f4c7f6e128f9e41feeaa7ca8f0`; deployed files match that commit except release-generated installer/source marker files.
- Reviewed forward source candidate from VIQ-12: commit `7654b07b7867592c05a44ac3d9061b77f78027d9`, tree `c09e9829f8fd67e076238b350697b9d6c78664d6`. It descends public `40deb87eefb2abbab37761d365403e37d2192cfc` and is intentionally ahead of deployed `0ab6f1d`.
- Current public ingress is Tailscale Serve HTTPS directly to the core at `127.0.0.1:7373`. Safe probes prove unauthenticated mutation requests reach core domain handlers. Operator-only routes are bearer protected, but project/ticket/claim/edit routes are not ingress-authenticated.
- UI is live and renders four board columns with VIQ-15 visible. Core API and MCP are live; MCP exposes 31 tools. `ticket_next` and `ticket_claim` are separate, so acquisition is not atomic.
- SQLite is WAL mode, integrity check is `ok`, and live counts at audit were 4 projects, 18 tickets, 16 claims, 101 events, 4 actors, 4 roles, 6 memberships, and 16 questions.
- A SQLite online-backup proof and disposable restore both passed integrity checks. A stable table/key-ordered ledger export was byte-identical across two runs and excludes `claim_id` and `token_hash`.

## Truth reconciliation at T0

No history is deleted.

- Keep VIQ-11 and VIQ-12 done as the accepted audit/lineage chain.
- Archive VIQ-3 through VIQ-8 as obsolete superseded review-chain work after posting one explicit classification note per ticket.
- Keep VIQ-9 done.
- Archive VIQ-10 as superseded by this deliberately smaller one-lane cutover; it proposed a generic multi-session extension, heartbeat/presence, and context rotation outside MVP.
- Keep VIQ-13 visible/open because its publication result remains live work.
- Mark VIQ-14 rejected by an explicit human note recording the failed bootstrap and then archive it. Archive releases its stale claim but retains the full ledger.
- Keep VIQ-1 visible but archive it as superseded by VIQ-15 after a classification note.
- Keep VIQ-15 live through acceptance.

The reviewed candidate already provides archive/restore with retained event history. Archive is used as closed; no new ticket state is introduced.

## Minimum delta

### Viq kernel (ledger only)

Add one transaction-scoped operation, `claimNext({project, actor})`, and one matching HTTP/MCP/CLI surface. Inside one `BEGIN IMMEDIATE`, it selects the first eligible assigned/unassigned open ticket and inserts its fenced claim before commit. It returns no ticket when none is eligible. No scheduler, lease, heartbeat, launcher, or presence model is added.

### Authenticated mutation ingress

Deploy the reviewed phone gateway already present in candidate `7654b07` on loopback `127.0.0.1:7443`, with its separate root-owned auth database and explicit external TLS termination. Transactionally repoint Tailscale Serve HTTPS from core `7373` to gateway `7443`. The gateway authenticates every `/v1/` request with per-request device proof and strips spoofable headers. Core remains loopback-only for trusted local worker/operator processes. Funnel/public ingress remains forbidden.

Fail-closed gate: gateway health and an authenticated browser/API smoke must pass before changing Tailscale Serve. After the switch, an unauthenticated tailnet `/v1/` request must fail. Any failed check restores the exact prior Serve JSON target.

### One external Tower lane

Runtime glue is installed outside the Viq source tree and runs as one systemd service under a dedicated local account. It:

1. starts idle and refuses to pull if a private current-authority file exists;
2. calls the loopback atomic claim-next endpoint for actor `tower-pi`;
3. writes the complete claim authority only to a mode-0600 volatile runtime file;
4. sends a fresh prompt to one prestarted, visible Herdr/Pi pane containing only the ticket title/body and Viq event history plus generic completion instructions;
5. exposes fixed-purpose local helper commands for progress, question, submit, release, and block. Helpers read authority from the private runtime file; credentials never enter prompts, shell history, ticket events, source, or evidence;
6. refuses another pull until submit/release, while block records a progress event and retains the claim.

The lane is one fixed actor and one fixed Herdr agent. It is not a generic launcher or scheduler.

### Tracer

Create one disposable board ticket assigned to `tower-pi` through the authenticated browser. The lane must claim it atomically, become visibly named in Herdr, post progress/evidence, submit to the human reviewer, and be accepted through the authenticated board. Record only ticket/event IDs and non-secret evidence.

### Forward-only authority

At accepted tracer time T0, write a root-owned marker and policy note declaring Viq authoritative for all newly actionable work. Install a guard that rejects new writes to the legacy Command/commitments intake while leaving all historical stores readable and untouched. Historical import is a later ticket.

## Transactional deployment

1. Capture unit files, Tailscale Serve state, release pointer, service state, online SQLite backup, checksums, and legacy-write policy prestate.
2. Stage immutable release directories; do not modify the dirty `/root/work/viqueue` checkout.
3. Start candidate core against a disposable restored DB and pass tests/smokes.
4. Install candidate core unit, restart, and verify local health/API/UI/MCP.
5. Start gateway, verify authenticated browser/API, then repoint Serve and verify unauthenticated tailnet API fails closed.
6. Start the single precreated lane; run tracer.
7. Reconcile/archive stale tickets and establish T0 freeze only after tracer acceptance.
8. On any failed gate, automatically restore the exact unit, release, Serve state, DB snapshot when a DB mutation occurred, and legacy-write policy; then restart and re-run prestate health checks.

## Explicit rollback

- Stop and disable the lane and gateway.
- Restore the captured Tailscale Serve configuration targeting `http://127.0.0.1:7373`.
- Restore `/etc/systemd/system/viqueue.service` and its original ExecStart release `0ab6f1d...`; daemon-reload and restart.
- If schema/data validation fails, stop core, preserve the failed DB, restore the online backup to `/var/lib/viqueue/viqueue.sqlite` with original owner/mode, then restart and verify integrity/health.
- Remove only the new T0 guard/marker and restore captured legacy-write policy. Never delete legacy data.
- Archive/revoke the separate gateway auth DB according to policy. No credential material is copied into rollback artifacts.

## Non-MVP backlog

Historical import; generic `/viq-worker`; multi-lane scheduling; presence/leases/heartbeats; remote launching; Mac mutation; public release; broader IAM; publication capability work.
