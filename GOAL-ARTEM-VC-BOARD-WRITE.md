# Goal: exact VC-only board-state write capability for Artem

## Lane and owner
- Lane: Elevated, narrow auth/write boundary.
- One implementation owner in visible Herdr/Pi on Tower.
- One independent consolidated review after owner green; one bounded repair maximum.

## Current production
- Canonical public Browser/Board: https://viq.makscee.ru/
- Authoritative backend: mcow `viqueue-alpha.service`, current release merge `c108aad0968d5b2a2a2b23ce7b220ac574cc5def`.
- Existing paired browser identity: actor `artem`, device `artems-macbook-pro`, kind `coordinator`, actor active, admin false.
- Existing gateway read broker permits board reads for this exact paired identity and blocks writes before upstream.
- Worker model is out of scope and must remain unchanged.

## Required capability
Through the existing paired browser session, Artem can change board state for **only** ticket IDs `VC-1`, `VC-2`, `VC-3`, `VC-4`, `VC-5` to one of `Open`, `Working`, `Waiting`, `Done`.

## Frozen authorization contract
1. Exact local identity: actor_id=`artem`, device_id=`artems-macbook-pro`, kind=`coordinator`, status=`active`, admin=false.
2. Exact object allowlist: only `VC-1` through `VC-5`; also verify upstream ticket project is literally `VC` before mutation.
3. Exact operation: board-state transition only. No ticket create/edit/archive, assignment, notes, questions, history mutation, roles, actors, devices, pairing, worker operations, or other writes.
4. Exact input schema: only `{state}` with state in `Open|Working|Waiting|Done`; reject unknown fields, malformed IDs, redirects, and browser-selected upstream authorization.
5. Preserve current read broker and admin path. Never forward browser credentials/proof upstream as authority. Inject only server-side upstream credential after local proof and exact policy checks.
6. Fail closed before upstream contact for wrong actor/device/kind/status, any ticket outside allowlist, any non-state write, invalid body, or missing upstream credential.
7. Audit truth: the upstream shared admin credential currently records actor `maks`. Do not fabricate direct upstream attribution. Add a bounded truthful event/audit message only if there is an existing safe supported mechanism; otherwise document this attribution limitation explicitly as debt. Do not expand scope into a new delegated-identity architecture.
8. Browser UI: show state controls for the exact scoped paired identity on VC-1..VC-5 only; no generic admin UI. Controls must read back success/failure and refresh the board.
9. Worker eligibility and worker routes must remain byte/behavior unchanged.

## Test contract
Start with focused RED tests, then implement:
- positive: exact Artem paired coordinator may move VC-1..VC-5 through each allowed state;
- negatives: VC-6, VV-*, VIQ-*, LIVE*, PRIVATEA*, malformed/encoded IDs, wrong actor, wrong device, inactive/revoked device, worker kind, unpaired/unsigned browser, unknown field, invalid state;
- prove all other write routes remain blocked before upstream;
- prove browser-selected Authorization/upstream token is stripped/ignored;
- prove upstream ticket project mismatch blocks mutation even for an allowlisted-looking ID;
- preserve existing read-broker, browser pairing, and admin tests.

Run focused tests plus full repository suite, build, browser E2E if available, secret scan, diff/status. Commit the exact candidate on a new branch and return SHA/tree, changed files, commands/results, rollback (revert/deploy predecessor), and any audit-attribution debt.

## Deployment boundary
Do not deploy production from the implementation phase. Prepare reviewed commit/PR-ready candidate only. Eva owns review, merge, targeted deploy, public smoke, and real paired-browser acceptance.
