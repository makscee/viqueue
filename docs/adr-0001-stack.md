# ADR 0001: phase-0 stack

Status: accepted for phase 0

Use Node.js 22 built-ins only: `node:http`, filesystem durability, `fetch`, and `node:test`.

The inspected host already provides Node 22, npm, curl, and jq; it does not provide Go, Rust, or the sqlite3 CLI. A dependency-free ESM server and CLI therefore give the smallest coherent, locally distributable stack without an install or native compilation step. The durable store is a single JSON snapshot replaced atomically after each serialized mutation. This is intentionally phase-0 scale, but exercises real disk and HTTP rather than mocks.

Consequences: one server process owns one store; no multi-process writers, database indexing, migration framework, or crash recovery beyond atomic rename and fsync. Those are explicit gaps, not hidden abstractions.
