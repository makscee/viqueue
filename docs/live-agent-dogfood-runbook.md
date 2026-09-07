# Live-agent dogfood runbook

This checklist defines a bounded, CLI-first Viq canary. It exercises public CLI commands only. It does not verify a live deployment or claim adapter integration. Viq records authorized completion and provenance; it does not start or supervise workers, certify correctness, or publish artifacts. [ADR 0013](adr-0013-product-charter.md) is authoritative.

## Preconditions and secret handling

- Use one pre-created `Agent` ticket in `Open` with no claim or unresolved blocker. Record its project and ticket IDs as `PROJECT` and `TICKET_ID`.
- Use an already paired coordinator and worker. Pairing is operator-controlled setup, not part of each canary. If a one-time worker pairing is explicitly in scope, redeem it once with `viq device pair CODE`; never place the code in a prompt or file.
- Put `VIQ_URL` and each shell's `VIQ_DEVICE_TOKEN` only in that shell's environment. Disable persistent shell history for the canary. Keep device credentials, session capabilities, claim tokens, private endpoints, and private provenance out of prompts, files, ticket text, questions, outcomes, and evidence.
- Run the coordinator and worker steps in separate shells. Do not copy raw CLI output into prompts or durable files.

The examples name values as shell variables for clarity. Populate secret variables from CLI responses only in the ephemeral worker shell. Claim tokens are required CLI inputs; do not log or persist the expanded command line.

## 1. Open a worker session and claim

In worker shell A:

```text
viq session open
export VIQ_SESSION_CAPABILITY=<returned session capability>
viq ticket claim-next --project "$PROJECT"
export CLAIM_ID=<returned claim ID>
export CLAIM_TOKEN=<returned claim token>
export GENERATION=<returned generation>
```

Confirm the returned ticket is exactly `$TICKET_ID`, its state is `Working`, and its claim fence matches the captured values. If acquisition fails or returns another ticket, make no changes and stop. Assignment is claim eligibility, not an instruction from Viq to launch work.

Optional factual progress uses the same fence:

```text
viq ticket progress "$TICKET_ID" --claim-id "$CLAIM_ID" --claim-token "$CLAIM_TOKEN" --generation "$GENERATION" --request-id canary-progress-1 --message "Bounded canary started"
```

## 2. Exercise the blocking-question boundary

Still in worker shell A, ask one ordinary blocking question:

```text
viq question ask "$TICKET_ID" --claim-id "$CLAIM_ID" --claim-token "$CLAIM_TOKEN" --generation "$GENERATION" --request-id canary-question-1 --text "May the bounded canary proceed?" --blocking
```

Require the response to show `Waiting` with no active claim. The blocking transition releases the claim; it does not preserve continuation authority. Close shell A's worker session and clear its secrets:

```text
viq session close
unset VIQ_SESSION_CAPABILITY CLAIM_ID CLAIM_TOKEN GENERATION
```

If the question call or session close fails, stop and reconcile server state before any reclaim attempt.

## 3. Answer through the coordinator CLI

In the coordinator shell:

```text
viq question list "$TICKET_ID" --status open
viq question answer "$TICKET_ID" <question ID> --answer "Proceed within the bounded canary." --request-id canary-answer-1
```

Require the answer response to identify the same ordinary text question and show the ticket as `Open`. Repeating the exact answer command with the same request ID is an idempotency check and must return the recorded answer. This command answers text questions only; it is not an approval Accept command.

## 4. Reclaim only from a fresh worker session

In a fresh worker shell B with the paired worker credential in `VIQ_DEVICE_TOKEN`:

```text
viq session open
export VIQ_SESSION_CAPABILITY=<new returned session capability>
viq ticket claim "$TICKET_ID"
export CLAIM_ID=<new returned claim ID>
export CLAIM_TOKEN=<new returned claim token>
export GENERATION=<new returned generation>
```

Require a new session ID and a fresh claim generation. Read the ticket and answered-question history before proceeding. Never reuse shell A's capability or claim fence.

## 5. Record direct completion

Run focused checks in the worker's own toolchain and inspect its final diff. If they pass, record the outcome through the direct completion command:

```text
viq ticket complete "$TICKET_ID" --claim-id "$CLAIM_ID" --claim-token "$CLAIM_TOKEN" --generation "$GENERATION" --request-id canary-complete-1 --outcome "Bounded CLI canary completed" --evidence "<opaque immutable reference>"
viq session close
unset VIQ_SESSION_CAPABILITY CLAIM_ID CLAIM_TOKEN GENERATION
```

Use only backend-neutral immutable evidence that already exists, such as a commit/tree identity, content digest, immutable object ID, or stable immutable report URL. Omit `--evidence` when no truthful immutable reference exists. Never use a mutable branch, local path, credential-bearing URL, or secret.

Require completion to show `Done` with no claim. This is a Viq record of the authorized worker's completion report and provenance, not proof of correctness, publication readiness, publication, or live adapter behavior.

## Optional compatibility path

`viq ticket submit` and coordinator `viq ticket accept` remain legacy compatibility commands for an external workflow that elects review. They are not required by this canary or by the Viq kernel. The external runtime or publication system owns review requirements, reviewer separation, artifact validation, and publication.

## Safe stop

- Before a blocking question, use `viq ticket release` with the current fence to return unfinished work to `Open`, then close the session.
- After a blocking question, the claim is already released; close the old session and do not continue from it.
- If release, question, answer, reclaim, completion, or close returns an unexpected result, stop. Do not compensate through direct database, browser Board, deployment, credential, or repository mutation.
- Viq does not infer runtime liveness. Silence and machine metadata are not health signals, and there is no takeover path.
