# Viq canonical command bounded repair

## Scope and identity

Reviewed target: `d798c8403e3ad138e78f3af0c11ca50d131834f2`, tree `d3a45da6cfa7529cea2efa646130336d7343a7ec`. Only S1 (relative config root) and S2 (README free-pool wording) were changed. The final repair commit/tree are reported in the final response; a file committed by that same commit cannot contain its own resulting Git object ID. Final identity is reproducible with `git rev-parse HEAD HEAD^{tree}`.

## RED → GREEN

All commands used `TMPDIR=/root/work/tmp/viq-command-v3-repair` (mode 0700).

- RED before production edit: `node --test test/viq-command-v3.test.js` — 7 passed, 1 failed. Failure: `relative or empty XDG config roots fail before creating workspace credential paths`.
- GREEN credential/canonical file: `node --test test/viq-command-v3.test.js` — 8/8 passed.
- GREEN relevant pairing/worker focus: `node --test test/viq-command-v3.test.js test/viq-worker-pairing.test.js test/pairing-poc.test.js test/coordinator-controls.test.js` — 18/18 passed.
- `git diff --check` — passed with no output.
- Final clean-tree full-suite result is recorded in the final response.

## Exact repair

- `extensions/viq-worker/credential-store.mjs`: `defaultCredentialPath()` now rejects set `XDG_CONFIG_HOME` values that are empty/whitespace-only, relative, or NUL-containing. The unset fallback must also resolve to an absolute config root. Validation occurs before filesystem creation; relative values are never reinterpreted against home or CWD. Existing single credential location, 0700/0600 modes, atomic replacement, ownership, regular-file, no-symlink, and corruption checks remain unchanged.
- `test/viq-command-v3.test.js`: adds RED-first regression coverage proving relative and whitespace-only roots fail and create neither the configured relative directory nor a `viq` directory beneath the disposable workspace.
- `README.md`: documents canonical assigned-first behavior plus atomically claimable eligible unassigned/free-pool tickets within project/role/membership boundaries. Claim implementation was not changed.

## Residual risk

The accepted per-user trust model is unchanged: a Pi process and shell-capable tools running as that Unix user can read the user's credential. Absolute operator-selected config roots may still point to inappropriate absolute locations; ownership/no-symlink/private-mode checks constrain the resulting path, while selecting a suitable absolute XDG root remains operator responsibility. No credential migration, alternate location, broker, daemon, or live mutation was added.
