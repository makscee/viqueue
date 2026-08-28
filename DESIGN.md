# VIQ-S1 interface design contract

Status: accepted interface contract; subordinate to [ADR 0013](docs/adr-0013-product-charter.md) for product responsibilities, runtime ownership, and artifact ownership.

## Authority and selection

This is the project-local interface contract for VIQ-S1. Maks selected **Direction B — Decision desk + work rail** on **2026-08-22** and supplied no additional rationale.

Direction B's thesis is: **A wider Activity desk anchors decisions; four compact work lanes remain co-visible to its right.** Questions and provenance lead without hiding board consequence. Its known structural tradeoff is that ticket titles wrap sooner in the narrower work rail.

The prototype is comparison evidence, not production implementation. Product behavior remains governed by `CONTEXT.md` and the VIQ-S1 specification.

## Acceptance evidence

Use these durable, project-relative artifacts as the accepted composition reference:

- Self-contained selected prototype: [`docs/design/viq-s1/direction-b-selected.html`](docs/design/viq-s1/direction-b-selected.html)
- Desktop, 1280×900: [`docs/design/viq-s1/direction-b-acceptance-desktop-1280x900.png`](docs/design/viq-s1/direction-b-acceptance-desktop-1280x900.png)
- Phone, 390×844: [`docs/design/viq-s1/direction-b-acceptance-phone-390x844.png`](docs/design/viq-s1/direction-b-acceptance-phone-390x844.png)
- Narrow reflow, 320×800: [`docs/design/viq-s1/direction-b-acceptance-phone-320x800.png`](docs/design/viq-s1/direction-b-acceptance-phone-320x800.png)

The captures fix hierarchy, density, composition, and responsive transformation. They do not imply that static prototype behavior is complete production behavior.

## Hierarchy and primary action

1. Activity is first: every unresolved question precedes the complete newest-first factual event feed.
2. Open, Working, Waiting, and Done are second: compact ordered cards make the consequences of decisions co-visible.
3. Project/assignment scope, Machines, and provenance are supporting controls.

There is exactly one primary action: **`+ Ticket`**. Machines, filters, tabs, question responses, popup actions, and retry are contextual or secondary actions and must not compete visually with quick capture.

On desktop, Activity and all four state lanes remain together in one viewport and scroll independently. Activity is part of the global board, not a dashboard or navigation destination. On phone, the same five surfaces become tabs and Activity is initially selected.

## Low-fidelity visual tokens

The selected low-fi artifact establishes these exact tokens. Production may organize them as variables, but must retain the accepted relationships and accessible contrast.

### Color

- Page: `#eef1f3`
- Primary ink: `#17212b`
- Paper/card/feed: `#ffffff`
- Lane surface: `#f7f8f9`
- Soft fact surface: `#f2f5f6`
- General soft surface: `#f5f7f8`
- Main boundary: `#cbd2d8`
- Card boundary: `#d5dbe0`
- Internal divider: `#dfe4e7` / `#e0e4e7`
- Control boundary: `#aeb8c0`
- Accent/primary action: `#244d66` with white text
- Muted text: `#65717b` (closely related fixture values `#65727c`, `#64717a`, `#66717a` are allowed only in the roles shown by the accepted artifact)
- Selected filter: background `#dbe6ec`, boundary `#8197a5`
- Question: background `#fff8e9`, boundary `#d9c18b`; question badge `#f2e6c9` with `#694b0c`
- Machine provenance: `#315f79`
- Error text: `#7a2626`
- Dialog backdrop: `#18232d` at 40% alpha

### Type scale

- Stack: `Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`
- Root/body: `14px`
- Brand: `18px`, weight `750`, letter spacing `-0.02em` (`16px` at ≤340px)
- Dialog title: `17px` (`15px` at ≤340px)
- Activity heading in Direction B: `16px`
- Lane and section headings: `13px`
- Card title: `12px`, weight `650`, line-height `1.3` (`13px` on phone)
- Supporting/form text: `12px`
- Question label/title: `11px`; question body `12px` in Direction B
- Card ID/meta/feed annotation: `10px`; card ID letter spacing `0.04em`
- Filter labels: `11px`, uppercase, letter spacing `0.08em`

Do not introduce a larger display scale or decorative typography; compact operational reading is part of the accepted hierarchy.

### Grid, spacing, and measure

- Desktop shell: viewport height; rows `auto auto minmax(0, 1fr)`; `12px` padding and `10px` row gap.
- Direction B canvas: `minmax(300px, 1.55fr) repeat(4, minmax(0, 1fr))` with `8px` gaps. Activity occupies column 1; four lanes follow to the right.
- Lane/card stack: `7px` padding and `6px` gaps. Cards use `8px` padding. Direction B questions use `11px` padding.
- Masthead gap: `16px`; action gap: `7px`; filter gap: `8px`; chip gap: `5px` with wrapping.
- Lane and Activity radius: `8px`; card/question/control radius: `6px`; dialog radius: `9px`.
- Desktop dialog measure: width `100%`, maximum `min(620px, calc(100vw - 24px))`; padding `16px`.
- Ticket facts: three equal columns with `7px` gaps.
- No fixed text truncation: long titles wrap using `overflow-wrap:anywhere`; no horizontal page overflow is allowed.

At ≤600px the shell uses `10px` padding and `8px` gaps; at ≤340px it uses `8px` padding. These values, not a new density system, define the accepted low-fi rhythm.

## Component contracts

### Masthead and scope

- Anatomy: `viqueue` brand, short descriptor on desktop, secondary **Machines** action, primary **+ Ticket** action; below it, Project and Assignment filter groups.
- Project variants: selected/unselected chips for real projects; multiple selections combine with OR semantics.
- Assignment variants: Human and Agent only. Unassigned and machines are never filters.
- The same scope applies to all five columns and reveals a subsequence of global ordering.

### Compact ticket card

- Anatomy: immutable ID, full wrapping title, assignment (`Unassigned`, `Human`, or `Agent`), optional open-question indicator, optional active-machine provenance.
- Allowed variants: standard; one or more open questions indicated compactly; active Agent machine; long-title wrapping.
- Machine remains secondary provenance and never replaces Agent assignment.
- Disallowed: project chip, state control, description preview, timestamp, toolbar, action buttons, machine assignment, and truncation that hides stress content.

### Activity

- Anatomy: heading/count; unresolved question blocks; then factual event feed.
- Question variants: text answer; blocking text; blocking approval with **Accept** / **Request changes**. Each shows ticket ID, full title, meaning, prompt, and inline response controls.
- Feed events are ordinary, factual, complete, newest first, and show role/machine provenance without urgency or attention scoring.
- Open questions may not be buried by newer events.

### Board lane

- Exactly Open, Working, Waiting, and Done; heading/count, then one globally ordered card stack.
- All ticket lanes support the same manual reorder interaction. Updates move a ticket to the top. Only Open order changes Agent claim priority.
- Done remains visibly available with progressive loading; no Archive or Restore variant exists.

### Ticket creation popup

- One compact dialog opened by **+ Ticket**.
- Project and title are required; description and assignment are optional; Unassigned is the default.
- Create is unavailable until native required fields are valid.
- No state field. Project becomes immutable after creation.

### Ticket popup

- One non-nesting dialog containing immutable identity/project/state, description, assignment, questions with inline answers, chronological history, inline edit mode, and an always-visible factual-event composer.
- Allowed display/edit variants occur in place. No ticket page, drawer, answer modal, or nested popup.

### Machine popup

- Secondary, non-nesting dialog: active machines with role/name and revoke; pairing form with role, name, and code.
- No actor manager, role editor, memberships, assignment controls, queues, or machine filters.

## Declared states

The deterministic state contract is:

- **Normal:** seeded VIQ/OPS board and Activity fixture.
- **Loading:** one calm, announced board-level loading region; no fake empty lanes.
- **Empty:** capture-oriented empty result with **+ Ticket**; no dashboard/project-page action.
- **Error:** factual board-level error and Retry while scope/capture hierarchy remains stable.
- **Filtered:** VIQ-only tickets and matching Activity subsequence; global ordering is not rewritten.
- **Card:** standard, open-question, active-machine, and long-title variants.
- **Activity:** simultaneous unresolved questions followed by factual feed.
- **Popups:** create initial/validation, ticket normal/question/edit, and machine normal/pairing.

## Responsive transformations

### Desktop (acceptance: 1280×900)

Activity is the wider left decision desk. Open, Working, Waiting, and Done form the narrower work rail to its right. All five are side-by-side, independently scrollable, and co-visible; the page does not split Activity into another route.

### Phone (acceptance: 390×844)

At ≤600px:

- The five surfaces become one-column tabs in Open, Working, Waiting, Done, Activity order.
- Activity is selected by default.
- Scope and quick capture remain above the tabs.
- Only the active surface is displayed; horizontal mini-columns are prohibited.
- The descriptor is hidden, filter groups become labeled wrapped rows, ticket titles wrap, and dialogs become full-screen.
- Ticket facts use two columns where they fit.

### Narrow phone (acceptance: 320×800)

At ≤340px:

- Shell padding reduces to `8px`; brand/action/chip/tab type and padding follow the accepted artifact.
- All five tabs remain within the viewport.
- Filters wrap, long titles wrap, dialog facts stack to one column, and full-screen dialogs retain their actions.
- No horizontal overflow or two-dimensional-layout exception is allowed.

## Interaction, focus, reorder, and motion

- Cards open the one ticket popup. **+ Ticket** and **Machines** open their respective dialogs. No interaction opens a nested dialog.
- Project and assignment filters update all five surfaces without route motion and preserve the global-order subsequence.
- Activity answers resolve inline and update the affected question/card state without navigation.
- Tabs expose exactly one phone surface and maintain selected-tab semantics; Activity is initially selected.
- Human tickets move between board states by drag. Agent lifecycle, not board drag, owns Agent state transitions. Tickets in every ticket lane can be manually reordered; Open reorder changes Agent claim priority.
- Drag feedback may use a brief transform/position transition and must expose the intended drop lane and position. Cancel restores the prior order. Keyboard interaction must reach cards and provide equivalent move/reorder operation with announced lane/position changes; drag cannot be the sole means.
- Use semantic buttons, tabs, forms, and dialogs. All card and inline question actions are keyboard reachable. Focus is visibly indicated, enters an opened dialog, remains contained while it is modal, and returns to the invoking control/card when closed. Escape closes where the native dialog convention allows it.
- No motion is required to understand state. Opening, closing, filtering, answering, and reordering remain legible with animation disabled. `prefers-reduced-motion: reduce` removes nonessential transitions and smooth scrolling.

## Accessibility constraints

- Text and meaningful component boundaries must meet WCAG AA contrast: 4.5:1 for normal text, 3:1 for large text and non-text UI boundaries/focus indicators. Do not rely on color alone for state, questions, assignment, selection, or provenance.
- Pre-selection evidence uses controls at least `24px` high (`32px` for general buttons/selects and `28px` for inline question controls). Production should prefer `44×44px` targets where the compact composition permits and must provide at least `24×24px` CSS-pixel targets or sufficient target spacing.
- Focus indicators must remain visible against page, card, question, and dialog surfaces.
- Loading and errors are announced; tabs expose selected state; dialogs have names; form labels and required state are programmatic.
- At 390 and 320 CSS pixels, content reflows without horizontal scrolling and at 200% zoom remains operable without loss of content or function.

## Accepted and rejected structural examples

- **Accepted — Direction B:** the wider Activity desk leads on the left while four compact state lanes remain co-visible to its right. This makes unresolved decisions first without removing their board consequences.
- **Rejected — Direction A:** five equal parallel lanes make Activity too narrow for the required decision content.
- **Rejected — Direction C:** the left-to-right work sequence makes decisions terminal rather than leading.

These are structural tradeoffs only; the selection records no additional taste, palette, or stylistic rationale.
