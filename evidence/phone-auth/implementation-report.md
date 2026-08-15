# Isolated staging phone-auth focused fix evidence

## Outcome and scope

The reviewer findings were fixed in the existing uncommitted phone-auth slice. The fix is limited to gateway/store hardening, regression/E2E coverage, source scanning, packaging/CI-path wiring, README/runbook/threat-model text, and regenerated evidence. No production, system, DNS, Tailscale, firewall, credential, GitHub, staging, commit, or index mutation was performed. No source certificate, private key, auth database, or live pairing URL was created or retained.

## Focus-round changed files

- Runtime: `src/phone-gateway.js`, `src/phone-auth-store.js`
- Tests/CI path: `test/phone-gateway.test.js`, `test/phone-auth.test.js`, `test/phone-auth-e2e.js`, `test/e2e-all.sh`
- Source scan: `scripts/scan-secrets.js`
- Docs: `README.md`, `docs/phone-auth-staging-runbook.md`, `docs/phone-auth-threat-model.md`
- Evidence: `evidence/phone-auth/`

The other uncommitted phone-auth/package files shown by `git status` are preserved prior-worker output: `.gitignore`, `package.json`, `package-lock.json`, `scripts/build.js`, `scripts/bundle.js`, `scripts/install-local.sh`, `scripts/uninstall-local.sh`, `bin/viq-phone-auth.js`, `docs/adr-0010-isolated-phone-auth.md`, `test/phone-auth-cli.test.js`, `web/phone-bootstrap.js`, and `web/phone-index.html`.

## Reviewer FAIL -> GREEN trace

The original pre-implementation RED remains intact in `red-green.txt`; the focused reviewer FAIL -> GREEN record is appended there.

- Source-IP throttling now runs independently before any attacker-controlled device bucket. Only 16–100 character valid-format IDs get device buckets. Buckets expire after 60 seconds, prune on access, and are capped at 1024. The regression sends 130 unique valid-format fake IDs: request 121 and later return 429 and observed state is at most 121 entries.
- Routing/auth/proxying use `req.url` as the exact raw target. Absolute-form, `//`, backslash/control, malformed percent escapes, and encoded control/dot/slash/backslash are rejected. `/v1/%2e%2e/health` cannot normalize onto the public health target. Public targets are exactly `/`, `/phone-bootstrap.js`, `/app.css`, `/app.js`, and `/health`; unknown non-v1 targets fail closed.
- Auth request JSON is capped at 8192 bytes; application/proxy bodies remain capped at 1,048,576 bytes.
- Origins must equal `URL.origin` for an HTTPS URL with no credentials, non-root path, query, hash, trailing slash, case, or default-port ambiguity.
- Store initialization chmods a parent to 0700 only when it creates that parent. Existing parent mode is unchanged; the DB is chmodded 0600.
- `Set-Cookie` is removed from upstream responses.
- A complete cert/key pair selects gateway TLS. Otherwise production startup requires explicit `tlsTerminated` / `--tls-terminated=true`; `testMode` remains API-only for automated tests and is not exposed by the launcher. The external configured origin remains canonical HTTPS.
- `npm run e2e` now invokes the phone browser E2E, so the existing CI full-E2E step covers it. README lists all six launchers and links the staging runbook.
- Secret scanning uses `git ls-files --cached --others --exclude-standard`; git patch-history scanning remains unchanged.
- Phone E2E gives the already-used valid fragment to a second isolated browser context, performs one tap, observes denial, separately tests copied cookies, and asserts both pairing secrets are absent from network URL/body/referrer and console logs.
- Store tests exercise concurrent two-device redemption (exactly one winner), reject pair/challenge use at `now === expires`, keep only the latest pending pair intent, and make local revoke invalidate an unused pending intent. Pair-create JSON emits the fragment URL but no duplicate standalone secret field.
- A final fresh native Pi verifier reran focused and browser checks plus an independent loopback header probe and returned PASS with no defects (`final-native-pi-verifier.txt`).

## Commands and actual final results

- `node --test test/phone-auth.test.js test/phone-gateway.test.js test/phone-auth-cli.test.js` -> PASS 20/20 (`focused-output.txt`).
- Baseline 11-file `node --test ...` command -> PASS exactly 25/25 (`baseline-25-output.txt`).
- `npm test` -> PASS 45/45 (`test-output.txt`).
- `node test/phone-auth-e2e.js` -> PASS with same-fragment isolated-context denial and no token leakage (`e2e-output.txt`).
- `VIQ_EVIDENCE_DIR=evidence/phone-auth/full-e2e npm run e2e` -> PASS: `E2E_OK`, `MCP_E2E_OK`, `BROWSER_E2E_OK`, and phone E2E PASS (`full-e2e-output.txt`).
- `npm run build` -> PASS (`build-output.txt`).
- `npm run bundle` twice, `cmp`, and release checksum verification -> PASS; byte-identical SHA-256 `3c4e27d9427ae64299187cb4296162b9a4f35c23b9b2a644e2a3fe3615c2d32b` (`bundle-1.txt`, `bundle-2.txt`, `bundle-determinism.txt`).
- `npm pack --dry-run --json` -> PASS: 34 files, 43,542-byte package, 147,006 bytes unpacked (`pack-dry-run.json`).
- `npm run scan:secrets` -> PASS: the complete cached/untracked proposed-source set plus unchanged git patch history, zero high-confidence matches (`secret-scan.txt`).
- Targeted proposed-source/history/artifact scan -> PASS: no source DB/cert/key artifact, live pairing URL, private JWK material, private key, or targeted history match (`targeted-scan.txt`).
- `git diff --check` -> PASS; `git diff --cached --name-only` -> empty (`diff-check.txt`).

One earlier baseline invocation was run concurrently with `npm test`; both local-bundle tests raced while rebuilding `dist`, and that baseline invocation reported one transient `ENOENT`. This was a check-orchestration error, not a product workaround. The required baseline and `npm test` were then rerun sequentially and passed as recorded above.

## Residual risks

- `node:sqlite` remains experimental in Node 22.
- A compromised browser/profile or same-origin script can invoke the non-extractable key; this is profile binding, not hardware attestation or user presence.
- In-memory limits reset at process restart; live state is expiry-pruned and capped.
- External TLS termination is trusted and must remain approved and loopback-only on its HTTP leg.
- Cutover approvals remain intentionally outstanding; no ingress was activated.

```acceptance-report
{
  "criteriaSatisfied": [
    {"id":"criterion-1","status":"satisfied","evidence":"Focused hardening and requested regression/E2E/docs/scan changes are implemented without changing the existing application server or activating infrastructure; focused 20/20, baseline 25/25, npm 45/45, phone E2E, and full npm E2E pass."},
    {"id":"criterion-2","status":"satisfied","evidence":"evidence/phone-auth contains final command outputs, preserved RED plus reviewer FAIL->GREEN, deterministic bundle proof, pack output, scans, diff/index check, and this acceptance trace."}
  ],
  "changedFiles": [".gitignore","README.md","package.json","package-lock.json","scripts/build.js","scripts/bundle.js","scripts/install-local.sh","scripts/scan-secrets.js","scripts/uninstall-local.sh","test/e2e-all.sh","bin/viq-phone-auth.js","docs/adr-0010-isolated-phone-auth.md","docs/phone-auth-staging-runbook.md","docs/phone-auth-threat-model.md","src/phone-auth-store.js","src/phone-gateway.js","test/phone-auth-cli.test.js","test/phone-auth-e2e.js","test/phone-auth.test.js","test/phone-gateway.test.js","web/phone-bootstrap.js","web/phone-index.html","evidence/phone-auth/"],
  "testsAddedOrUpdated": ["test/phone-auth.test.js","test/phone-gateway.test.js","test/phone-auth-e2e.js","test/e2e-all.sh"],
  "commandsRun": [
    {"command":"node --test test/phone-auth.test.js test/phone-gateway.test.js test/phone-auth-cli.test.js","result":"passed","summary":"20/20 focused tests"},
    {"command":"node --test [11 baseline test files]","result":"passed","summary":"exactly 25/25 baseline tests on sequential rerun"},
    {"command":"npm test","result":"passed","summary":"45/45"},
    {"command":"node test/phone-auth-e2e.js","result":"passed","summary":"same-fragment second-context and copied-cookie denial; no token leakage"},
    {"command":"VIQ_EVIDENCE_DIR=evidence/phone-auth/full-e2e npm run e2e","result":"passed","summary":"CLI, MCP, browser, and phone browser E2E all passed"},
    {"command":"npm run build","result":"passed","summary":"built dist"},
    {"command":"npm run bundle twice; cmp; sha256sum -c","result":"passed","summary":"byte-identical SHA-256 3c4e27d9427ae64299187cb4296162b9a4f35c23b9b2a644e2a3fe3615c2d32b"},
    {"command":"npm pack --dry-run --json","result":"passed","summary":"34 files; 43542 bytes"},
    {"command":"npm run scan:secrets; targeted proposed-source/history/artifact scan","result":"passed","summary":"complete proposed-source set and unchanged history; no secret/artifact findings"},
    {"command":"git diff --check; git diff --cached --name-only","result":"passed","summary":"clean diff and empty index"}
  ],
  "validationOutput": ["focused 20/20","baseline exactly 25/25","npm test 45/45","phone browser E2E PASS","full npm E2E includes phone and passes all four paths","bundle deterministic","secret/target scans PASS","no staged files"],
  "residualRisks": ["node:sqlite is experimental","profile/XSS compromise can invoke the key","in-memory limits reset on restart","external TLS terminator remains trusted","cutover approvals remain outstanding"],
  "noStagedFiles": true,
  "diffSummary": "Hardens the isolated phone gateway/store boundaries, adds focused and browser regressions, wires phone E2E into the full path, expands proposed-source scanning, updates operational docs, and regenerates evidence.",
  "reviewFindings": ["no blockers"],
  "manualNotes": "No commit or production/system/GitHub mutation. One concurrent validation invocation raced on dist; sequential required checks passed and are the recorded final evidence."
}
```
