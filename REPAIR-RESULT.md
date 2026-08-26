# Security repair result

Base: `d3e7a8cc7f894ad130cc0dd3ec79cc99704cb5ae` (`origin/main`)
Review marker addressed: `REVIEW_BLOCKER_PUBLIC_EDGE_ADMIN_AUTHORITY_LEAK`

## Result

The phone gateway now returns local paired identity for non-admin coordinators, permits only an explicit browser read-route allowlist, and rejects all other routes before upstream. Local pairing metadata carries actor name/kind/activity and admin capability. Existing local admin proxy behavior is retained. The browser hides mutation/admin controls and gives truthful read-only status copy.

Changed paths:
- `src/phone-auth-store.js`
- `src/phone-gateway.js`
- `src/server.js`
- `web/app.js`
- `test/coordinator-board-read.test.js`
- `test/phone-gateway-read-broker.test.js`
- `REPAIR-RESULT.md`

## Evidence

- Focused gateway/auth/UI tests: 25/25 passed after dependency install.
- `npm test`: 205 tests; 193 passed, 0 failed, 12 platform/contract skips.
- `npm run build`: passed.
- `npm run scan:secrets`: passed, 0 high-confidence matches.
- Package-install discovery test, repaired candidate: passed.
- Same package-install discovery test at parent/base from a clean archive with the identical dependency tree: passed.
- `test/worker-install.test.js`: harness-classified skip on both candidate conditions because macOS lacks GNU `readlink -m`; no product failure.

No deployment, production database/service/network mutation, push, PR, merge, role grant, actor-admin change, or pairing-state change was performed. Residual risk: the gateway still necessarily uses its confidential credential for allowlisted upstream reads; route additions require explicit allowlist review. Final commit and tree IDs are reported from Git after this self-containing result is committed.

REPAIR_READY_FOR_REREVIEW
