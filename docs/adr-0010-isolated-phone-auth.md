# ADR-0010: profile-bound WebCrypto proof gateway

Status: accepted for isolated staging; no ingress activation.

Use a separate dependency-free Node 22 HTTPS loopback gateway and STRICT SQLite auth database. Keep the existing server, port 7373, tailnet access, CLI, and MCP unchanged. A same-origin bootstrap stores a non-extractable ECDSA P-256 private key in IndexedDB and signs every API request challenge.

## Alternatives

* **WebCrypto ECDSA (chosen):** broadly available through the [Web Crypto API](https://www.w3.org/TR/WebCryptoAPI/) and supports a non-extractable profile-resident key without installing device credentials. It does not prove hardware or user presence.
* **Mutual TLS:** [TLS client certificate authentication](https://www.rfc-editor.org/rfc/rfc8446#section-4.4.2) has strong transport binding but requires certificate enrollment, secure key distribution, renewal, and proxy support; it is excessive for one-tap isolated staging.
* **Passkey/WebAuthn:** [WebAuthn](https://www.w3.org/TR/webauthn-3/) can provide authenticator properties and user verification, but adds ceremonies and user-presence prompts contrary to the single-tap product requirement.

Separate storage and process boundaries make rollback removal-only and prevent changes to direct/tailnet application behavior.
