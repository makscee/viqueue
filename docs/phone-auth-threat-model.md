# Isolated phone gateway threat model

This gateway binds one browser profile to staging API access. It is **not** hardware attestation, user presence, a person identity, or authorization derived from the selected workflow actor. The IndexedDB private `CryptoKey` is non-extractable, but browser compromise can still use it.

## Boundaries and guarantees

The operator creates a five-minute intent locally. Only a domain-separated SHA-256 verifier is stored; the fragment secret is erased from visible history before another browser request and is never sent over HTTP. A domain-separated HMAC binds pairing to the configured HTTPS origin, intent, device, and public coordinates. Exactly one active device is enforced until local revocation.

Every `/v1/*` call obtains a 32-byte, 30-second, one-use challenge bound to active device epoch, method, exact raw request-target, and hash of the exact (at most 1 MiB) body. Absolute-form, network-path, backslash/control, encoded traversal, and ambiguous targets are rejected before routing. Auth JSON is limited to 8 KiB. ECDSA P-256 signs a length-prefixed record that also binds origin/audience. Authorization and challenge consumption run under `BEGIN IMMEDIATE`; revocation changes the active epoch boundary before future authorization can commit. Cookies confer no identity. The gateway removes credentials, cookies, Host/forwarding, hop-by-hop, and proof headers before the fixed loopback upstream.

Remaining threats: malware or XSS can invoke a resident key; a stolen unlocked profile can sign; traffic analysis remains; denial of service is only bounded by expiring, size-capped local in-memory rates. TLS termination and the gateway host remain trusted. Operator-token routes behind the upstream are intentionally unusable through this gateway because Authorization is stripped.
