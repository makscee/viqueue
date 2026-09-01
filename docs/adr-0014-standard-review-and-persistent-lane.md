# ADR 0014: STANDARD review boundary and persistent Pi lane

Status: candidate for review

## Decision

Viq remains a coordinator/ledger. A submission records a versioned, backend-neutral Review Bundle (summary, immutable evidence references, verification steps, tests, caveats, optional preview/screenshots/source identity, and factual release status). It does not build previews, render screenshots, push Git, merge, publish, release, deploy, or verify production. Human Accept decides review correctness only. `not-released`, `released`, and `production-verified` are separate ticket facts and separate ledger events.

A project may require `human-readable` or `visual` proof. UI work and visual-policy work without a preview/screenshot shows a prominent warning and the server requires an explicit proof-absence acknowledgement before Human Accept. Existing projects default to human-readable; legacy submissions remain reviewable.

`/viq poll` is a persistent lane in the visible Pi process. The extension is the controller. It atomically calls the coordinator's claim-next endpoint; only after a verified response does it deliver the ticket contract to the model. It retains one Pi context while that claim is active. Submit, release, or a blocking question durably records the boundary in Viq, closes claim/session authority, checkpoints pool state in an owner-only atomic file, and uses Pi 0.83's supported `ExtensionCommandContext.newSession({parentSession, withSession})`. The new session header links the preserved old JSONL file. A fresh extension runtime then claims at most one new eligible ticket. `/viq once [ticket]` does not persist or rotate.

## Options considered

1. **Same-context loop:** simplest, but leaks prior-ticket context and violates the fresh-context requirement.
2. **Fresh-session extension controller (chosen):** preserves the visible process/controller and old JSONL files while using Pi's supported replacement API. It has the smallest authority surface.
3. **Daemon/external supervisor:** robust across process exits, but adds process-launch/liveness authority that Viq must not own.
4. **Subagent pool:** adds Pi/Herdr coupling, hidden lanes, and credential/context risks; rejected. Core code has no Herdr or pi-subagents dependency.

## State machine

`unpaired -> stopped -> idle(persistent) -> claimed -> {claimed_paused | submitted | released | waiting_for_answer} -> rotation_checkpoint -> fresh_session -> idle`.

`idle -> paused -> idle`; `claimed -> claimed_paused -> claimed`; `idle|paused|claimed -> stop` (stop explicitly releases a claim); `stopped -> once_idle -> claimed_once|once_complete`; revoked credentials fail closed to unpaired. An orphan found before polling enters blocked and no work is delivered. An active claim prevents a second claim. Empty queues use bounded exponential idle backoff without notifications. Blocking questions release the ticket and allow a fresh lane session to consider other eligible work; `/viq continue TICKET` remains exact, provenance-fenced compatibility recovery.

## Production mechanism and authority gap

Source inspection found CI only validates tests/build/e2e and deterministic local bundles. `scripts/install-local.sh` installs an immutable local release and atomically changes a local `current` symlink; ADR 0005 explicitly says this is not publication or production release. The repository contains no workflow or configuration that deploys `https://viq.makscee.ru`, no production credential contract, and no deploy authority. Therefore STANDARD records external release/build/verification references but cannot perform production actions.

Safe proposal (not implemented): an explicitly authorized external release owner consumes a reviewed commit, produces an immutable build, deploys outside Viq, then a human coordinator records the build reference as `released` and a distinct health/evidence reference as `production-verified`. Never infer either from acceptance or merge.

## Migration and rollback

Forward migration adds `project_review_policies` and nullable/default deployment columns. Existing projects default to `human-readable`; old pool-state v1 and exact `/viq continue` remain readable; legacy unstructured submissions remain acceptable. Rollback requires the existing offline SQLite snapshot/binary pairing because older binaries ignore, but do not understand, new facts. Stop the lane first; restore the prior binary and database snapshot together. Session JSONL and submitted artifact references are never deleted. No live deployment is part of this candidate.
