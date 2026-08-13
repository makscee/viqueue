# ADR 0002: phase-1 application contract and MCP adapter

Status: accepted for phase 1

## Phase-0 review

The HTTP contract is the single application boundary and both `viq` and MCP are clients. Claim tokens are returned only when a claim is created or renewed and never embedded in public tickets. Stable domain errors have `{code,message}` and HTTP status. Empty `GET /v1/tickets/next` remains HTTP 204; clients normalize it to `{ticket:null}`.

One necessary compatible addition was identified: agents need to extend active work without takeover. `POST /v1/tickets/{id}/renew` accepts `actor`, `claim_token`, `generation`, and `ttl_ms`. It succeeds only for the current unexpired claim, retains the generation and token, and sets expiry to now plus the requested TTL. Wrong credentials return `stale_claim`; expiry returns `claim_expired` and cannot revive the claim. This is also exposed by `viq ticket renew`.

Takeover authorization remains server configuration, not a tool argument. The MCP process receives `VIQ_TAKEOVER_TOKEN` and sends it only to the HTTP takeover endpoint. This avoids publishing authorization secrets in tool calls or model context. This is a local phase-1 gate, not production authentication.

## MCP decision

Use MCP revision `2025-06-18` over newline-delimited JSON-RPC 2.0 stdio, with initialization, ping, `tools/list`, and `tools/call`. Tools return both text content and structured content. Domain/application failures are successful JSON-RPC responses with `isError:true` and stable structured `{error:{code,message,http_status}}`; protocol errors use JSON-RPC errors.

The adapter validates its published closed JSON Schemas, then maps each call to the existing HTTP JSON API using `src/http-client.js`. It contains no ticket state transitions. There is no worker-launch tool.

See the MCP lifecycle and tools specifications: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle and https://modelcontextprotocol.io/specification/2025-06-18/server/tools.
