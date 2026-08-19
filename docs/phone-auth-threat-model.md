# Isolated phone gateway threat model

This gateway binds paired browser profiles to staging API access. It is **not** hardware attestation, user presence, a person identity, or authorization derived from the selected workflow actor. The IndexedDB private `CryptoKey` is non-extractable, but browser compromise can still use it.

## Browser and request boundary

The normal flow creates a six-digit, ten-minute, one-use code and stores only its domain-separated SHA-256 hash; redemption attempts have a small source-local rate limit. Each browser generates its own non-extractable key. Multiple devices remain active and can be revoked individually. For compatibility, the older five-minute fragment intent still stores only a domain-separated verifier, erases its fragment before another request, and binds pairing to the configured HTTPS phone origin, intent, device, and public coordinates.

Every `/v1/*` call and paired device-management call obtains a 32-byte, 30-second, one-use challenge bound to active device epoch, method, exact raw request-target, and hash of the exact (at most 1 MiB) body. Absolute-form, network-path, backslash/control, encoded traversal, and ambiguous targets are rejected before routing. Auth JSON is limited to 8 KiB. ECDSA P-256 signs a length-prefixed record that also binds origin/audience. Authorization and challenge consumption run under `BEGIN IMMEDIATE`; revocation changes the active epoch boundary before future authorization can commit. Cookies confer no identity.

The gateway strips credentials, cookies, client `Host`, forwarding, hop-by-hop, and proof headers. It preserves only the exact accepted origin, method, raw path/query, and bounded body. Redirect responses are returned without being followed; they cannot select another upstream connection.

## Upstream address boundary

The backward-compatible default is one fixed root-form loopback HTTP origin (`127.0.0.1`, `localhost`, or `::1`). Remote HTTP is always rejected.

Remote HTTPS is opt-in only with `--upstream-address-policy=tailscale` and one configured root origin. The origin must use `https`, a DNS hostname rather than an IP literal, default port 443, and no userinfo, path other than `/`, query, or fragment. This is not a per-request URL forwarder.

Before each remote request, a fresh OS lookup must return a nonempty, type-consistent set containing only Tailscale IPv4 `100.64.0.0/10` or IPv6 `fd7a:115c:a1e0::/48` addresses. Empty, oversized, mixed-policy, malformed, timed-out, and failed lookups fail closed. A new non-pooling HTTPS agent connects the TLS socket directly to an immutable address copied from that validated result, while retaining the configured DNS hostname as HTTP authority, SNI, and certificate-verification name. There is no validation/connection second lookup.

Node's standard trust store and hostname verification remain enabled (`rejectUnauthorized: true`); there is no CLI custom-CA option, proxy-environment use, redirect following, or header-selected authority. DNS, TLS connect, and whole-request deadlines are bounded. Test-only dependency hooks require the non-CLI `testMode` flag and cannot be enabled by gateway command-line options.

Remaining threats: malware or XSS can invoke a resident key; a stolen unlocked profile can sign; traffic analysis and DNS denial of service remain possible. The OS resolver is trusted for names, but every returned address is independently constrained to tailnet ranges; this is address-policy enforcement, not DNSSEC. TLS termination, the gateway host, tailnet routing/ACLs, and the configured upstream remain trusted. Operator-token routes behind the upstream are intentionally unusable through this gateway because Authorization is stripped.
