# viqueue

viqueue is a minimalist, customizable central ticket dispatcher for agents and humans. The CLI command is `viq`. Tickets use human-readable IDs such as `ABC-123`.

Naming has been selected, but trademark clearance is **not complete**. A license choice is **pending**; no open-source license grant is made by this phase-0 repository.

## Phase-0 contract

Workers pull and explicitly claim tickets. viqueue never launches, supervises, or polls workers. Expiry is not proof of worker death: an expired claim becomes `stale` and remains unavailable. An authorized explicit takeover increments the monotonically increasing claim generation. Every mutation must present the current actor, opaque claim token, and generation; otherwise the API returns stable conflict code `stale_claim`.

Only the tracer states `ready`, `claimed`, `stale`, and `submitted` exist. The HTTP JSON API is the domain transport; `viq` is its reference client.

## Run

Requires Node.js 22+; there are no third-party runtime or development dependencies.

```sh
npm test
npm run build
VIQ_TAKEOVER_TOKEN=local-secret node dist/src/server.js --storage=./data/viqueue.json
node dist/bin/viq.js --server http://127.0.0.1:7373 --json project create ABC
```

CLI JSON mode emits one JSON document to stdout on success and to stderr on failure. Exit codes: `0` success, `2` usage, `3` conflict, `4` not found, `5` other HTTP error, `6` transport/client error.

Commands:

```text
viq [--server URL] [--json] project create KEY
viq [--server URL] [--json] ticket create PROJECT TITLE
viq [--server URL] [--json] ticket next --actor ACTOR
viq [--server URL] [--json] ticket show ID
viq [--server URL] [--json] ticket claim ID --actor ACTOR --ttl-ms MS
viq [--server URL] [--json] ticket takeover ID --actor ACTOR --ttl-ms MS --auth TOKEN
viq [--server URL] [--json] ticket submit ID --actor ACTOR --claim-token TOKEN --generation N --evidence TEXT_OR_JSON
```

Run `npm run e2e` to build, start the actual server, drive the actual built CLI, and overwrite `evidence/e2e-output.txt` with exact output. See [the stack ADR](docs/adr-0001-stack.md).
