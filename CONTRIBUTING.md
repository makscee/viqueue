# Contributing to viqueue

Thank you for helping improve viqueue.

## Before changing code

- Keep the pull model and fencing semantics intact: claims persist without liveness inference, unassigned work is not claimable, and there is no takeover path.
- Keep HTTP as the application contract. `viq`, MCP, and the board must not implement separate state machines.
- Keep scope small and avoid worker launching, production auth claims, or unrelated frameworks.
- For a larger change, describe the problem, compatible contract impact, and validation approach before implementation.

## Development

Requires Node.js 22+ and npm.

```sh
npm install
npx playwright install chromium
npm test
npm run build
npm run e2e
```

Use strict RED → observed failure → GREEN for behavior changes. Tests should exercise real storage and transports where practical. Keep lowercase `viqueue`, command `viq`, and uppercase ticket IDs such as `ABC-123`.

## Submitting changes

Keep commits focused. Include:

- behavior and motivation;
- tests and exact commands run;
- compatibility or security implications;
- screenshots for visible UI changes.

By intentionally submitting a contribution for inclusion, you agree it is provided under the repository's Apache License 2.0 terms as described in section 5 of the license.
