# ADR 0012: minimal pairing authorization for private PoC

Status: accepted for private PoC

## Decision

Viq uses one-time device pairing, a fixed `coordinator` or `worker` device kind, and flat assignment roles. Roles grant no API permissions. Coordinator and worker permissions are hard-coded at HTTP ingress.

A persisted coordinator assignment is launch authorization. Every claim ingress uses the same predicate: active paired worker, open ticket, matching device or role assignment, no unresolved blocker, and no current claim. Unassigned work is not claimable. Takeover and the active execution-authority mechanism are removed.

The first coordinator is bootstrapped locally. Paired credentials are returned once, hashed at rest, and revoked at device granularity. The Pi worker stores its credential in an owner-only file outside its workspace and excludes it from model context.

## Non-goals

No generic IAM graph, scopes, policy language, role hierarchy, OAuth/SSO, delegated grants, multi-tenancy, public-internet promise, scheduler, or worker supervisor is introduced.

## Compatibility

The legacy `execution_authorities` table remains migration-only so the database can be rolled back with its matching prior binary. Candidate runtime code does not read, write, expose, or consume it.
