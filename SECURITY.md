# Security policy

## Supported version and reporting

viqueue is pre-1.0 prerelease software with no production-security or response-time guarantee. Use GitHub **private vulnerability reporting** for `makscee/viqueue`; do not publish credentials or exploit details in issues.

## Pairing PoC boundary

This candidate is a private, single-operator PoC, not a generic IAM or public multi-tenant service.

- Every API request except health, static assets, and one-time pairing exchange requires a paired device bearer credential.
- Device kind is fixed at pairing: `coordinator` or `worker`.
- Coordinator and worker permissions are hard-coded at HTTP ingress; roles affect assignment eligibility only.
- Pairing codes are short-lived, one-time, hashed at rest, and issued only by an active paired coordinator.
- Device credentials are random, returned once, hashed at rest, and invalid after device revocation.
- Worker claims require the same active-device, assignment, state, blocker, and active-claim predicate through HTTP, CLI, and `/viq-worker`; MCP is read-only.
- Claim mutations additionally require the current claim ID, generation, and token and are intentionally absent from MCP.
- The Pi worker stores its device credential outside the ticket workspace in an owner-only regular file. It excludes device and claim credentials from prompts, status, and normal tool results, rejects workspace symlink escape, denies shell while active, and refuses root.
- Keep the core on loopback or an explicitly private network. Never use Funnel/public ingress for this PoC.

No second phone/browser authentication ledger or gateway is shipped by this candidate.
