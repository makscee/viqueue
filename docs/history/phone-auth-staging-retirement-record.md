# Retired historical record: isolated staging phone access

> **RETIRED — HISTORICAL EVIDENCE ONLY.** This is not an active runbook and must not be used to configure or restore current systems. The former commands and endpoints below are preserved exactly as historical evidence, not as guidance.

## Former operator flow

1. Build and run the existing application on loopback 7373 as today.
2. Choose a separate durable auth directory (new directories are created 0700; an existing parent is never chmodded), database (0600), and canonical approved HTTPS phone origin.
3. Select exactly one upstream mode:
   - Default/local: `--upstream=http://127.0.0.1:7373`. Loopback HTTP is the only mode when no address policy is supplied.
   - Exact tailnet HTTPS: `--upstream=https://cc-worker.twin-pogona.ts.net --upstream-address-policy=tailscale`. Remote HTTP, IP literals, nondefault ports, credentials, paths, queries, fragments, and every policy name other than `tailscale` are rejected.
4. Provision an operator-controlled file containing only the dedicated upstream coordinator credential and pass `--upstream-authorization-file=/APPROVED/PATH/upstream.credential`. The supported deployment contract is a service-UID-owned `0600` regular file with exactly one hard link, nonzero bounded content, and one printable Authorization value (an optional final LF is accepted; NUL, CR, embedded LF, whitespace, and multiple lines are rejected). The gateway opens it read-only with no symlink following and close-on-exec where available, validates owner/mode/type/link count/size with `fstat`, reads from that same descriptor, verifies it did not change, and always closes it. Missing paths, symlinks, directories, FIFOs, wrong owners, group/other permissions, malformed values, and races fail startup. Provision atomically under the effective gateway service UID; do not widen sandbox filesystem access or place the credential in argv, environment, logs, or artifacts. The gateway never accepts browser credentials as upstream authority and fails every `/v1/*` request before upstream if this option is absent.
5. Either run gateway-managed inbound TLS with both `--cert` and `--key`, or use an already approved TLS ingress and explicitly pass `--tls-terminated=true`. The latter is safe only while the gateway remains bound to loopback and that approved ingress is the sole caller. A partial keypair is rejected.
6. Run `viq-phone-auth pair-create --db=… --origin=https://…` using the trusted coordinator host. Optional operator-only `--device-id`, `--actor-id`, and `--label` values are bound into the intent; otherwise safe browser defaults are generated. The intent always binds admin scope server-side. Do not paste the returned code into logs or tickets.
7. Open the canonical browser UI, enter only the displayed **Pairing code**, and select **Pair browser**. Never put the code in a URL.
8. Inspect `viq-phone-auth status --db=… --origin=https://…` (`--json` is available). If a key/profile is lost or access must end, run `revoke`; create a new code only afterward.

Example inert command for the approved mcow topology (paths and phone origin remain cutover inputs):

```sh
viqueue-phone-gateway \
  --auth-db=/APPROVED/PATH/phone-auth.sqlite \
  --origin=https://APPROVED-PHONE-ORIGIN \
  --upstream=https://cc-worker.twin-pogona.ts.net \
  --upstream-address-policy=tailscale \
  --upstream-authorization-file=/APPROVED/PATH/upstream.credential \
  --tls-terminated=true \
  --port=7443
```

`HTTP_PROXY`, `HTTPS_PROXY`, and lowercase variants are intentionally ignored. Standard Node CA and hostname verification must succeed. Each new connection re-resolves the exact hostname, rejects the whole answer set if any address is outside Tailscale IPv4 `100.64.0.0/10` or IPv6 `fd7a:115c:a1e0::/48`, and binds the socket to the validated result. Redirects are returned but never followed by the gateway.

## Former read-only upstream tracer

From the gateway host and without proxy variables, `viq-trace-tailscale-upstream` performs only `GET /health` and `GET /v1/projects` against the exact `cc-worker.twin-pogona.ts.net` origin. It uses the production trust store and hostname verification, validates actual tailnet DNS answers, pins those answers into the request lookup, caps response bytes, and does not follow redirects. It creates no pairing or application state.

## Former cutover gate (Eva approval required)

Before activation, Eva must approve **the phone hostname and specific ingress**, production auth DB path/service wiring, and any required policy exception or credential provisioning. Building, testing, tracing, and publishing v0.4.1 perform none of those actions. Tailscale Funnel remains forbidden/not authorized.

## Former rollback

Stop/remove only the gateway ingress/process, revoke the active device, and archive or delete the separate auth DB according to policy. Do not alter the existing server, tailnet route, DNS, firewall, or application DB. Direct loopback/tailnet behavior remains available and unchanged.

Never package or track auth databases, private keys, certificates, or pairing URLs.
