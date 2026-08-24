OWNER_GREEN

# Phone-auth signed UI owner result

## Candidate

- Bounded safety-repair commit: `89b1f0e2391e33bbf42bd562968fc113b2257366`
- Bounded safety-repair tree: `9465323135978ac18dda3c93a099c6eefd661b9d`
- Original implementation commit: `32f026059f89616d786070133a4ec34d4a3d2544`
- Exact base: `9e9753075634435dbd00053b461a31c05f987006`
- Branch: `repair/phone-auth-signed-ui`
- No deployment, PR, live-service mutation, canonical identity use, or live database change was performed.

## Root cause and repair

The exact main tree no longer contained the signed phone gateway/browser source even though the deployed release still contained that older surface. Restoring the deployed source reproduced the corrected same-context failure locally: browser proof verification succeeded, but the gateway stripped all Authorization and forwarded the signed request without confidential backend authority. The current backend therefore returned 401. The restored bootstrap also gated on the removed legacy `/v1/actors` route and its HTML predated the current `#app-shell` UI.

The repair:

1. restores the phone auth store, gateway, operator CLI, browser bootstrap, package/build surface, threat model, and security tests;
2. keeps browser proof validation unchanged and injects only a configured server-side upstream bearer after successful proof;
3. rejects every `/v1/*` request before upstream when that confidential handoff credential is absent;
4. continues stripping browser Authorization, cookies, forwarding, proof, and hop-by-hop headers;
5. gates on current `/v1/devices/me`, integrates the current UI shell, and preserves same-context IndexedDB authority;
6. serves `/favicon.ico` as an explicit 204 and declares it in phone markup.

## Independent SAFETY_RED repair (REVIEW.md line 5)

Reviewer line 5 is addressed directly. `--upstream-authorization-file` is no longer loaded with path-based `readFile`. Startup opens the exact path using `O_RDONLY|O_NOFOLLOW`, plus `O_CLOEXEC` and `O_NONBLOCK` where Node exposes them; unsupported no-follow semantics fail closed. It then uses `fstat` and reads from that same descriptor, with unconditional production checks for a regular file, exactly one hard link, effective-service-UID ownership, no group/other bits, and bounded nonzero size. A second `fstat` rejects identity, ownership, mode, link, size, or timestamp changes. The descriptor closes in `finally` on every path.

Only one 16–512-byte printable credential value is accepted, with at most one terminal LF. NUL, CR, embedded LF, whitespace, malformed, missing, empty, directory, FIFO, symlink, `0640`/`0644`, wrong-owner, hard-linked, oversized, multiline, and changed inputs are rejected before gateway startup or upstream access. Errors are generic and do not include the credential or supplied path. The supported deployment contract remains a service-UID-owned `0600` regular single-link file; filesystem access was not widened and no systemd credential facility was assumed.

## Extractability naming clarification

The supplied `browser-failure.json` field is literally `rec.auth.failure_idb.extractable=true`; no inverse meaning is inferred from that name. The accompanying acceptance report separately calls the key non-extractable. New evidence avoids the ambiguity: `keyNonExtractable=true` means the actual `CryptoKey.extractable` value was `false` **and** `exportKey` was rejected. It also records `keyIsCryptoKey=true` and signing usage.

## Tests and evidence

- Focused credential-file/auth/gateway/CLI/security suite: 35 passed, 0 failed.
- Full `npm test`: 188 tests; 182 passed, 0 failed, 6 skipped.
- `npm run build`: passed.
- `npm run scan:secrets`: passed; 0 high-confidence matches after evidence creation.
- Sealed real-browser E2E at 1280x900: passed Pair -> persisted non-extractable signing `CryptoKey` -> first signed normal UI request 2xx -> visible `#app-shell` -> same-context reload remains authorized.
- Negative coverage passed: all unsafe credential-file cases listed above, one-use pair replay, copied-cookie denial, revoke denial, body/target substitutions, challenge replay, canonical HTTPS origin validation, fixed upstream/Tailscale policy, credential-header stripping, and missing-handoff fail-closed behavior.
- Sanitized status evidence: `artifacts/phone-auth-owner/phone-auth/status.json`.
- Visual evidence: `artifacts/phone-auth-owner/phone-auth/screenshots/`.

## Security invariants

Single active device, one-use intent, origin binding, non-exportable browser key, per-request challenge and exact method/target/body signing, transactional replay fencing, no cookie authority, browser credential stripping, fixed upstream routing, strict remote address/TLS policy, and no direct upstream exposure remain enforced. The backend credential is server-side only and cannot be selected or replaced by browser headers.

## Remaining risk

No live deployment or canonical-origin acceptance was attempted. A reviewer must atomically provision a dedicated service-UID-owned `0600` regular single-link upstream credential file and approved service wiring before any isolated deployment test. Browser compromise can still invoke a resident non-extractable key, as documented. Dependency audit output remains the pre-existing npm advisory state and was not changed in this slice.

## Reviewer checklist

- Verify the bounded safety-repair commit/tree and exact merge base above.
- Recheck REVIEW.md line 5 against `loadUpstreamAuthorization` and its CLI/startup negative matrix.
- Review the confidential gateway-to-backend handoff and absent-credential fail-closed test.
- Confirm no browser-supplied credential reaches upstream.
- Re-run focused tests, full tests, build, secret scan, and sealed E2E.
- Inspect only sanitized `status.json` values; do not collect pairing material or cryptographic identifiers.
- If proceeding later, use only a disposable auth DB/browser profile and approved isolated listener/origin; do not deploy from this owner step.
