# Viq first-class per-user Pi extension handoff

## Identity

Frozen base: `f867d9a7e79158aa167bd6ac0527b89d7a68ee2a`, tree `5fad3f0fd776467f2d96eaddb54d3c2689f695f4`, branch `work/viq-command-v3`. Final SHA/tree/clean status are in the final response because a committed artifact cannot contain its own resulting object ID.

## RED → GREEN evidence

- RED: `TMPDIR=/root/work/tmp/viq-command-v3 node --test test/viq-command-v3.test.js` produced 4 failures / 2 passes before production changes: bound issuance/code-only pairing, legacy validation, required admin/UI fields, and canonical commands.
- GREEN: the focused acceptance file passed 7/7, including disposable Pi package discovery and credential canary.
- GREEN: pairing/command/coordinator/install regression focus passed 17/17.
- The clean committed-tree `npm test` result is recorded in the final response.

## Exact behavior and files

- `src/store.js`: additive nullable `pairing_codes.device_id/device_name` migration; issuance binds actor/kind/id/name; code-only consumption; conflicting substitutions rejected before consumption; legacy rows require explicit id/name; code stays hashed and absent from events.
- `src/server.js`: new admin issuance requests require validated actor, intended kind, device ID, and device name.
- `web/app.js`: issuance form sends all four bound fields; legacy browser pairing remains compatible.
- `bin/viq.js`: CLI pair-code issuance requires the same bound intent fields.
- `extensions/viq-worker/index.ts`: `/viq` and deprecated `/viq-worker` register one handler; no-arg help/status; `poll` and `start` invoke the same current-session runtime; ordinary UID 0 is allowed; explicit historical lockdown alone keeps root/workspace/shell restrictions.
- `extensions/viq-worker/worker-runtime.mjs`: code-only pairing omits absent legacy identity fields.
- `extensions/viq-worker/credential-store.mjs`: `${XDG_CONFIG_HOME:-~/.config}/viq/credential.json`, strict JSON, 0700 directory, 0600 file, atomic replacement, owned regular-file and no-symlink checks, corruption-safe errors.
- `test/viq-command-v3.test.js` plus updated regressions: bound/legacy/API/UI/aliases/poll/root/permissions/home isolation/canary/discovery.
- `README.md`: per-user happy path, trust model, commands, optional legacy lockdown, install and rollback guidance.

## Trust model and residual risk

The Pi process is trusted as its Unix user. It necessarily can read that user's credential, and shell-capable tools under the same Unix identity can also read it. This is the accepted private-alpha tradeoff. The implementation does not put the credential in prompts, status, argv, environment, repository/workspace, request bodies, stdout/stderr, or event logs; authenticated HTTP uses only the Authorization header. Same-user sessions share config; different homes do not. Polling has Pi-session lifetime and no daemon. Residual risk is compromise or misuse of the Unix account/Pi process itself.

## Install, smoke, rollback (not run against live profiles)

1. In the target user's ordinary shell, run `pi install <Viq package>`.
2. Start a subsequent Pi/`vc` session and confirm RPC/TUI command discovery includes `/viq` and `/viq-worker`.
3. Have an admin issue a worker code bound to actor/kind/device ID/name; run `/viq pair CODE`, then `/viq status`, then `/viq poll --project KEY`.
4. Confirm `${XDG_CONFIG_HOME:-~/.config}/viq` is 0700 and `credential.json` is 0600; stop with `/viq stop`.
5. Roll back by stopping polling, using Pi's package removal/reversion for the same package lineage, and restoring the previous package version. Preserve or explicitly remove the per-user credential only according to operator intent. Existing dedicated `viq-worker` installs remain untouched.

No live root/worker Pi profile, alpha package, system unit, or `/opt/viq-worker` was modified.
