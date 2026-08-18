# Security policy

## Supported version

viqueue is pre-1.0 prerelease software. Security fixes are currently made on the latest `main`; there is no supported release branch, response-time guarantee, or production-security claim.

## Reporting a vulnerability

Use GitHub **private vulnerability reporting** for `makscee/viqueue`:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Submit affected version/commit, impact, reproduction conditions, and suggested mitigation when safe.

Do not disclose suspected vulnerabilities, exploit details, or secrets in public issues or discussions. If the GitHub private reporting control is unavailable, retain the details privately until the repository owner enables it; do not fall back to public disclosure. No separate security email address is claimed.

## Private-alpha trust boundaries

- The phone gateway's single active paired browser device is its access boundary; it identifies a browser profile, not a person or selected actor.
- The board actor selector is workflow identity for attribution and inbox routing, not authentication or access control.
- The core and phone-gateway listeners default/remain on loopback; keep any separately approved tailnet ingress private. Never use Funnel or public ingress.
- Agent mutations require the current claim's complete claim ID, actor, generation, and token. Assignment and actor selection grant no agent authority.
- The takeover bearer token is a local gate, not production authentication. Claim tokens and storage files are sensitive local data.
- MCP hosts execute the configured stdio command with the user's permissions; install only trusted source/bundles.

These are accepted private-alpha boundaries, not IAM or a production-security claim. See [ADR 0011](docs/adr-0011-private-alpha-trust-boundaries.md).
