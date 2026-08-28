# ADR 0013: Viq product charter and responsibility boundary

Status: accepted; canonical authority for product-boundary questions

## Purpose and mental model

**Viq is a minimal, transport-neutral, durable work-coordination layer through which humans and heterogeneous agents request, claim, discuss, hand off, submit, and review work; the Kanban board is a projection, not the authority.**

In shorter form: **not an agent framework and not merely a task tracker, but the shared work layer between them.** Viq coordinates work, not workers.

## Scope

The Viq service owns one application command layer and its durable record. It may:

- accept work requests and preserve ticket identity, description, assignment, ordering, and lifecycle state;
- expose eligible work and atomically grant a fenced claim to a requesting worker;
- validate claim authority for progress, questions, blockers, release, handoff, and submission;
- record append-only events, questions and answers, outcomes, and immutable evidence references;
- route submitted outcomes to an explicit human or policy review authority and record acceptance or rejection;
- make the same semantics observable through projections such as HTTP, CLI, MCP, and UI.

The browser board is one projection of this record. Neither its columns nor any particular transport is the product kernel.

## Explicit non-responsibilities

Viq does **not**:

- launch, schedule, supervise, poll, pause, resume, or terminate worker processes;
- own terminals, sessions, panes, machines, worktrees, repositories, or execution environments;
- configure models, providers, prompts, agent frameworks, or worker toolchains;
- execute ticket work or infer runtime health, liveness, completion, or failure from silence;
- synchronize repositories, prepare or publish artifacts, select an artifact backend, deploy outcomes, or make a commit the universal evidence format;
- require Git, Vault, Hermes, Herdr, Telegram, Tailscale, a host layout, or any named runtime or publication system;
- accept an outcome as correct merely because a worker submitted it.

Workers and runtimes start independently and call Viq as clients. Artifact production and publication remain operations of the worker's own toolchain or a separate artifact system.

## Lifecycle and authority boundaries

1. **Request and assignment.** A human or authorized client creates work and may assign or expose it according to policy. Assignment/eligibility authorizes a worker to *request a claim*; it is not an instruction from Viq to start a process.
2. **Claim.** A worker independently asks for work. The service atomically checks eligibility and grants one durable, fenced claim. A claim is execution authority over the ticket record, not evidence that a process is alive.
3. **Progress, blocker, question, and handoff.** The claim holder reports factual events and explicit needs. The service records and routes them. It does not inspect the runtime or infer status. A blocking question may release or retain a claim according to the accepted lifecycle policy; that policy does not make Viq a worker supervisor.
4. **Submission.** The claim holder submits an outcome plus immutable evidence references. Evidence is opaque to the kernel except for bounded validation and storage; it may identify commits, objects, reports, URLs, or another backend's immutable references. Submission ends or transfers claim authority and requests review. It does not publish the artifact and does not accept the work.
5. **Review.** A human or separately authorized policy authority accepts or rejects/requests changes. Viq records that decision and applies the corresponding ticket transition. Worker identity and claim authority never imply review authority.

## Transport and backend neutrality

HTTP, CLI, MCP, UI, and future transports are adapters over the same application commands and invariants; none may introduce a second lifecycle or broader authority. The public kernel must remain independent of worker runtime, model/provider, source-control system, artifact store, deployment mechanism, and host topology.

An external adapter or runner is allowed only as an edge client. It may translate a runtime's native events into Viq commands, acquire a claim on that runtime's behalf, or turn a ticket into runtime input. It may also invoke that runtime's own artifact tooling. Such an adapter:

- is optional and replaceable;
- uses public application commands and receives no hidden kernel authority;
- keeps execution, runtime-health, workspace, and publication policy outside the service;
- must not make its backend or operational assumptions part of the Viq contract.

## Responsibility matrix

| Responsibility | Viq service | Worker / runtime | Artifact system | Human / policy reviewer |
| --- | --- | --- | --- | --- |
| Persist ticket lifecycle and event ledger | **Owns** | Calls/reports | No | Observes/commands when authorized |
| Determine claim eligibility and grant fenced claim atomically | **Owns** | Requests and holds authority | No | Defines/changes policy when authorized |
| Start, supervise, and execute work | No | **Owns** | No | No |
| Report progress, blockers, questions, handoff, and outcome | Records and validates | **Owns production of reports** | May supply references | Answers explicit questions |
| Build, store, synchronize, or publish artifacts | No | Invokes its chosen tooling | **Owns** | May govern release separately |
| Submit outcome and immutable evidence references | Records and routes; does not publish or accept | **Owns submission** | Supplies immutable references | No |
| Decide correctness / acceptance / rejection | Records and enforces decision transition | No | No | **Owns** |
| Infer worker/runtime health | No | **Owns** | No | No |

## Decision lineage ledger

The ledger distinguishes recovered product intent from later accepted refinements and from implementation drift. A source supports only the statement attributed to it.

| Class | Decision | Provenance | Canonical status | Conflict / disposition |
| --- | --- | --- | --- | --- |
| Recovered original | “Build a minimalist, customizable, open-source agent-managed Kanban capable of coordinating agents at any level.” | Founding Maks brief, 2026-08-12. | Retained as product motivation, not a complete architecture. | Do not infer transports, claim details, or publication behavior from this sentence. |
| Recovered original synthesis | Kanban is a projection; the core is a minimal open protocol/shared durable work layer between humans and heterogeneous agents. Work is created, claimed, optionally decomposed, reported, handed off, submitted with evidence, reviewed, observable, and resilient across restarts. | Accepted initial synthesis, 2026-08-12. | Restated and canonical here. | Later board- or runtime-specific descriptions cannot narrow the kernel to one projection or toolchain. |
| Initial public implementation | A minimalist, customizable central ticket dispatcher; workers pull and explicitly claim tickets using fenced claim credentials; Viq never launches, supervises, or polls workers. | Commit [`4381ea4`](https://github.com/makscee/viqueue/commit/4381ea4), `README.md` “Phase-0 contract”. | Retained where compatible with later authorization refinements. | This commit does not establish the complete accepted initial synthesis above. |
| Later accepted refinement | One service-side state machine; transports are projections/thin clients. | `docs/adr-0002-phase1-contract-and-mcp.md`, `docs/adr-0003-phase2-board-projection.md`, and commit [`436cf5e`](https://github.com/makscee/viqueue/commit/436cf5e) (`docs/adr-0008-v03-daily-alpha-core.md`). | Retained and generalized to one application command layer. | Transport-specific behavior must not become a second authority. |
| Later accepted refinement | Claims are durable fenced authority, not liveness; progress is observation; submission and review are separate. | `docs/adr-0008-v03-daily-alpha-core.md` and `docs/adr-0009-daily-alpha-actors-questions.md` at commits [`436cf5e`](https://github.com/makscee/viqueue/commit/436cf5e) and [`4ebc952`](https://github.com/makscee/viqueue/commit/4ebc952). | Retained, except those ADRs' explicitly superseded actor/takeover details. | Silence and machine metadata must never be treated as runtime health. |
| Later accepted refinement | Pairing and role assignment constrain claim eligibility; exact assignments are preferred, while eligible unassigned free-pool tickets may be claimed within project, role, and membership boundaries; no scheduler or worker supervisor is introduced. | `README.md` and `docs/adr-0012-pairing-poc.md` at commit [`5a68920`](https://github.com/makscee/viqueue/commit/5a68920); ADR 0012 records the original stricter rule and its supersession. | Retained as the current private-PoC authorization refinement. | “Launch authorization” means permission to request a claim, not authority or ability to launch a worker. |
| Implementation drift | The bundled Pi worker synchronizes a specific Vault before claiming and publishes it before submission, making a commit mandatory evidence. | Commit [`5a68920`](https://github.com/makscee/viqueue/commit/5a68920): `extensions/viq-worker/vault-sync.mjs`, `extensions/viq-worker/worker-runtime.mjs`, `extensions/viq-worker/index.ts`, and former active wording in `README.md`. | Not a product feature or kernel contract. | Treat this coupling as legacy implementation drift and a retirement target. Any replacement must be an optional edge adapter with artifact-neutral submission. Do not use it as an operational workflow or active debt route. |
| Later product/UI refinement | Activity/questions lead the interface; Agent lifecycle, not board drag, owns Agent state transitions; machine is provenance rather than assignment. | `CONTEXT.md` and `DESIGN.md`, commit [`54b25ec`](https://github.com/makscee/viqueue/commit/54b25ec). | Compatible UI/domain refinement. | These documents govern vocabulary and interface composition, not process or artifact ownership. |

## Compatibility and supersession

This ADR is the first authority whenever product responsibility, execution ownership, runtime integration, or artifact publication is in question. Earlier ADRs remain historical evidence for their bounded decisions. Their lifecycle, UI, storage, authentication, and release decisions continue where they do not conflict with this charter.

Specifically:

- “launch authorization” in `README.md` history or ADR 0012 is read as **claim eligibility**, never process launch;
- runtime-specific guidance in `MVP-DESIGN.md` remains superseded historical material;
- `DESIGN.md` remains the accepted VIQ-S1 interface contract, subordinate to this product boundary;
- legacy worker/Vault coupling is descriptive code history only, not current product behavior or an endorsed adapter design;
- current code that conflicts with this charter is drift to be retired in a separately reviewed implementation change. This ADR does not change code, schema, services, deployment, or live state.
