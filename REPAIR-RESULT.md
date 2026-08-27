# Exact-device re-pair repair result

Base: `6b941cb815087018edc20acdf5e6df21aaa05def`
Date: 2026-08-26
Scope: pairing/device credential rotation only.

## Result

A revoked device can be reactivated only by a fresh, unconsumed, unexpired pairing code explicitly bound to the existing device's exact normalized ID, exact name, actor ID, and intended kind. Active IDs remain non-replaceable. Exact re-pair rotates the credential and activation timestamp in the pairing transaction, clears revocation, revokes old worker sessions, and removes device-scoped roles. Actor authority and workflow data are not changed.

Changed paths:
- `src/store.js`
- `test/exact-device-repair.test.js`
- `test/browser-pairing-e2e.js`
- `BRIEF.md`
- `REPAIR-RESULT.md`

## Threat invariants

- Active duplicate: `409 device_exists`; no credential takeover.
- Revoked reactivation requires non-null exact server bindings for ID, name, actor, and kind.
- Legacy/unbound and any mismatched code fail before device/code mutation.
- Code consumption and credential rotation share one `BEGIN IMMEDIATE` transaction; replay fails.
- Old token hash is replaced; old credentials fail authentication.
- Existing worker session capabilities are revoked and device-role rows deleted on repair.
- Actor admin/role state, tickets, projects, claims, and events history are not broadened or rewritten.
- Pairing TTL remains bounded by the existing API; coverage issues the requested `900000ms` (15-minute) code.

## Evidence

- Strict RED on base behavior: focused repair test failed on revoked-row uniqueness (`UNIQUE constraint failed: devices.id` / HTTP 500) before implementation.
- Focused repair tests: 2/2 passed; combined pairing/session regression coverage passed apart from one pre-install package-discovery environment failure.
- Responsive browser E2E: passed, `BROWSER_PAIRING_E2E_OK`; covers revoke, exact same-ID/name re-pair, old credential 401, new credential 200, replay 409.
- Full `npm test`: 207 tests; 201 passed, 0 failed, 6 skipped on the clean candidate.
- `npm run build`: passed.
- `npm run scan:secrets`: passed; 0 high-confidence matches.
- Commit: the single commit containing this file; canonical SHA is `git rev-parse HEAD`.
- Tree: canonical tree is `git rev-parse HEAD^{tree}`.

No push, PR, deployment, live mutation, direct SQL repair, alternate device ID, or secret/code recording was performed.

REPAIR_READY_FOR_REVIEW
