# ADR 0012: minimal pairing authorization for private PoC

Status: accepted for private PoC; subordinate to [ADR 0013](adr-0013-product-charter.md) for product and runtime responsibility boundaries

## Decision

Viq uses one-time device pairing, a fixed `coordinator` or `worker` device kind, and flat assignment roles. Roles grant no API permissions. Coordinator and worker permissions are hard-coded at HTTP ingress.

The original decision was: “A persisted coordinator assignment is launch authorization. Every claim ingress uses the same predicate: active paired worker, open ticket, matching device or role assignment, no unresolved blocker, and no current claim. Unassigned work is not claimable. Takeover and the active execution-authority mechanism are removed.”

Two later refinements govern how that history is read. First, “launch authorization” means claim eligibility for an independently running worker; it does not authorize or cause Viq to launch a process. Second, the original unassigned-work prohibition was superseded by the accepted free-pool refinement recorded in the public repository at commit [`5a68920`](https://github.com/makscee/viqueue/commit/5a68920), whose `README.md` states that exact device/role assignments are preferred and that eligible unassigned free-pool tickets may be claimed atomically within project, role, and membership boundaries. That is the current claim rule; the rest of the original decision remains in force.

The first coordinator is bootstrapped locally. Paired credentials are returned once, hashed at rest, and revoked at device granularity. The Pi worker stores its credential in an owner-only file outside its workspace and excludes it from model context.

## Non-goals

No generic IAM graph, scopes, policy language, role hierarchy, OAuth/SSO, delegated grants, multi-tenancy, public-internet promise, scheduler, or worker supervisor is introduced.

## Compatibility

The legacy `execution_authorities` table remains migration-only so the database can be rolled back with its matching prior binary. Candidate runtime code does not read, write, expose, or consume it.
