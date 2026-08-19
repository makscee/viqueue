# Isolated staging phone access

## Operator flow

1. Build and run the existing application on loopback 7373 as today.
2. Choose a separate durable auth directory (new directories are created 0700; an existing parent is never chmodded), database (0600), and canonical approved HTTPS phone origin.
3. Select exactly one upstream mode:
   - Default/local: `--upstream=http://127.0.0.1:7373`. Loopback HTTP is the only mode when no address policy is supplied.
   - Exact tailnet HTTPS: `--upstream=https://cc-worker.twin-pogona.ts.net --upstream-address-policy=tailscale`. Remote HTTP, IP literals, nondefault ports, credentials, paths, queries, fragments, and every policy name other than `tailscale` are rejected.
4. Either run gateway-managed inbound TLS with both `--cert` and `--key`, or use an already approved TLS ingress and explicitly pass `--tls-terminated=true`. The latter is safe only while the gateway remains bound to loopback and that approved ingress is the sole caller. A partial keypair is rejected.
5. Mint one ten-minute, one-use code with `viq-phone-auth pair-code --db=… --origin=https://… [--label=…]`. Do not paste its code into logs or tickets. The older `pair-create` fragment command remains available for compatibility.
6. On the new device, enter the six-digit code and optional label. Once paired, **Add device** can mint subsequent codes without disabling current devices.
7. Inspect `viq-phone-auth status --db=… --origin=https://…` (`--json` is available). Use the paired device list to revoke one device; the CLI `revoke` command remains a bounded emergency revoke-all operation.

Example inert command for the approved mcow topology (paths and phone origin remain cutover inputs):

```sh
viqueue-phone-gateway \
  --auth-db=/APPROVED/PATH/phone-auth.sqlite \
  --origin=https://APPROVED-PHONE-ORIGIN \
  --upstream=https://cc-worker.twin-pogona.ts.net \
  --upstream-address-policy=tailscale \
  --tls-terminated=true \
  --port=7443
```

`HTTP_PROXY`, `HTTPS_PROXY`, and lowercase variants are intentionally ignored. Standard Node CA and hostname verification must succeed. Each new connection re-resolves the exact hostname, rejects the whole answer set if any address is outside Tailscale IPv4 `100.64.0.0/10` or IPv6 `fd7a:115c:a1e0::/48`, and binds the socket to the validated result. Redirects are returned but never followed by the gateway.

## Read-only upstream tracer

From the gateway host and without proxy variables, `viq-trace-tailscale-upstream` performs only `GET /health` and `GET /v1/projects` against the exact `cc-worker.twin-pogona.ts.net` origin. It uses the production trust store and hostname verification, validates actual tailnet DNS answers, pins those answers into the request lookup, caps response bytes, and does not follow redirects. It creates no pairing or application state.

## Cutover gate (Eva approval required)

Before activation, Eva must approve **the phone hostname and specific ingress**, production auth DB path/service wiring, and any required policy exception or credential provisioning. Building, testing, tracing, and publishing v0.4.1 perform none of those actions. Tailscale Funnel remains forbidden/not authorized.

## Rollback

Stop/remove only the gateway ingress/process, revoke the active devices, and archive or delete the separate auth DB according to policy. Do not alter the existing server, tailnet route, DNS, firewall, or application DB. Direct loopback/tailnet behavior remains available and unchanged.

Never package or track auth databases, private keys, certificates, or pairing URLs.
