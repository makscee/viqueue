# Live-agent dogfood runbook

This is the operator checklist for a bounded Viq worker canary. Viq coordinates the ticket lifecycle; it does not start or supervise the worker, execute work, publish artifacts, or accept the result. [ADR 0013](adr-0013-product-charter.md) is authoritative.

## Prerequisites

- Use a dedicated, owned workspace and the repository's required toolchain.
- Confirm the worker is already paired and authorized for the intended assignment with `/viq status`. Pairing is an operator-controlled, one-time setup and **must not be repeated during this canary**.
- Confirm no credential, pairing code, private endpoint, or private provenance will enter source, prompts, progress, questions, or evidence.
- Read the ticket contract and history before changing files. Treat the claim as fenced execution authority, not proof of worker health.

## Acquire the right work

Choose exactly one entry path:

- **Initial work:** run `/viq poll` (optionally `--project KEY`). It atomically claims the first eligible ticket. Inspect `/viq status` and the delivered contract before work.
- **Answered blocking question:** run `/viq continue TICKET-ID`. This re-reads that exact ticket, its questions, and history, validates same-worker provenance, and directly claims only that ticket. It never falls back to claim-next. Do not use ordinary polling for this continuation.

Expected initial state is `Open` with no claim. A successful claim projects as `Working` and carries a durable, generation-fenced claim bound to the worker session. If acquisition fails or returns an unexpected ticket, make no changes and stop; never take over or work without the exact claim.

## Work and report

1. Reconcile the delivered contract, answered questions, ADR 0013, and current source. Fail closed on conflicts.
2. Make only the authorized changes. Keep credentials and other secrets out of files and Viq messages.
3. Use `viq_progress` only for a factual, non-secret milestone useful to an external reviewer. Silence is not health or completion.
4. Use `viq_question` when a reviewer decision is genuinely needed:
   - non-blocking keeps the ticket `Working` and retains the claim;
   - blocking releases the claim, moves the ticket to `Waiting`, and ends the worker turn. After the answer reopens the ticket, start a fresh session and use `/viq continue TICKET-ID`.
5. Use `viq_block` for an actionable blocker when the claim must be retained; the ticket remains claimed and the worker pauses. Do not claim other work from that session.
6. Run focused checks and inspect the final diff. Produce immutable evidence in the worker's own toolchain; Viq neither creates nor publishes it.
7. When publication and immutable references already exist, call `viq_submit` once with a concise outcome and at least one **backend-neutral immutable evidence reference**. Suitable references include a commit plus tree identity, a content digest, an immutable object identifier, or a stable immutable report URL. Do not use a mutable branch name, local path, credential-bearing URL, or claim secret as evidence.

Submission releases the claim, moves the ticket to `Waiting`, creates the approval request, and ends the worker turn. A human or authorized policy reviewer—not the worker—then accepts it to `Done` or requests changes, returning it to `Open`. For requested changes, follow the explicit continuation policy presented by the ticket; do not assume old claim authority remains valid.

## Safe stop, release, and rollback

- `/viq pause` pauses polling only; it does **not** surrender a current claim. `/viq resume` resumes polling.
- `/viq stop` safely stops polling and releases a current claim. Use it only when intentionally ending the live worker path.
- Use `viq_release` with a non-secret reason when returning unfinished work to `Open`; it releases the claim and ends the turn.
- If a release/stop reports failure, assume the fenced claim is still held. Do not retry work through another session or device; report the exact safe error and reconcile claim status first.
- Roll back documentation or code only in the worker workspace using the repository's normal version-control procedure. Viq does not roll back workspaces or artifacts. Never compensate with direct database, service, deployment, credential, or Board mutation.

## Known limits

- Viq does not infer runtime liveness, supervise sessions, publish artifacts, or validate outcome correctness.
- Claims are durable and session-fenced; there is no takeover path. Pairing or assignment establishes eligibility, not process launch.
- `continue` is narrowly limited to a valid answered-question lineage for the same worker identity; stale, cross-device, or review-change lineage fails closed.
- A model turn ending does not complete a ticket. Authority ends only through submission, release, or the defined blocking-question transition.
- Transport status and machine metadata are provenance, not health signals. Use only the configured current Viq adapter; obsolete routes and historical publication workflows are not operational instructions.
