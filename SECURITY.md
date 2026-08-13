# Security policy

## Supported version

viqueue is pre-1.0 local release-candidate software. Security fixes are currently made on the latest `main`; there is no supported release branch or response-time guarantee.

## Reporting a vulnerability

No private security-reporting address or hosted advisory channel has been established yet. Until a public repository and private reporting channel are explicitly configured, do **not** post a suspected vulnerability or secret in a public issue.

Use an existing private communication channel with the project maintainer if you have one. Otherwise, retain the report privately and request a secure reporting channel without including exploit details. This file will be updated with a concrete private process before public hosting.

Include affected version/commit, impact, reproduction conditions, and suggested mitigation when safe to do so.

## Local security boundaries

- The takeover bearer token is a local phase-0/1 gate, not production authentication.
- The HTTP server defaults to loopback and should not be exposed to untrusted networks.
- Claim tokens and storage files are sensitive local data.
- MCP hosts execute the configured stdio command with the user's permissions; install only trusted source/bundles.
