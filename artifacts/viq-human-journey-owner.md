# Viq human-first product closure — owner evidence

## Candidate lineage

- Branch: `work/viq-human-journey`
- Base: `origin/main` at `2ca2a60bb5c1907167a8262d2be186867b96fdac`
- Tested source HEAD: `68ecdbcee6ccf77e103dc7c6e5955f6ef4eda59c`
- Tested source tree: `03d31be9d45b360cbdbc2b16a853c2d7e710a1a8`
- The original closure source commit is followed by bounded responsive repair source HEAD `14689bb2a1b7265b4ef79333249d774fc909beb8` (tree `fcffa30f9fd7b543a6121372bc597736be7d9ad8`).
- The final evidence commit is an evidence-only child of the tested repair source commit; no product source changed after the final full test/build/E2E run.
- Worktree: `/root/work/viqueue-viq-human-journey` (isolated; canonical checkout untouched)
- Runtime model verified from active Pi footer/model metadata: `void-codex/gpt-5.6-sol` (`PI_*` environment did not expose a model variable).

## RED → GREEN

The test `test/browser-human-journey-e2e.js` starts with a new SQLite database containing only the bootstrap coordinator. It does not create or seed a project through Store or HTTP.

- RED against an archive of exact base `origin/main`: `VIQ_EVIDENCE_DIR=/tmp/viq-human-red-evidence node test/browser-human-journey-e2e.js`
  - Exit `1`
  - `AssertionError [ERR_ASSERTION]: blank Board must expose a prominent project creation CTA`
- GREEN on candidate: same test with `VIQ_EVIDENCE_DIR=/tmp/viq-human-final-evidence`
  - Exit `0`
  - `HUMAN_JOURNEY_E2E_OK`

## Surface / operation matrix

| Surface | Authored source | Acceptance |
|---|---|---|
| Blank first use | `web/app.js`, `web/index.html`, `web/app.css` | Blank DB browser RED→GREEN; prominent “Create your first project”; Ticket disabled with explanation |
| Project create/select | `POST /v1/projects`; `openProjectCreate` | UI validation/normalization, persistent header action, newly created project selected, ticket composer opens immediately |
| Ticket create | `openTicketCreate`; `POST /v1/tickets` | First and disposable tickets created through UI |
| Filters | project and Human/Agent chips | Human filter exercised; legacy paired browser filter suite passed |
| Movement/reorder | drag and keyboard movement; board-position API | UI drag movement exercised; legacy keyboard reorder/cancel and drag suite passed |
| Detail/history | ticket modal and paginated history | Created/state history inspected in browser |
| Factual event | detail event composer | Added through UI and observed in complete history |
| Deletion | VIQ-15 non-restorable confirmation | Warning inspected; cancel then checkbox/confirm on disposable ticket |
| Machines | Machines modal | Pairing code generated through UI, disposable identity paired, revoke warning/confirm through UI, credential rejected afterward |
| Pi `/viq` | `extensions/viq-worker/index.ts`, `command.mjs` | Install/discovery plus focused parse/help/status/error tests; canonical pair/status/poll/stop examples; unknown, transport, invalid-used-code, already-paired wording |
| Worker pair/status/poll/stop | worker runtime + command | Runtime pairing/session tests and complete coordinator-worker E2E passed |
| Questions/approval | Activity/detail question cards + worker lifecycle | Complete coordinator-worker browser E2E passed (question and approval contracts) |
| Empty/error/loading | first-project onboarding, filter empty, request/pairing status | Blank onboarding and existing pairing/error tests passed; unreachable target message names target and `VIQ_URL` |
| Desktop/mobile/narrow | responsive board/dialog/Machines | 1280×900, 390×844, 320×800; no horizontal overflow; console errors 0; page errors 0 |

## Bounded responsive repair

Independent review found the 320/390 masthead overloaded, state tabs too dense, and no photographed blank first-use state. The bounded repair:

- places mobile branding and canonical actions on deliberate rows;
- uses the concise visible label “Disconnect” while preserving the accessible name “Disconnect this device”;
- prevents masthead labels from wrapping;
- raises mobile masthead actions and state tabs to a deterministic minimum 44px height;
- captures the actual blank CTA before project creation at every required viewport.

Focused RED on exact pre-repair candidate `a07b3a2`: `AssertionError: 390 masthead title wraps` (the first deterministic unmet responsive assertion). Focused GREEN on repair source: `HUMAN_JOURNEY_E2E_OK`.

## Final regression commands

Executed on committed responsive repair source HEAD `14689bb2a1b7265b4ef79333249d774fc909beb8`:

- `npm test` — PASS: 155 tests, 149 passed, 0 failed, 6 skipped.
- `npm run build` — PASS: `built dist/`.
- `VIQ_EVIDENCE_DIR=/tmp/viq-human-full-evidence npm run e2e` — PASS:
  - `E2E_OK`
  - `HUMAN_JOURNEY_E2E_OK`
  - `BROWSER_PAIRING_E2E_OK`
  - `COORDINATOR_WORKER_BROWSER_E2E_OK`
- Focused: `node --test test/viq-command-v3.test.js` — PASS: 11 tests, 10 passed, 1 intentionally skipped, 0 failed.
- `git diff --check` — PASS.

Normal E2E used temporary databases/directories and left no source-tree residue.

## Screenshots and dimensions

Before action (blank database, visible first-project CTA):

- `artifacts/viq-human-journey/blank-first-use-1280x900.png` — 1280×900
- `artifacts/viq-human-journey/blank-first-use-390x844.png` — 390×844
- `artifacts/viq-human-journey/blank-first-use-320x800.png` — 320×800

After action:

- `artifacts/viq-human-journey/human-journey-1280x900.png` — 1280×900
- `artifacts/viq-human-journey/human-journey-390x844.png` — 390×844
- `artifacts/viq-human-journey/human-journey-320x800.png` — 320×800
- `artifacts/viq-human-journey/machines-desktop-1280x900.png` — 1280×900
- `artifacts/viq-human-journey/machines-phone-390x844.png` — 390×844
- `artifacts/viq-human-journey/machines-phone-320x800.png` — 320×800
- Machine-readable results: `human-journey-status.json`, `browser-status.json` in the same directory.

No pairing code, credential, authorization header, or secret is present in committed screenshots/evidence.

## Issues found and fixed

1. Blank Board had no route to create a project: added obvious first-run CTA and persistent `+ Project` action.
2. Ticket creation was a dead end without projects: disabled it until usable and immediately opens it after project creation.
3. New projects were not selected: candidate selects the created project and moves the human to the next action.
4. `/viq` no arguments showed raw status rather than help: now lists canonical commands and concise examples with state-aware next step.
5. Unknown commands/options and transport errors lacked recovery guidance: now point to `/viq`, target/`VIQ_URL`, or Machines as appropriate.
6. Re-pairing an already-paired Pi could become a confusing route/domain failure: now returns a clear already-paired response.
7. Credential persistence failure could leave unintended in-memory pairing: candidate restores the prior credential state.

## Explicitly unproven / remaining risks

- No deployment, live database mutation, DNS, ingress, mcow, auth-policy, credential, or phone-auth change was performed.
- Actual installed-runtime pairing on Mac and Tower is **not proven** here and must be performed only in the separate post-review/deploy acceptance phase.
- Operational `VIQ_URL` repair on Mac/Tower is not part of this candidate. Source now makes unreachable/mistargeted configuration understandable, but it does not configure those machines.
- This evidence proves local/staged source behavior only; it does not claim live UI, Tailnet, or installed runtime acceptance.
- VIQ-13 server-issued session authority and VIQ-15 non-restorable deletion boundaries remain intact and their full regression tests passed.
