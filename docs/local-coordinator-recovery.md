# Local coordinator recovery

`viq-recover-coordinator` is a narrow, local-only recovery ceremony for a populated Viq database whose coordinator credential is unavailable. It creates one ordinary, one-use coordinator pairing code bound to an existing active Human admin actor and a fixed new device identity. The existing `/pair` flow consumes the code and returns the device credential; recovery never creates or returns a bearer.

The current private-alpha authorization model has an actor `admin` field. Recovery requires it. A coordinator device bound to that Human admin is the current administration boundary; this command does not add roles or IAM.

## Required prestate

Before invocation, the operator MUST:

1. stop the systemd backend writer and leave it stopped for the complete ceremony;
2. run SQLite integrity verification;
3. create and verify a restorable backup;
4. identify exactly one existing active Human admin actor by immutable, non-secret actor ID;
5. pre-open a new empty regular file as the service UID, mode `0600`, with one hard link, on a private filesystem.

The process uses SQLite `BEGIN IMMEDIATE`, the strongest transaction primitive already used by Viq, to exclude another writer. Source code cannot prove systemd state, integrity history, or backup readiness; the acknowledgement flag records that operator precondition.

Example (run as the service UID, with the backend stopped):

```sh
umask 077
: > /run/viq/recovery-code
chmod 0600 /run/viq/recovery-code
exec 3<>/run/viq/recovery-code
viq-recover-coordinator \
  --storage /var/lib/viq/db.sqlite \
  --actor-id EXISTING_HUMAN_ADMIN_ID \
  --device-id replacement-coordinator \
  --device-name 'Replacement Coordinator' \
  --ack-backend-stopped-and-backup-ready \
  --out-fd 3
exec 3>&-
```

The code expires after a fixed five minutes. Consume it through the ordinary `/pair` path with no role or kind selector, then securely remove the code file. It is one-use and replay is rejected by the standard pairing transaction.

## Transaction and delivery ordering

All arguments and FD properties are checked before database initialization. The storage path is then opened read-only and must already be a same-UID, single-link, non-symlink regular SQLite file with the core Viq schema and at least one device; typo paths, empty bootstrap targets, and wrong databases are rejected without creation or migration. Only after that preflight may normal Viq initialization run. Recovery then begins `BEGIN IMMEDIATE`, validates populated state and actor eligibility, invokes the shared pairing-code insertion path, and appends a dedicated audit event with no code or bearer payload. While the transaction remains uncommitted it writes the code only to the verified FD and calls `fsync`. Write or sync failure rolls back and truncates the file. Only then does it commit. If commit fails after file delivery, rollback is attempted and the FD is truncated and synced before exit.

There is an unavoidable file-before-commit ambiguity: sudden power loss or process death between file sync and database commit can leave output material without a committed row. Treat any nonzero/uncertain invocation as failed, securely delete the output, verify the DB and audit state, and start with a fresh empty file. A deliberate same-UID process can sabotage an already-open descriptor after validation; this private-alpha same-UID trust boundary is bounded debt. Because `fstat` sees the opened inode rather than its opening path, a single-link regular inode reached through a symlink is indistinguishable and introduces no path-following operation in Viq itself.
