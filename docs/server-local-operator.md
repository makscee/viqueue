# Server-local operator CLI

`viq operator pairing create` is the narrow recovery-independent control path for issuing Browser handoffs on the Viq service host. It uses the existing authenticated `/v1/devices/me` and `/v1/pairing-codes` core routes; there is no local admin HTTP route, unauthenticated network listener, or direct SQLite write.

```sh
viq operator pairing create \
  --kind browser \
  --name 'Maks browser' \
  --output /root/work/viq-cli-first-operator/browser-handoff.json
```

The command accepts only Browser issuance. Worker handoffs remain `viq device pair-code`. Human Accept is not an operator subcommand. The server origin defaults to `http://127.0.0.1:17373` and any non-loopback origin is rejected. The command reads the authority from `/etc/viqueue-alpha/operator.credential`, verifies it through `/v1/devices/me`, generates a unique bound Browser device ID, and requests one coordinator-kind pairing intent for the credential's admin actor. It emits only output path and expiry to stdout. The code-only JSON handoff is created with `O_EXCL|O_NOFOLLOW`, mode `0600`, synced, and never overwritten.

## Credential lifecycle

The credential file is the deterministic local operator authority. It must be a root-owned, single-link regular file, mode `0600`, containing exactly one active coordinator device credential and an optional final newline. The CLI opens it with `O_NOFOLLOW`, checks effective-UID ownership, permissions, type, link count, bounded size, and stable inode metadata. It never accepts the credential in argv or environment. Keep its parent directory root-owned and non-writable by other users. The service does not need access to this file.

Fresh installation ceremony:

1. Set `umask 077`, bootstrap the first coordinator through `viq-bootstrap`, and capture its one-time JSON output in a root-only temporary file (never a terminal or log).
2. Extract only its `credential` value into a same-directory temporary file, fsync it, set owner `root:root` and mode `0600`, then atomically rename it to `/etc/viqueue-alpha/operator.credential`.
3. Verify `viq operator pairing create` against loopback, consume and revoke the disposable verification Browser, and securely remove the bootstrap temporary file.

Upgrade installers must neither replace nor remove `/etc/viqueue-alpha/operator.credential`. Rotation uses normal product behavior: issue and consume an exactly bound replacement coordinator pairing, atomically install the returned credential with the same ownership/mode, verify it locally, then revoke the old coordinator device. If the file is lost or its device was revoked, follow [local coordinator recovery](local-coordinator-recovery.md) while the backend is stopped and backed up, consume the recovery code through the ordinary pairing API, and atomically reinstall the returned credential. Never copy credentials into tickets, command lines, environment variables, transcripts, or build artifacts.

## CLI-first gap map

Already CLI/core-first and currently implemented: project create/list; ticket create/list/show/edit; category assignment (`Unassigned`, `Human`, `Agent`); worker next/claim/release/verify/submit; device list/revoke and bound pairing-code issuance; role create/list/grant/revoke. Browser pairing from the service host is covered by the operator command above. Exact actor assignment, open-question listing/answering, ticket state/board position, notes/history, deletion, block resolution, and machine-oriented views exist as core HTTP routes but do not all have first-class `viq` commands. Archive/restore has store support but no current HTTP/CLI surface.

The Web UI remains a client of those core routes, but it is currently the convenient surface for several of the latter operations. Recommended next ticket: inventory every Web mutation against a typed CLI command, then add narrow commands for exact actor assignment and non-approval question answers first. Keep approval Accept explicitly human-only and out of model/operator automation.
