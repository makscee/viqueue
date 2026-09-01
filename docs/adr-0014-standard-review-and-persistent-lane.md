# ADR 0014: Native Pi pull worker lane

Status: accepted (supersedes the worker-controller portions of the previous candidate ADR 0014)

## Decision

A single ordinary interactive Pi process with the Viq extension installed is one persistent pull-worker controller/lane. `/viq poll` starts it; `/viq stop` cancels future waits and drains rather than silently abandoning an active claim; `/viq status` reports it. `/viq once` is retained as the small useful one-shot diagnostic. Viq does not start Pi, require Herdr, tmux, a daemon, a special worker root/workspace, WebSocket/SSE, or a second queue. Herdr may observe or launch Pi externally but has no worker execution authority.

Model context is disposable. Before the first claim after `/viq poll`, and before every different ticket, the controller calls supported `ctx.newSession({ withSession })` with no parent or setup input, then injects only the canonical ticket contract/history. A Pi session contains one ticket ID only. Sessions are named with ticket key/title where Pi supports naming and are never deleted: they remain inspectable and resumable through `/resume` across controller rotation/restart. Pi `parentSession`, branch, and fork semantics are explicitly rejected: they clone/retain prior conversation history. Preservation means leaving the old JSONL untouched, never parenting a new ticket session from it. Persistent controller state is deliberately small: enabled/mode, worker identity, active claim reference, lease generation, cancellation/rotation guards. It never stores prompts, model messages, tool outputs, or summaries. It is a process-local singleton with an epoch-fenced adapter registration: each replacement extension attaches only its own current Pi session adapter on `session_start` and detaches only that generation on shutdown. The adapter retains only its current command-capable `withSession` context for the next blank transition; a normal `/resume` attaches without that authority, and stale adapters are never called. The replacement instance resumes the singleton.

Pi settlement is not completion. The controller waits for the latest supported settled lifecycle (`agent_settled`, with a tested compatibility fallback only when necessary), then reads Viq's canonical ticket state. If its same fenced claim remains active, it may continue only that ticket in its same session, subject to bounded stalled/continuation handling. It must not claim another ticket. Submit, explicit release, or a blocking question end the episode; an answered blocking ticket becomes eligible through canonical state and is claimed in a new session reconstructed from canonical Viq history.

Claim/pull is atomic and single-flight. Idle polling has bounded backoff and is cancellable; idle waiting creates no model turns. Worker claims carry a 90-second lease expiry; before each worker selection, expired worker leases are transactionally released with an auditable recovery event. Human/manual claims have no lease and remain durable. Worker and active-ticket heartbeats use lease/generation-fenced, idempotent mutations. A crashed/disappeared worker becomes recoverable after expiry; stale-generation mutations are rejected. Waiting workers heartbeat too. Every worker mutation includes a bounded request receipt ID; a response-lost retry with the same fence and ID returns its original result without duplicate events, blocks, questions, releases, or heartbeats.

The existing Machines web surface shows worker identity/name, derived `waiting`, `working`, or `stale/offline` state, a current-ticket link while working, worker heartbeat, and active ticket/claim heartbeat. A worker is stale/offline when its last worker heartbeat is older than 90 seconds (three normal 30-second heartbeat intervals). It exposes no credential, claim token, session capability, secret, or transcript.

## Rejected alternatives

* A same-context ticket loop leaks ticket context.
* Pi `parentSession`/fork/branch rotation retains a prior transcript and is rejected; blank persisted sessions preserve old history without copying it.
* The prior packaged worker-root/pool.json/checkpoint and continuation-timer design makes filesystem state an authority and is removed.
* Global captured rotation context and special `/viq continue` recovery paths are removed; canonical history plus a normal fresh claim is sufficient.
* Herdr/subagent pools, daemons and external supervisors add hidden lanes and authority.
* Session-capability authentication remains a coordinator API security boundary, but is not Pi transcript/controller state.

## Grounded migration audit

| Existing subsystem | Exact paths | Decision and fence |
| --- | --- | --- |
| Native extension command/runtime | `extensions/viq-worker/index.ts`, `worker-runtime.mjs`, `command.mjs`, `credential-store.mjs`, `review-bundle.mjs` | Keep and replace controller flow with session-per-ticket, settlement barrier and heartbeat. These are the ordinary Pi install path. |
| Session capability/claim fencing | `src/store.js`, `src/server.js` | Keep; extend with lease heartbeat and worker projection. It prevents cross-session stale mutations. |
| Pool persistence/continuation recovery | `extensions/viq-worker/pool-state.mjs`, `session-rotation.mjs`, `test/viq-worker-pool.test.js`, `test/viq-session-rotation.test.js` | Delete/replace. It carried `continue_ticket` outside canonical history and captured global rotation context. |
| Extra command paths | `command.mjs`, `index.ts`, `test/viq-command-v3.test.js`, `test/viq-worker-pairing.test.js` | Delete `start`, `claim`, `continue`, `pause`, `resume`; retain minimal poll/stop/status/once. |
| Packaged worker release/install/rehearsal | `scripts/package-viq-worker.js`, `scripts/install-viq-worker.sh`, `scripts/rollback-viq-worker.sh`, `scripts/rehearse-viq-worker.sh`, `test/worker-package.test.js`, `test/worker-install.test.js` | Delete. They require `VIQ_WORKER_ROOT`, immutable releases and an external worker user, contradicting ordinary Pi installation. Git history preserves evidence. |
| Worker browser coordinator harness | `scripts/run-coordinator-worker-browser-e2e.sh`, `test/coordinator-worker-browser-e2e.js`, `test/fixtures/pi-worker-discovery.mjs`, `test/fixtures/real-worker-helper.mjs` | Replace focused assertions with extension/runtime and API/UI tests; no worker-root/harness authority remains. |
| Machine UI/API | `src/server.js`, `src/store.js`, `web/app.js`, `web/app.css`, `test/board-http.test.js` | Keep and minimally extend worker heartbeat projection. |

## Safe recovery and rollback

A live active claim is held only while lease heartbeats succeed. On process loss, no release is fabricated; after expiry an operator or a new worker may recover according to canonical eligibility. Operators use `/viq stop` before intentional shutdown. Roll back by reinstalling the prior npm/package version of the ordinary Pi extension and restart Pi; do not delete Pi session history or Viq data. This repository has no production deploy authority: build/release/production verification remain separately recorded facts.

## Supersession notice

The prior ADR text described pool state, owner-only worker roots, `continue_ticket`, a continuation timer, explicit `/viq continue`, and global rotation context as current design. Those statements are superseded by this accepted ADR and must not be used as operational guidance.
