# Exact-device re-pair repair

Date: 2026-08-26. Risk: Elevated only for pairing/device credential rotation. Fresh visible Pi owner on Tower. Base exact merged production/source head `6b941cb815087018edc20acdf5e6df21aaa05def`.

Problem: live exact device `artems-macbook-pro` exists active from an ambiguous prior redemption, but the human reports the browser did not retain/use the credential. There are zero fresh intents. Supported `device revoke` only marks the row revoked; current `pairDevice` always INSERTs and therefore a new code bound to the same exact ID will fail `409 device_exists`. User explicitly requires the same device ID/name and a 15-minute code. No direct SQL deletion or alternate ID.

Goal: add a supported secure re-pair contract for an existing revoked device with exact same ID.

Requirements:
1. TDD strict RED on base. Pairing an existing active device remains `409 device_exists` (no takeover). Pairing a revoked device is allowed only when the pairing intent is explicitly bound to that exact ID/name, exact actor_id and intended kind matching the revoked row. Legacy/unbound codes must not reactivate. Any actor/kind/name mismatch fails closed.
2. On successful exact re-pair, transactionally replace token_hash, name, status=active, created_at/current activation timestamp per established semantics, revoked_at=NULL, actor_id exact. Old credential remains unusable. Invalidate/revoke any old worker sessions and remove device-scoped roles/capabilities so authority cannot silently carry over. Do not broaden actor admin/roles or mutate tickets/projects.
3. Pairing code remains single-use and is marked used only in the same successful transaction. Replay fails. Failed mismatch leaves revoked device and code state unchanged.
4. Add API/store and phone/browser E2E coverage for revoke -> exact bound re-pair -> old credential denied -> new credential accepted; active duplicate, unbound, mismatch and replay negatives.
5. Focused tests, full npm test, build, secret scan. No secrets/codes in evidence.
6. Commit one bounded repair and write `REPAIR-RESULT.md` with SHA/tree/tests/threat invariants. No push/PR/deploy/live mutation. End `REPAIR_READY_FOR_REVIEW` or exact blocker.
