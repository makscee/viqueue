# Security policy

## Supported version

viqueue is pre-1.0 prerelease software. Security fixes are currently made on the latest `main`; there is no supported release branch, response-time guarantee, or production-security claim.

## Reporting a vulnerability

Use GitHub **private vulnerability reporting** for `makscee/viqueue`:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Submit affected version/commit, impact, reproduction conditions, and suggested mitigation when safe.

Do not disclose suspected vulnerabilities, exploit details, or secrets in public issues or discussions. If the GitHub private reporting control is unavailable, retain the details privately until the repository owner enables it; do not fall back to public disclosure. No separate security email address is claimed.

## Local security boundaries

- The takeover bearer token is a local gate, not production authentication.
- The HTTP server defaults to loopback and should not be exposed to untrusted networks.
- Claim tokens and storage files are sensitive local data.
- MCP hosts execute the configured stdio command with the user's permissions; install only trusted source/bundles.
