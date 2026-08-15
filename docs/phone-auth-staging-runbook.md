# Isolated staging phone access

## Operator flow

1. Build and run the existing application on loopback 7373 as today.
2. Choose a separate durable auth directory (new directories are created 0700; an existing parent is never chmodded), database (0600), canonical approved HTTPS origin, and fixed loopback upstream. Either run gateway-managed TLS with both files, `viqueue-phone-gateway --auth-db=… --origin=https://phone.example --upstream=http://127.0.0.1:7373 --cert=… --key=…`, or use the existing approved proxy/tunnel for TLS and explicitly run loopback HTTP with `--tls-terminated=true`. The latter mode is safe only when the gateway remains bound to loopback and the approved ingress forwards to it. A partial certificate/key pair is rejected.
3. Run `viq-phone-auth pair-create --db=… --origin=https://…`. Do not paste the URL into logs or tickets.
4. On the phone, open the fragment URL and tap **Pair this phone**. That is the single minimal phone action after the cutover gate.
5. Inspect `viq-phone-auth status --db=… --origin=https://…` (`--json` is available). If a key/profile is lost or access must end, run `revoke`; create a new pair only afterward.

The actor picker remains workflow context, not authentication.

## Cutover gate (Eva approval required)

Before any activation, Eva must approve **the hostname and specific ingress**, the required policy exception, credential provisioning (if any), and the production auth DB location/service wiring. This change performs none of those actions.

Candidate inert options: prefer the existing managed reverse proxy to the separate loopback gateway; an outbound Cloudflare Tunnel would require a newly approved credential; Tailscale Funnel is forbidden/not authorized. Examples are planning inputs, not active configuration.

## Rollback

Stop/remove only the gateway ingress/process, revoke the active device, and archive or delete the separate auth DB according to policy. Do not alter the existing server, tailnet route, DNS, firewall, or application DB. Direct loopback/tailnet behavior remains available and unchanged.

The external origin is always canonical HTTPS. Gateway-managed TLS or explicit external TLS termination is mandatory outside automated `testMode`; `testMode` is not a CLI production option. Never package or track auth databases, private keys, certificates, or pairing URLs.
