# Browser pairing human-handoff repair evidence

## Contract

- A1 — Machines → Browser → Create code renders the one-time code, exact Device ID, and exact Device name as visible, accessible values.
- A2 — Each browser handoff value has a working copy affordance; a fresh browser can pair using only values read from rendered UI.
- A3 — Browser issuance response JSON is used by E2E only to assert rendered UI/server equality.
- A4 — Worker pairing UX, expiry clearing, and pairing single-use behavior remain intact.
- A5 — Canonical routing remains intact; this repair adds no `/__phone` route or port changes.

Base: `main` at `eb1d07c9678829143ddf62988ead110185525d2c`
Branch: `fix/browser-pairing-human-handoff`

## Changed paths

- `web/app.js` — browser-only accessible handoff group, exact values, copy actions, and exact-entry instruction; worker remains code-only.
- `web/app.css` — compact responsive handoff value/copy layout.
- `test/browser-pairing-e2e.js` — regression reads all fresh-browser values from UI, asserts response/UI equality, and exercises each copy action.

## TDD evidence

After adding the regression and before implementation:

```text
$ npm run e2e:browser-pairing
locator.waitFor: Timeout 30000ms exceeded.
- waiting for getByRole('group', { name: 'Browser pairing details' }) to be visible
exit 1
```

After implementation:

```text
$ npm run e2e:browser-pairing
BROWSER_PAIRING_E2E_OK evidence=/tmp/viq12-browser-evidence-YweClq
exit 0
```

## Checks

```text
$ node --test test/*pairing*.test.js test/exact-device-repair.test.js test/viq16-machines.test.js test/board-http.test.js
# tests 21
# pass 21
# fail 0
```

```text
$ VIQ_EVIDENCE_DIR=/tmp/viq-browser-handoff-full-e2e npm run e2e
E2E_FAILURE_DIAGNOSTICS_OK
E2E_OK
HUMAN_JOURNEY_E2E_OK
BROWSER_PAIRING_E2E_OK
COORDINATOR_WORKER_BROWSER_E2E_OK
exit 0
```

```text
$ npm test
# tests 226
# pass 220
# fail 0
# skipped 6
exit 0
```

`git diff --check` passed. Fresh-context adversarial review returned **PASS WITH NON-BLOCKERS**; its only residual note was the existing browser Clipboard API availability requirement.

## Acceptance trace

- A1: `web/app.js` browser handoff group and labelled outputs; proved by `getByRole('group', { name: 'Browser pairing details' })` plus labelled UI reads in browser E2E.
- A2: per-value copy buttons in `web/app.js`; browser E2E grants clipboard permissions, clicks all three, and compares clipboard text before pairing a fresh context from UI-derived values.
- A3: `issuedBrowser` fields occur only in the single `assert.deepEqual` UI/server comparison in `test/browser-pairing-e2e.js`.
- A4: worker branch remains code-only with `Copy code`, expiry timer and one-use checks; focused pairing tests and full E2E pass.
- A5: no server/route files changed; browser E2E still asserts no request path starts with `/__phone`; full E2E passes.

## Blockers and proposals

- Delivery blocker: GitHub authentication is unavailable (`gh auth status` reports no login; `git push -u origin fix/browser-pairing-human-handoff` failed with `could not read Username`). The branch is committed locally but could not be pushed, so no PR was opened.
- Product/test blockers: none.
- Proposals: none; scope intentionally remains limited to the browser handoff UI and its regression.
