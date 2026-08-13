# Daily Alpha actor/role/question implementation evidence

## Scope and changes
Implemented only the requested actor/role/question vertical slice while retaining one SQLite file, one HTTP state machine, durable no-TTL claims, generation fencing, and monotonic append-only events. Core paths: `src/store.js`, `src/server.js`; adapters: `bin/viq.js`, `bin/viq-import.js`, `src/mcp-server.js`; UI: `web/index.html`, `web/app.js`, `web/app.css`; docs: `README.md`, `CHANGELOG.md`, `release-notes/v0.3.0.md`, `docs/adr-0009-daily-alpha-actors-questions.md`.

Schema migration adds actors (machine/active/created/updated), roles, actor_roles, questions (`text|approval`, requested public field names), typed ticket assignee columns, and event metadata. Accepted v0.3 rows migrate under `BEGIN IMMEDIATE`; legacy assignment/claim strings deterministically become active agents, collisions fail closed, and existing IDs/claims/tokens/generations/events survive. Re-entry and restart are tested. JSON import registers actors before inserting legacy claims.

HTTP/CLI/MCP provide actor create/list/show/update/deactivate, role create/list/grant/revoke/member-list, typed ticket create/edit/filter/eligible-next, question ask/list/answer/inbox, metadata events, and explicit submit reviewer. Stable errors include `actor_not_found`, `actor_inactive`, `assignee_ineligible`, `question_already_answered`, `question_forbidden`, `invalid_question_kind`, `invalid_question_answer`, and `stale_claim`.

Browser has persisted private-alpha actor selection (explicitly not auth), grouped assignment/reviewer/ask targets, machine placement, total/actor badges, prominent inbox, inline text and approval actions, fenced ask without release, and chronological questions/events. Desktop/mobile E2E actually exercises typed assignment, ask, inline text answer, explicit role review submit, and inline accept.

## TDD and validation
Meaningful RED is preserved in `evidence/daily-alpha-red-cycles.txt` (actor APIs absent). Final checks:
- `npm test`: 25 pass, 0 fail (`evidence/daily-alpha-test-output.txt`). Includes independent-connection duplicate-answer race, role-holder/member-list eligibility, lifecycle/revoke, inbox isolation/cursor, metadata response, typed filtering, migration/restart, importer, CLI and MCP adapters.
- `npm run build`: pass (`evidence/daily-alpha-build-output.txt`).
- `VIQ_EVIDENCE_DIR=$PWD/evidence/daily-alpha-e2e npm run e2e`: CLI/MCP/browser pass (`evidence/daily-alpha-e2e-output.txt`, nested logs).
- Browser screenshots: `evidence/daily-alpha-e2e/screenshots/board-desktop.png`, `board-mobile.png`.
- `npm run scan:secrets`: 117 tracked files/history, 0 high-confidence matches (`evidence/daily-alpha-secret-scan.txt`).
- Two final `npm run bundle` runs are byte-identical SHA-256 `1db5b4c717dd9124dd275c0557efd138a23cba59a9a356e2996a9377996bbadc` (`evidence/daily-alpha-bundle-*.txt`, `daily-alpha-bundle-determinism.txt`).
- Independent fresh Pi verifier verdict: ACCEPT, no requirement blockers (`evidence/daily-alpha-verifier.txt`).
- `git diff --check`: pass; `git diff --cached --name-only`: empty.

## Lifecycle coherence
Ask preserves ticket state and current claim. First answer wins with guarded update. Submit validates an eligible target before atomically releasing/entering review/creating exactly one approval and two coherent events. Generic text answers cannot resolve approval. `request_changes` answers and opens without a claim; `accept` answers and completes. Pending approval forbids reopen. Compatibility accept requires exactly one current approval and uses its answer path.

## Residual risks
Private-alpha actor IDs are workflow integrity rather than adversarial authentication, as explicitly documented. Actor tokens remain a proposed future gate. No push, publish, deploy, external settings mutation, or commit was performed.
