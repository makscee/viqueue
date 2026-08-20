# Viq dogfood v2 handoff

## Outcome
Candidate implements actor-bound devices, actor-admin authorization, multi-project tickets, compact four-column board/popups, and actor-owned free-pool claims.

## Candidate
- Branch `work/viq-dogfood-v2`; candidate commit before this evidence amend `5ed09d9aa5a4d201c471acf9eb6988d85d1880a5`, tree `e96a80459ad8b393315d03f48852395fd06a6f46`.
- Status was clean after commit and tests; final hashes are reported in the parent response.

## Migration and compatibility
- Idempotent migration adds `actors.role_id/admin`, `devices.actor_id`, pairing actor binding, claim/event device provenance, and canonical `ticket_projects`.
- Existing devices link to same-id actors; historical coordinator actors retain administrative access. Claims normalize through device linkage and preserve known origin devices.
- `tickets.project` and numbering remain primary compatibility fields. Legacy single-project requests, omitted actor in legacy pairing calls, and `device` assignment input remain accepted; responses expose `projects` and actor assignments.
- Existing worker claim shapes remain compatible; authority is actor-owned so a second active device can continue.

## RED/GREEN evidence
- RED contract gaps were captured by new `test/dogfood-v2.test.js`: actor-bound admin/pairing, multi-project/free-pool, and four-column popup behavior were absent on the frozen base.
- GREEN: `TMPDIR=$PWD/.tmp node --test test/dogfood-v2.test.js test/pairing-poc.test.js test/human-history-ui.test.js` → 18/18 pass.
- Full GREEN: `TMPDIR=$PWD/.tmp npm test` → 100 tests, 100 pass, 0 fail.
- Dry-run: `node scripts/reset-dogfood-v2.js --storage .tmp/reset-check.sqlite --preserve-device mair --actor maks --name Maks --dry-run` printed counts only.

## Elevated review envelope: changed auth/claim boundary
- `src/server.js`: admin mutations require authenticated device → active actor → `admin`; worker execution routes still require worker kind. Request claim identity is overwritten with authenticated actor/device.
- `src/store.js`: revoked devices/inactive actors fail authentication; pairing binds selected actor; role names grant no API authority; assignment is actor/role based; free claims are atomic and ordered after eligible assigned work.
- Claims store actor plus origin device. Fencing still requires claim id, actor, generation and secret token. Same-actor devices can continue; cross-actor requests cannot.
- Revocation immediately invalidates bearer access and issuer codes without deactivating the shared actor or discarding its claim.
- Review selected-actor pairing, coordinator-vs-admin authorization, reassignment, cross-actor claim mutation and revocation.

## Changed paths
`scripts/reset-dogfood-v2.js`; `src/server.js`; `src/store.js`; `web/app.css`; `web/app.js`; `web/index.html`; `web/ui-core.js`; `test/board-http.test.js`; `test/cli.test.js`; `test/coordinator-controls.test.js`; `test/dogfood-v2.test.js`; `test/domain.test.js`; `test/human-history-ui.test.js`; `test/pairing-poc.test.js`; `test/private-alpha-trust-boundary.test.js`; this artifact.

## Acceptance trace
- Actors/admin/devices/roles/pairing: v2, coordinator-controls and pairing tests.
- Migration/reset: migration suites plus dry-run above.
- Multi-project OR/dedupe: v2 test.
- Four columns and popup surfaces: v2 and UI static tests.
- Assigned-first/free/cross-actor/shared continuation/provenance: v2 test.
- Lifecycle/security regression: full suite.

## Operator dry-run (do not run on live state now)
```sh
node scripts/reset-dogfood-v2.js --storage /path/to/viqueue.sqlite \
  --preserve-device mair --actor maks --name Maks --dry-run
```
Apply requires literal `--confirm RESET-ALPHA`, uses one immediate transaction and never prints credentials/hashes.

## Risks, blockers, proposal
- Blockers: none.
- Ordinary UI risk: no Tower browser GUI was run. Static tests do not prove real laptop density, mobile scroll or modal ergonomics.
- Proposal: visual dogfood on Maks's laptop after deployment, limited to board density and admin/archive/question popups.
