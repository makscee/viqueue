# STANDARD bounded repair evidence

## Scope
Single repair atop candidate `9194f279b2474f4c3b96309436b3a42264e78886` for Cass S1 findings only. No S2/S3 work and no push, PR, merge, release, deployment, or production operation.

## Implemented
- Review Bundle and Pi tool schemas now carry independent `source.review` (`not-reviewed`/`reviewed`) and `source.merge` (`not-merged`/`merged`) facts with optional safe references.
- Submitted facts project from the immutable submitted event into the ticket model. Coordinator-only `POST /v1/tickets/:id/source-lifecycle` records positive reviewed/merged reference facts as distinct immutable `review_recorded`/`merge_recorded` events. It performs no Git or deployment action.
- Board Review Bundles show separate Commit, Pull request, Acceptance, Reviewed, Merged, Release, and Production verification rows. Safe HTTP(S) PR and URL-shaped commit values are anchors before Human Accept; unsafe URL protocols are rejected by normalization. The prior `Review/merge` and `Release/deployment` conflated labels are removed.

## Fail first
`workshop/artifacts/standard-repair-fail-first.log` records the first focused run after adding regression tests and before product changes: failure because candidate `9194f279` did not export the required Review Bundle lifecycle/link rendering behavior.

## Tests added
`test/standard-phase.test.js`:
- `review and merge facts are independent and source URLs render as safe links before acceptance`
- `reviewed and merged lifecycle facts have separate coordinator ledger transitions`

## Commands and results
- `node --test test/standard-phase.test.js` — PASS: 7/7.
- `node --test test/standard-phase.test.js test/domain.test.js test/viq-command-v3.test.js test/viq-session-rotation.test.js test/viq-worker-pool.test.js` — PASS: 47 tests, 46 pass, 0 fail, 1 skip.
- `PATH=/tmp/viq-gnu-bin:$PATH npm test` — PASS: 262 tests, 250 pass, 0 fail, 12 skip.
- `npm run build` — PASS: `built dist/`.
- `npm run scan:secrets` — PASS: 0 high-confidence matches.
- `git diff --check` — PASS.

## Acceptance trace
- criterion-1: bounded changes are limited to the two Cass S1 blockers: schemas/ledger/model/events/API/UI lifecycle facts and safe source links. No S2/S3 changes.
- criterion-2: behavioral fail-first log, two focused tests, focused suite, full suite, build, secret scan, changed-path list, and clean-status proof are recorded here and in the final structured report.

## Residual risks
- Browser-level end-to-end clicking was not added; pure UI projection tests prove exact href eligibility and labels, while the Board DOM builder consumes that projection to create anchors with `noopener noreferrer`.
- Existing macOS Linux-only skips remain unchanged (12 skips in full suite).
