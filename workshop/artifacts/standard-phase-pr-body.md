# PR title

STANDARD: human review bundles and fresh-session persistent `/viq` lane

# PR body

## What

- Persist and safely render structured Review Bundles before Human Accept.
- Require explicit acknowledgement when required visual proof is absent.
- Separate Human Accept, release recording, and production verification.
- Add `/viq once`, `/viq unpair`, persistent idle backoff, richer status/recovery, and fresh-session rotation after terminal boundaries.
- Keep Viq artifact-neutral and execution-neutral.

## Architecture

ADR 0014 compares same-context loops, a fresh-session extension controller, an external daemon, and subagent pools. It chooses the Pi 0.83 `newSession` controller because it preserves the visible Pi lane and prior JSONL while avoiding core/runtime coupling. See `docs/adr-0014-standard-review-and-persistent-lane.md` for state machine, migration, rollback, and threat boundary.

## Production boundary

This repository has deterministic local bundle/install/rollback machinery only. CI does not deploy and no source-controlled mechanism authorizes or deploys `viq.makscee.ru`. This change records external release and production-verification references; it does not push, merge, publish, release, deploy, or probe production.

## Review

Run `npm test`, `npm run build`, and `npm run scan:secrets`. Inspect Review Bundle rendering and the proof-absence checkbox in an approval card. Exercise `/viq status`, `/viq once`, `/viq poll`, pause/resume/stop, and a two-ticket submit rotation in a disposable Pi profile. Confirm the credential canary appears only in Authorization headers, never events/prompts/status/session files.

## Risk

The schema adds compatible policy/deployment facts. Older binaries require snapshot-paired rollback. Browser thumbnails depend on externally supplied safe HTTP(S) references; Viq does not fetch or render artifacts server-side. Production release remains an explicit external authority gap.
