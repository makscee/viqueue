# Server-local operator CLI

`viq operator pairing create` is the narrow, browser-independent local control path for issuing Browser handoffs on the coordinator host. It uses `/run/viqueue-alpha/operator.sock`, a private Unix socket served by the coordinator process. It does not use, store, copy, or expose a reusable coordinator credential, and it adds no public HTTP route.

```sh
viq operator pairing create --kind browser --name 'Maks browser' \
  --output /root/work/viq-cli-first-operator/browser-handoff.json
```

The command accepts only Browser issuance. Worker handoffs remain `viq device pair-code`. Human Accept is not exposed. There is no production socket-path, URL, HTTP method, route, body, credential, proxy, or session-capability override. The local client uses Node's Unix-socket HTTP transport directly, does not follow redirects, and sends only a validated name. It writes the exact server response `{code,device_id,device_name,expires_at}` with `O_EXCL|O_NOFOLLOW`, mode `0600`, and fsync. Stdout contains only output path and expiry.

## Authority and lifecycle

Root and the dedicated `viqueue` service UID are trusted in this private-alpha boundary. The fixed socket is the deterministic server-local authority. Its parent is created by systemd as `/run/viqueue-alpha`, owned by `viqueue:viqueue`, mode `0700`; the socket is owned by the service UID and mode `0600`. Startup rejects a symlink or group/world-writable parent and rejects an existing non-socket or foreign-owned path. It removes only a stale socket owned by the service UID. Shutdown removes only that same safe socket type/owner.

The handler exposes exactly `POST /v1/operator/browser-pairings` on the Unix listener. It accepts exactly `{name}` and internally calls the same Store pairing primitive used by the authenticated coordinator API. It binds a generated Browser device ID, exact name, active Human admin actor, coordinator kind, and a fixed one-hour TTL chosen by the server-local operation. It returns no bearer credential. Browser consumption occurs through public `POST /v1/browsers/pair` with only the code; the route requires a server-bound coordinator-kind intent. Worker consumption remains on `POST /v1/devices/pair`, preserving Browser/Worker separation, binding, expiry, and single-use checks.

For mcow, update only `viqueue-alpha.service`:

```ini
[Service]
RuntimeDirectory=viqueue-alpha
RuntimeDirectoryMode=0700
ExecStart=
ExecStart=/usr/bin/node /opt/viqueue-alpha/releases/RELEASE/src/server.js --storage=/var/lib/viqueue-alpha/viqueue.sqlite --host=127.0.0.1 --port=17373 --operator-socket=/run/viqueue-alpha/operator.sock
```

The immutable release must include `src/operator-server.js` and `src/operator-cli.js`. This candidate additively migrates `worker_mutation_receipts` with nullable `session_id`, `claim_token_hash`, and `request_hash` columns while preserving existing rows. Preserve `/var/lib/viqueue-alpha/viqueue.sqlite`; a binary-only rollback leaves those additive columns and stored receipts in place, while restoring a pre-candidate database snapshot would also restore its earlier receipt state. Do not create `/run/viqueue-phone/gateway.sock` or listeners on 7373/7443. Rollback restores the prior unit and release `26c0eb184f32ff120501bb615ea8624cb5133b70`, runs `systemctl daemon-reload`, and restarts only `viqueue-alpha`; systemd removes the runtime directory.

## CLI-first gap map

Current `viq` commands cover project create/list; ticket create/list/show/edit with category assignment only; worker next/claim-next/claim/verify/release/progress/complete/submit; one-time Worker `device pair`; worker `session open`/`session close`; question list/ask and coordinator text answer; device me/list/pair-code/revoke; and role create/list/grant/revoke. Browser issuance remains server-local through the operator command. Worker pairing redemption needs no existing credential. Worker mutations use the server-issued `VIQ_SESSION_CAPABILITY` environment value plus the returned claim ID, claim token, and generation; session authority is not accepted in argv. A blocking question releases the claim to `Waiting`; a coordinator text answer reopens it, after which a fresh worker session must reclaim it. Direct completion additionally requires a unique request ID and outcome, accepts repeatable opaque evidence references, records completion atomically, and permits exact retry. Legacy submit/accept remains compatible but is not required for direct completion.

Ticket creation uses only categorical `Unassigned`, `Human`, or `Agent` assignment; exact actor/device assignment is not a supported creation contract. Ticket state/board position, notes/history, deletion, block resolution, and machine views have HTTP routes but lack first-class CLI commands. Archive/restore has Store support but no current HTTP/CLI surface. Viq records direct worker completion and provenance but does not certify correctness or publication; external runtimes own review policy. This gap map describes the repository CLI contract; it does not claim deployment or live-service verification.

Recommended next ticket: inventory the remaining Web mutations without adding reviewer roles or treating compatibility Accept as a required kernel transition.
