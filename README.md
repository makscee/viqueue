# viqueue

viqueue is a minimalist, customizable central ticket dispatcher for agents and humans. The CLI command is `viq`. Tickets use human-readable IDs such as `ABC-123`.

Naming has been selected, but trademark clearance is **not complete**. A license choice is **pending**; no open-source license grant is made by this repository.

## Application contract

Workers pull and explicitly claim tickets. viqueue never launches, supervises, or polls workers. Expiry is not proof of worker death: an expired claim becomes `stale` and remains unavailable. An authorized explicit takeover increments the monotonically increasing claim generation. Every mutation must present the current actor, opaque claim token, and generation; otherwise the API returns stable conflict code `stale_claim`.

Only the tracer states `ready`, `claimed`, `stale`, and `submitted` exist. The HTTP JSON API is the application transport; `viq` and the MCP stdio server are equivalent clients. Claim renewal preserves the token and fencing generation and cannot revive an expired claim.

## Run

Requires Node.js 22+; there are no third-party runtime or development dependencies.

```sh
npm test
npm run build
VIQ_TAKEOVER_TOKEN=local-secret node dist/src/server.js --storage=./data/viqueue.json
# Open http://127.0.0.1:7373 for the local Kanban board.
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
viq [--server URL] [--json] ticket renew ID --actor ACTOR --claim-token TOKEN --generation N --ttl-ms MS
viq [--server URL] [--json] ticket takeover ID --actor ACTOR --ttl-ms MS --auth TOKEN
viq [--server URL] [--json] ticket submit ID --actor ACTOR --claim-token TOKEN --generation N --evidence TEXT_OR_JSON
```

## Attach an MCP host

Start the HTTP server first. Configure an MCP host to launch the stdio adapter with environment variables rather than changing any live host now:

```json
{
  "mcpServers": {
    "viqueue": {
      "command": "node",
      "args": ["/absolute/path/to/viqueue/dist/src/mcp-server.js"],
      "env": {
        "VIQ_SERVER": "http://127.0.0.1:7373",
        "VIQ_TAKEOVER_TOKEN": "local-secret"
      }
    }
  }
}
```

The adapter writes protocol messages only to stdout. Do not put the takeover token in prompts or tool arguments. Host-specific attachment examples (do not run them against a live host during setup):

- **Claude Code:** `claude mcp add --transport stdio --env VIQ_SERVER=http://127.0.0.1:7373 --env VIQ_TAKEOVER_TOKEN=local-secret viqueue -- node /absolute/path/to/viqueue/dist/src/mcp-server.js`
- **Hermes:** add an `mcp_servers.viqueue` entry in `~/.hermes/config.yaml` with `command: node`, `args: [/absolute/path/to/viqueue/dist/src/mcp-server.js]`, and the two environment values.
- **Pi:** core Pi has no built-in MCP client. Install a trusted MCP client extension such as `pi-mcp-adapter`, then use that extension's command/args/env configuration; alternatively write a small Pi extension that calls the same HTTP API.

References: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), and [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

MCP tools: `project_create`, `ticket_create`, `ticket_get`, `ticket_next`, `ticket_claim`, `claim_renew`, `ticket_takeover`, and `ticket_submit`. Their closed schemas are discoverable through `tools/list` and documented in [ADR 0002](docs/adr-0002-phase1-contract-and-mcp.md).

## Local board

The same server exposes a minimal responsive board at `http://127.0.0.1:7373`. It discovers projects and lists tickets only through the HTTP application contract. It shows ready, claimed, stale/uncertain, and submitted projections; stale cards are unavailable and can move only through an explicitly confirmed takeover with the configured local token. On narrow screens, explicit state tabs with counts show one full-width column and support touch plus Left/Right/Home/End keyboard navigation.

The board refreshes its read-only projection every five seconds while visible. Polling pauses while a form control or dialog is active, so it does not replace typed input or steal focus. The last-refresh time is visible and manual Refresh remains available. The browser does not launch workers or read storage.

Run `npm run e2e` to exercise the CLI, MCP, and real Chromium board tracer bullets. Exact raw outputs are written under `evidence/`; desktop/mobile acceptance screenshots are under `evidence/screenshots/`. Browser installation for a new development machine is `npx playwright install chromium`.

See [the stack ADR](docs/adr-0001-stack.md), [MCP contract ADR](docs/adr-0002-phase1-contract-and-mcp.md), [board projection ADR](docs/adr-0003-phase2-board-projection.md), and [responsive navigation ADR](docs/adr-0004-phase21-responsive-navigation.md).
