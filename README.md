# viqueue

viqueue is a minimalist pull-based ticket dispatcher for agents and humans. The CLI is `viq`; ticket IDs look like `ABC-123`. v0.3.0 is an unpublished prerelease for local evaluation.

## Daily Alpha contract

The HTTP JSON core is the only state machine. `viq`, MCP stdio, and the browser are thin HTTP clients. Runtime data lives in one SQLite file using Node 22's built-in `node:sqlite` and four domain tables: projects, tickets, claims, and events.

Tickets have only `open`, `review`, and `done` states. The board projects them as Ready (open without a claim), Working (open with a claim), Review, and Done.

**A claim persists until an explicit release, submission, or takeover. Silence changes nothing.** Claims are authority locks, not liveness. Claim identity contains an opaque `claim_id`, actor, generation, and an unguessable token whose hash—not plaintext—is stored. Executor mutations require all current credentials. Explicit local-operator takeover increments generation and fences every older owner.

**Progress events are observations, not proof of liveness.** Events form append-only per-ticket and global streams with a monotonic cursor. Agents pull work; viqueue never starts workers.

## Run

Requires Node.js 22. Runtime has no third-party dependencies; Playwright is development-only.

```sh
npm test
npm run build
VIQ_OPERATOR_TOKEN=local-secret node dist/src/server.js --storage=./data/viqueue.sqlite
```

Open `http://127.0.0.1:7373` for the responsive four-column board.

Representative CLI operations:

```text
viq project create ABC                 viq project list
viq ticket create ABC "Fix parser" --body "..." --assigned-to eva
viq ticket list ABC                    viq ticket show ABC-1
viq ticket edit ABC-1 --title "..." --body "..." --assigned-to maks
viq ticket next --project ABC          viq ticket claim ABC-1 --actor eva
viq ticket verify|release|submit ABC-1 --claim-id ID --actor eva --claim-token TOKEN --generation N
viq ticket takeover ABC-1 --actor maks --auth LOCAL_TOKEN
viq ticket accept|reopen ABC-1 --actor maks --auth LOCAL_TOKEN
viq event post ABC-1 <claim credentials> --message "tests green"
viq event list --project ABC --after CURSOR
```

CLI JSON mode writes one JSON document. Exit codes are 0 success, 2 usage, 3 conflict, 4 not found, 5 other HTTP error, and 6 client/transport error. MCP exposes coherent equivalents through `tools/list`; configure `VIQ_SERVER` and `VIQ_OPERATOR_TOKEN`.

## Import v0.2 JSON safely

The server never silently interprets or discards an old JSON file. Create a new SQLite file explicitly:

```sh
viq-import --from ./data/viqueue.json --to ./data/viqueue.sqlite
```

The one-shot importer preserves project keys, next numbers, ticket IDs/titles, submitted review state, evidence as an import event, and legacy claim fencing credentials. A legacy current claim is imported as a durable current claim with the same actor, generation, and token authority. Submitted tickets release their old claim. If any claim lacks actor, generation, or token, import fails closed and removes the incomplete target. Existing targets are never overwritten. Keep the old JSON backup until validation is complete.

## Local bundle and evidence

`npm run bundle` creates deterministic `release/viqueue-v0.3.0-rc.tar.gz` plus SHA-256. Its reversible installer adds `viq`, `viq-import`, `viqueue-server`, and `viqueue-mcp` under `${VIQ_PREFIX:-~/.local}`; uninstall preserves separately located ticket data. Nothing here publishes, pushes, tags, deploys, or launches workers.

`npm run e2e` exercises CLI, MCP, and Chromium and writes evidence/screenshots when `VIQ_EVIDENCE_DIR` is set. See [ADR 0008](docs/adr-0008-v03-daily-alpha-core.md), [CHANGELOG.md](CHANGELOG.md), and [release notes](release-notes/v0.3.0.md).

viqueue is licensed under the [Apache License 2.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
