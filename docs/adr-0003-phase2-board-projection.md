# ADR 0003: phase-2 board projection

Status: accepted for phase 2

## HTTP review

The existing application contract could mutate and retrieve individual resources, but a board could not discover projects or list a project's tickets without reading storage. Two read-only application queries are added:

- `GET /v1/projects` returns `{projects:[...]}` ordered by project key.
- `GET /v1/projects/{key}/tickets` returns `{tickets:[...]}` in ticket-number order and applies the same lazy claim-expiry transition used by `next` and `get`.

Public projections omit claim tokens. No state transition is implemented in the browser. Create and takeover controls call the existing HTTP mutations. Claim, renewal, submission, and fencing remain in the existing store/application logic and retain the Phase 0/1 contracts.

## UI arrangement

Serve three static assets (`/`, `/app.css`, `/app.js`) from the same dependency-free Node server. This is the smallest single-process local arrangement and avoids CORS, a second service, build-time frontend tooling, or a framework. The browser holds only a replaceable projection and refreshes from HTTP.

The four columns map exactly to `ready`, `claimed`, `stale` (labelled “Stale / uncertain”), and `submitted`. Stale uses a distinct amber striped treatment and explicit “Unavailable — explicit takeover only” language. Takeover is available only from stale detail, uses a modal confirmation, and requires the locally configured takeover token. The token is sent as the existing bearer authorization and is not retained.

The responsive board uses four columns on desktop, two at intermediate widths, and a horizontally scrollable snap board at narrow widths to preserve readable cards. Native forms, buttons, selects, and dialogs provide keyboard semantics; visible focus is explicit.
