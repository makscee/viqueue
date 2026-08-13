# ADR 0004: phase-2.1 responsive navigation and freshness

Status: accepted for the local release candidate

## Mobile state navigation

The horizontally scrolling four-column board hid important states at narrow widths. Below 560px the board now becomes an explicit ARIA tab interface: Ready, Claimed, Stale, and Submitted always remain visible with truthful counts, and one full-width state panel is shown. Touch/click selects a tab. Left/Right/Home/End keys move selection and focus using roving `tabindex`; `aria-selected` exposes the current state. Stale is therefore discoverable from its count without blind swiping, while its card and takeover remain stale-only.

Desktop retains all four columns. Controls are denser, metadata contrast and size increase, and cards/detail evidence wrap or scroll within their containers. The striped stale treatment is unchanged.

## Freshness

The browser polls the existing project/ticket query endpoints every five seconds only while the document is visible and no input/select/textarea or dialog is active. This bounded projection refresh never submits or mutates state, never replaces form text while a person is editing, and does not move focus. A visible timestamp states the last refresh and interval; manual Refresh remains available. Mutations still require their explicit controls.

## Release evidence

The browser E2E uses deterministic content fixtures covering all four states, multiple ready cards, a long title, long actor identifier, and multiline structured evidence. It verifies desktop and 390px layouts, tabs by keyboard and touch, stale/action discovery, focus styling, polling deferral during editing, eventual external-state refresh, takeover fencing, and evidence containment.
