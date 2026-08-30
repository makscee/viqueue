# Browser pairing expiry normalization repair

Base: `109d5cc834afb358b1cf7a59af8c536ed19acbca`

## Contract and acceptance trace

- A1 — Normalize the API expiry value once to epoch milliseconds. `web/app.js` accepts numeric timestamps and non-empty date strings, rejects other/invalid values, and uses the normalized `expiresAt` for display and timer arithmetic.
- A2 — Fail visibly for invalid expiry. `web/app.js` throws `Pairing code response contained an invalid expiry` inside the existing `safely` wrapper, which reports the failure in the board status live region rather than rendering a broken handoff.
- A3 — Keep production-shaped string expiry handoff visible beyond initial rendering. `test/browser-pairing-e2e.js` rewrites the real local issuance response expiry to an ISO string, waits through a zero-delay event-loop turn, then reads the rendered code, Device ID, Device name, expiry, and three copy controls from the visible handoff group.
- A4 — Preserve pairing boundaries. No server, store, worker, route, auth, schema, TTL, single-use, retired-phone, or port code changed. Existing browser E2E still redeems once, rejects replay, exercises worker pairing, and asserts no `/__phone` request.

## Changed paths

- `web/app.js`
- `test/browser-pairing-e2e.js`
- `workshop/artifacts/browser-pairing-expiry-repair.md`

## TDD evidence

Regression-only RED on the requested base after dependencies were installed:

```text
$ npm run e2e:browser-pairing
locator.waitFor: Timeout 30000ms exceeded.
- waiting for getByRole('group', { name: 'Browser pairing details' }) to be visible
EXIT_STATUS=1
```

Implementation GREEN:

```text
$ npm run e2e:browser-pairing
BROWSER_PAIRING_E2E_OK evidence=/tmp/viq12-browser-evidence-crF02Y
```

## Checks

```text
$ node --test test/*pairing*.test.js test/exact-device-repair.test.js test/viq16-machines.test.js test/board-http.test.js
# tests 21
# pass 21
# fail 0
```

```text
$ VIQ_EVIDENCE_DIR=/tmp/viq-browser-expiry-full-e2e npm run e2e
E2E_FAILURE_DIAGNOSTICS_OK
E2E_OK
HUMAN_JOURNEY_E2E_OK
BROWSER_PAIRING_E2E_OK
COORDINATOR_WORKER_BROWSER_E2E_OK
EXIT_STATUS=0
```

```text
$ npm run build
built dist/
$ npm run scan:secrets
secret scan passed ... 0 high-confidence matches
$ git diff --check
(exit 0)
```

The first pre-commit `npm test` run passed 218 tests and failed only the two local-bundle tests because their intentional clean-tree guard rejects any uncommitted source patch. The required clean-tree run then passed:

```text
$ npm test
# tests 226
# pass 220
# fail 0
# skipped 6
EXIT_STATUS=0
```

## Blockers and proposals

None. No deployment, live mutation, or non-test pairing-code issuance was performed.
