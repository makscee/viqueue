# viqueue human UX audit and repair

**Audit date:** 2026-08-14
**Product surface:** shipped web UI, desktop and 390 px mobile
**Human persona exercised:** Maks
**Environment:** disposable loopback server and fresh production-schema SQLite database
**Production:** not changed

## Executive verdict

**Implementation verdict: conditionally ready for Eva's browser acceptance; not deployed.** The repaired UI now opens on an all-project queue, makes identity and the human question inbox explicit, supports credential-free human answers and review decisions, and replaces agent protocol fields with readable ticket context. The seven required browser behaviors pass on Chromium at 1440×960 and 390×844. API/domain code and claim fencing were not changed.

This is implementation evidence, **not final user acceptance**. Eva's independent visual review found a duplicated assignment/worker fact and raw role-id presentation; the focused follow-up below repairs both. Eva has not yet accepted the follow-up or authorized deployment.

## Personas and jobs

| Persona | Primary job | UI treatment |
|---|---|---|
| Maks, human responder/reviewer | See what needs his answer; understand context; answer; accept or request changes | Primary web persona: remembered identity, prominent inbox, readable detail, inline actions |
| Eva, human acceptance owner | Inspect the repaired experience and decide whether deployment may proceed | Same human surface; deployment remains gated on explicit acceptance |
| Worker agent | Pull, claim, report progress, ask questions, submit for review | API/CLI/MCP; claim fencing remains intact and is not exposed in ordinary human UI |
| Operator | Manage actors/roles and exceptional takeover/reopen | Authorized API/CLI; operator credential is never rendered in the human UI |

## Jobs and action placement

| User intent | Primary placement | Secondary context | Why |
|---|---|---|---|
| Identify as Maks | Top of every page: **Your name** | Explanatory first-visit copy | Required before a personal inbox can be computed |
| Find work needing an answer | Prominent **Questions for you** inbox above board | Count and explicit empty state | Core human loop; no project hunting |
| Answer text question | Inline on question card | Ticket title and ID on card | No dialog or claim credential required |
| Approve work | Inline **Accept work** on review card | Optional note | Approval is modeled as a question |
| Request changes | Inline **Request changes** on review card | Optional note | Keeps review in the same loop |
| Browse everything | Default **All tickets** overview | Ready/Working/Review/Done projection | Prevents first-project truncation |
| Narrow to one project | **Project view** selector | Return option: All projects | Composable filter, not a new navigation hierarchy |
| Understand a ticket | Click ticket card → human detail dialog | Context, assignment, worker, state, latest progress, question history | Progressive disclosure for detail |
| Create project/ticket | Collapsed **Create something** disclosure | Project selection required for ticket | Retains minimal capability without competing with the human loop |
| Claim/ask/progress/submit/takeover/reopen as agent/operator | CLI/API/MCP | None in ordinary web UI | Technical authority belongs to agent/operator surfaces |

## Scenario evidence

| Scenario | Steps | Expected | Actual | Verdict |
|---|---|---|---|---|
| First visit, no actor | Open `/` with empty browser storage | Explain identity; show all four tickets across LIFE/WORK/VIQ | “Choose your name…” onboarding; LIFE-1, WORK-1, VIQ-1, VIQ-2 all present | PASS |
| Returning Maks | Select Maks, reload | Identity remembered; inbox immediately visible | Maks restored from local storage; three seeded questions shown | PASS |
| Text answer | Enter answer on Maks text question; send | No claim fields; answer leaves open inbox and remains in ticket history | “Answer sent”; inbox decremented; answered question remains in detail | PASS |
| Request changes | Add optional note to approval; choose request changes | Approval answered; ticket returns to open | Status feedback shown; API state checked as `open` | PASS |
| Accept revised work | Worker resubmits through fenced API; Maks accepts inline | Approval answered; ticket moves to done | “Work accepted”; API state checked as `done` | PASS |
| Multiple questions while working | Inspect VIQ-1 after worker asks two questions and posts later progress | Questions accumulate; claim remains; later worker progress visible | Two questions shown (one answered, one open); state Working; later progress shown | PASS |
| Browse project/all | Select VIQ, then All projects | 2 VIQ tickets, then all 4 | Counts and IDs asserted | PASS |
| Working ticket detail, same actor | Open VIQ-1 when assigned to and claimed by Worker agent | Human fields only; no duplicate person fact | Only **Worker — Worker agent** is visible; redundant assignment fact is hidden | PASS |
| Working ticket detail, role assignment | Reassign claimed VIQ-1 to workers role; open detail | Human role label and distinct active worker; no raw role id | **Eligible group — Workers** and **Worker — Worker agent** are both visible | PASS |
| Mobile | Open role-assigned VIQ-1 at 390×844 | Same distinction; no horizontal overflow; usable dialog | Humanized group and worker asserted; screenshot captured | PASS |
| Empty inbox | Answer final Maks question | Explain that nothing needs an answer | “All clear” and “Nothing needs your answer…” | PASS |
| Refresh | Use Refresh after data changes | Board/inbox update without losing identity | Revised approval appears; Maks remains selected | PASS |
| Browser errors | Capture console warning/error and pageerror during significant interactions | None | Empty captured problem list | PASS |
| Validation/errors | Try creating a ticket while All projects is selected, then Refresh | Understandable, no unhandled console exception, recovery succeeds | “Choose a project before creating a ticket” appears in live status; Refresh restores “4 tickets shown” | PASS |

## Information architecture

### Before

1. Technical masthead.
2. “Current actor (workflow identity, not authentication)” mixed with global badges.
3. Inbox dependency unexplained.
4. Project creation, project selection, and ticket creation permanently prominent.
5. Board silently scoped to the alphabetically first project.
6. Ticket dialog combined human content with claim ID/token/generation, raw actor/target routing, takeover/reopen authorization, and agent actions.

### After

1. Plain product purpose and Refresh.
2. **Your name** with short explanation and remembered choice.
3. **Questions for you** as the first task surface, including explanatory first-visit and empty states.
4. **All tickets** by default, with optional project filter.
5. Creation under progressive disclosure.
6. Four-state queue projection.
7. Human ticket detail only; agent/operator workflows remain on CLI/API/MCP.

## Visible-field classification

| Field/action | Before | Classification | After |
|---|---|---|---|
| Product name and purpose | Visible | Always visible | Kept, rewritten in plain language |
| Refresh | Visible | Always visible | Kept |
| Current actor technical label | Visible | Remove wording | Replaced by **Your name** |
| Human identity selector | Visible | Always visible | Kept; human actors only; remembered |
| Open-total / “for you” badges | Visible | Remove/reduce | Replaced by one meaningful inbox count |
| Questions for you | Conditional and unclear | Always visible | Prominent with onboarding/empty state |
| Project filter | Visible | Always visible | Kept, defaults to All projects |
| Project/ticket creation | Visible | Progressive disclosure | Collapsed under **Create something** |
| Ticket ID/title/state | Visible | Always visible | Kept |
| Assignment and worker | Raw IDs/routes | Conditional, humanized | Actor assignment uses **Assigned person**; role assignment uses **Eligible group**; active **Worker** is separate only when genuinely distinct; same actor is shown once |
| Ticket body/context | Edit form | Always visible in detail | Readable context |
| Latest meaningful progress | Buried in chronological technical history | Always visible in detail | Latest progress message promoted |
| Questions and answers | Raw target/status string | Always visible in detail | Prompt plus waiting/answered result |
| Inline answer | Inbox | Always visible when addressed to selected human | Kept and clarified |
| Accept/request changes | Inbox | Always visible for approval addressed to selected human | Kept and clarified |
| Full event chronology | Visible | Progressive/debug | Removed from ordinary detail; API remains |
| Assignment editing | Visible | Agent/operator surface | Removed from ordinary detail |
| Ask-question controls | Visible with credentials | Agent-only | Removed from web; API/CLI/MCP remain |
| Claim actor/ID/token/generation | Visible | Agent-only/debug | Removed from web |
| Raw actor/target routing | Visible | Agent-only/debug | Removed from web |
| Local operator token | Visible | Operator-only/secret | Removed from web |
| Claim/release/progress/submit/takeover/reopen | Visible | Agent/operator-only | Removed from web; protocol unchanged |

## Issue inventory

### Resolved

| Severity | Issue | Resolution |
|---|---|---|
| Critical product | Root showed only LIFE-1 because refresh selected first project | Root aggregates tickets from every project; project filter is optional |
| High | Maks could not discover why his questions were absent | Human identity is first, explained, and persisted; inbox always has a state |
| High | Ordinary detail exposed claim and operator protocol | Technical forms removed from human UI; API/domain untouched |
| High | Existing E2E normalized a worker/operator flow as human UX | Browser suite now starts as Maks and asserts the seven human behaviors |
| Medium | Multiple questions and continued work were hard to understand | Detail shows every question and explicit “Worker continues…” note plus latest later progress |
| Medium | Mobile evidence lacked console checks and broad realistic seed | Live-equivalent fixture, console/pageerror capture, overflow assertions, and fresh screenshots added |
| Medium | Same actor appeared twice as Assigned to and Worker; role assignment could show raw role ID | Same actor now produces one Worker fact; roles load from the API and render as **Eligible group — {role name}** while a distinct active worker remains visible |

### Remaining

| Severity | Limitation / follow-up | Priority |
|---|---|---|
| Medium | Browser automation currently covers Chromium only | Add WebKit/Firefox after acceptance if cross-engine support is required |
| Medium | All-project loading makes one request per project; large installations may need a server-side aggregate endpoint | Measure first; add endpoint only when scale justifies it |
| Low | Offline/500 transport failure injection is not automated; a deterministic validation failure and recovery are covered | Add transport-failure coverage only if console network noise can be classified separately |
| Low | Ticket creation requires choosing a project; the disclosure does not pre-explain this | Add helper copy only if manual acceptance finds it confusing |
| Low | Event chronology is absent from the ordinary view | Keep absent unless humans demonstrate a concrete need; then add a plain-language disclosure |

## Responsive, accessibility, and console findings

- Desktop: four equal state columns; question inbox leads the page; full-page screenshot at 1440×960.
- Mobile: sticky four-state tab strip; one state column visible at a time; project selector and forms stack; ticket facts stack; dialog fits viewport.
- Horizontal overflow: asserted false on board and open detail at 390 px.
- Semantic controls: real labels, buttons, forms, heading hierarchy, native dialog, live status, tab roles, selected-state attributes.
- Keyboard/basic browser validation: native controls and required fields are retained.
- Known accessibility follow-up: automated axe-style auditing and screen-reader traversal were not run; tab arrow-key behavior is not implemented.
- Console: warnings, errors, and uncaught page errors were collected across desktop/mobile significant interactions; none occurred.

## RED → GREEN evidence

- RED test was written first in `test/browser-e2e.js`.
- Expected RED: old UI did not contain an **All tickets** heading and loaded only the first project's tickets.
- Recorded RED: `red-browser-output.txt` exits 1 after waiting for the missing **All tickets** heading.
- GREEN: `browser-e2e-output.txt` contains eleven PASS statements and `BROWSER_E2E_OK`.
- Follow-up RED: `follow-up-red-output.txt` records the duplicate same-actor assertion failing (`2 !== 1`) before the presentation repair.
- Follow-up screenshots:
  - `screenshots/maks-ticket-detail-same-actor-desktop.png`
  - `screenshots/maks-ticket-detail-role-assigned-desktop.png`
  - `screenshots/maks-ticket-detail-role-assigned-mobile-390.png`
  - `screenshots/maks-all-tickets-desktop.png`
  - `screenshots/maks-working-mobile-390.png`
  - `screenshots/maks-empty-inbox-mobile-390.png`

## Test evidence

Final command outputs are stored beside this report. The final verification set includes unit/domain/HTTP tests, build, CLI E2E, MCP E2E, browser E2E, bundle determinism/checksum, and secret scanning. See `VERIFICATION.md` for exact commands and outcomes.

## Deployment gate and transactional plan

**Gate:** do not deploy until Eva explicitly accepts these artifacts and authorizes deployment.

After authorization only:

1. Reconfirm the accepted commit hash and a clean worktree.
2. Record current service status and resolved unit configuration without printing environment credentials.
3. Determine the configured SQLite path from protected systemd configuration without copying secrets into logs.
4. Stop `viqueue` briefly for a consistent backup.
5. Copy the SQLite database plus `-wal`/`-shm` companions if present to a timestamped, permission-restricted backup; verify backup readability and checksum.
6. Snapshot the currently installed application directory or package as the rollback artifact.
7. Install the accepted commit's built application atomically into a versioned directory; update the service path/symlink transactionally.
8. Start `viqueue`; require `active` status and `http://127.0.0.1:7373/health` success.
9. Confirm Tailscale Serve remains tailnet-only and mapped to loopback. **Never enable Funnel.**
10. Run the exact live browser checklist below. Do not mutate live tickets during read-only checks; use an explicitly approved disposable ticket only for mutation checks.
11. On any failure: stop service, restore prior application pointer and database backup if data was mutated, start service, verify health and ticket counts, and retain logs/artifacts.

### Exact live browser acceptance checklist

- Open `https://cc-worker.twin-pogona.ts.net/` from an authorized tailnet device.
- Confirm no public/Funnel exposure and no credential appears in page, URL, storage inspection, or console.
- Confirm default **All tickets** shows LIFE-1, WORK-1, VIQ-1, and VIQ-2.
- Confirm project filter LIFE/WORK/VIQ and return to All projects.
- On a fresh browser profile, confirm the identity explanation and unselected inbox state.
- Select Maks; reload; confirm Maks is remembered and his current inbox is obvious.
- Open one ready, working, review, and done ticket; confirm readable context/assignment/worker/state/progress/questions.
- Confirm no claim ID/token/generation, operator token, or raw routing is visible.
- At 390 px, switch each state tab, open/close detail, and confirm no horizontal scrolling.
- Confirm browser console has no error/warning.
- If Eva approves a disposable mutation: answer one text question, then test request changes and accept on separate approval cycles; verify state transitions and that the worker claim behavior remains domain-correct.

## Acceptance status

- Automated implementation verification: pending/finalized in `VERIFICATION.md`.
- Fresh verifier-subagent: pending/finalized in `VERIFICATION.md`.
- Eva visual review: defect reported and repaired; follow-up acceptance **not yet received**.
- Production deployment: **not performed**.
