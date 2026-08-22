# ADR 0008: v0.3 Daily Alpha core

Status: superseded historical ADR; ADR 0012 removes takeover and replaces actor authority with paired devices.

v0.3 replaces the JSON tracer with one SQLite database and four durable domain tables: projects, tickets, claims, and events. Node 22's built-in `node:sqlite` is used despite its runtime experimental warning because the supported Node 22.22 test/runtime provides the required stable synchronous API and this avoids a production dependency.

HTTP remains the sole application boundary. CLI, MCP stdio, and browser code contain no second state machine. Tickets use canonical `open`, `review`, and `done`; the board projection is Ready, Working, Review, Done.

A claim persists until an explicit release, submission, or takeover. Silence changes nothing. Claims have no duration, heartbeat, renewal, scheduler, or inferred status. Tokens are random and persisted only as SHA-256 hashes. Current claim ID, actor, generation, and token are all checked for executor mutations. Takeover is an explicit local-operator action and increments generation.

Progress events are observations, not proof of liveness. Events are append-only and use SQLite's monotonic integer primary key as the global cursor. Canonical mutations are events too.

A one-shot `viq-import` command is the only v0.2 migration path. It never overwrites a target. It preserves identifiers, numbering, submitted review state, evidence, and complete legacy claim authority; incomplete claims fail closed.

The browser is deliberately one responsive page with project/ticket forms, four columns, detail editing, event history, progress posting, and explicit lifecycle actions. No worker launcher, users/auth platform, notifications, realtime transport, drag/drop, scheduling, deadlines, priorities, or custom workflow is added.
