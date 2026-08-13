# Cass final fresh verification — v0.3 Daily Alpha

## Verdict: PASS

No S0/S1 blockers were found. The repaired real browser consumer path now retains the one-time claim token and uses it successfully for a progress mutation. Prior importer, CI artifact-name, evidence, core-contract, docs, and scope checks also pass independently.

## Acceptance verification

- **Real browser claim → token → progress: PASS.** After a fresh build, a new headless Chromium session created project `ABC` and ticket `ABC-1`, opened detail, claimed as `browser-worker`, observed a populated 43-character `Claim token`, posted `fresh browser progress`, and verified through `/v1/events?ticket=ABC-1` that a `progress` event by `browser-worker` existed at cursor 3. There were zero page errors. The repaired handler is at `web/app.js:10`; regression coverage at `test/browser-e2e.js:5` now asserts the token is non-empty and posts progress.
- **Importer target safety: PASS.** A direct `bin/viq-import.js` probe against an existing target exited 1 with `target already exists` and preserved `PRECIOUS` byte-for-byte. `bin/viq-import.js:4-8` only removes a target created during the failed run; coverage is `test/import.test.js:5`.
- **Importer state/authority safety: PASS.** A legacy `state:"claimed",claim:null` record exited 1 with `cannot faithfully migrate claim` and created no target. A complete legacy stale claim imported as canonical `open`, retained actor `w` and generation 7, and verified with the original token. Validation is at `bin/viq-import.js:6`; coverage is `test/import.test.js:4`.
- **CI/release names and determinism: PASS.** `.github/workflows/ci.yml:46-50` consistently uses `viqueue-v0.3.0-rc.tar.gz`. Replaying that exact two-bundle comparison produced identical SHA-256 `d75bef7f572a4412d4a30850aecaf83f49d1f926ffb8d82fa6743a3a8dd5fb9a`; `sha256sum -c` reported `OK`.
- **Full automated validation: PASS.** `npm test` passed 21/21. `npm run build` passed. A fresh `npm run e2e` passed CLI (`E2E_OK`), MCP (`MCP_E2E_OK`), and Chromium (`BROWSER_E2E_OK`). Bundle installation/uninstallation is exercised by `test/local-bundle.test.js` within the 21-test run.
- **Core v0.3 contract: PASS.** The test run covers SQLite restart durability, durable non-expiring claims, atomic competing claims across independent connections, hash/token fencing, explicit release/takeover/submit/accept/reopen, global cursor filtering, HTTP, CLI, MCP, board projection, and import. Canonical runtime source/generated bundle had no removed `expires_at`, heartbeat, renew, lease, or TTL terms.
- **Docs/evidence/scope: PASS.** `README.md:5-58`, `docs/adr-0008-v03-daily-alpha-core.md:5-15`, and `release-notes/v0.3.0.md` describe durable claims, progress as observation, the explicit lifecycle, fail-closed import, local prerelease status, four-column browser, and excluded features. Every artifact named by `evidence/v0.3/manifest.md` exists; screenshots are valid 1440×960 and 390×844 PNGs. Secret scan passed 89 tracked files plus git patch history with zero high-confidence matches. No publish/push/tag/deploy/worker launch is introduced.
- **Repository state: PASS.** `git diff --cached --name-only` returned no paths; there are no staged files. The v0.3 work remains an intentionally large uncommitted worktree.

## Findings and residual risks

- **No blockers.** No S0 or S1 findings.
- **S3 / UNSCOPED:** Node 22 emits the documented experimental warning for `node:sqlite`; ADR 0008 records the runtime choice and all validation passed.
- **S3 / UNSCOPED:** The worktree contains generated/untracked evidence and release outputs; final commit/release hygiene remains an operator responsibility. Secret scan and deterministic bundle verification are green.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "No blockers found; concrete PASS evidence identifies web/app.js:10, test/browser-e2e.js:5, bin/viq-import.js:4-8, test/import.test.js:4-5, and .github/workflows/ci.yml:46-50, with fresh command outputs and bounded S3 residuals."
    }
  ],
  "changedFiles": [
    ".github/workflows/ci.yml",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "README.md",
    "bin/viq.js",
    "bin/viq-import.js",
    "docs/adr-0002-phase1-contract-and-mcp.md",
    "docs/adr-0003-phase2-board-projection.md",
    "docs/adr-0004-phase21-responsive-navigation.md",
    "docs/adr-0008-v03-daily-alpha-core.md",
    "evidence/v0.3/",
    "package-lock.json",
    "package.json",
    "release-notes/v0.2.0.md",
    "release-notes/v0.3.0.md",
    "scripts/build.js",
    "scripts/bundle.js",
    "scripts/install-local.sh",
    "scripts/uninstall-local.sh",
    "src/http-client.js",
    "src/mcp-server.js",
    "src/server.js",
    "src/store.js",
    "test/board-http.test.js",
    "test/browser-e2e.js",
    "test/cli.test.js",
    "test/domain.test.js",
    "test/e2e.sh",
    "test/http.test.js",
    "test/import.test.js",
    "test/local-bundle.test.js",
    "test/mcp-e2e-client.js",
    "test/mcp-e2e.sh",
    "test/mcp.test.js",
    "test/release-hygiene.test.js",
    "web/app.css",
    "web/app.js",
    "web/index.html"
  ],
  "testsAddedOrUpdated": [
    "test/board-http.test.js",
    "test/browser-e2e.js",
    "test/cli.test.js",
    "test/domain.test.js",
    "test/e2e.sh",
    "test/http.test.js",
    "test/import.test.js",
    "test/local-bundle.test.js",
    "test/mcp-e2e-client.js",
    "test/mcp-e2e.sh",
    "test/mcp.test.js",
    "test/release-hygiene.test.js"
  ],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "21 tests passed, 0 failed."
    },
    {
      "command": "npm run build",
      "result": "passed",
      "summary": "Fresh dist build completed."
    },
    {
      "command": "VIQ_EVIDENCE_DIR=$(mktemp -d) npm run e2e",
      "result": "passed",
      "summary": "Fresh CLI, MCP stdio, and Chromium suites reported E2E_OK, MCP_E2E_OK, and BROWSER_E2E_OK."
    },
    {
      "command": "fresh Playwright UI claim/token/progress probe with API event verification and pageerror capture",
      "result": "passed",
      "summary": "REAL_BROWSER_OK token_length=43 progress_cursor=3 page_errors=0."
    },
    {
      "command": "existing-target, claimed/null-claim, and complete stale-claim viq-import probes",
      "result": "passed",
      "summary": "Existing target preserved; inconsistent state rejected without target creation; complete authority retained and original token verified."
    },
    {
      "command": "npm run bundle twice; compare release/viqueue-v0.3.0-rc.tar.gz SHA-256; sha256sum -c",
      "result": "passed",
      "summary": "Both archives had SHA-256 d75bef7f572a4412d4a30850aecaf83f49d1f926ffb8d82fa6743a3a8dd5fb9a and checksum validation was OK."
    },
    {
      "command": "npm run scan:secrets; canonical runtime removed-lifecycle grep; evidence manifest/PNG validation",
      "result": "passed",
      "summary": "89 tracked files plus history had 0 high-confidence matches; canonical runtime scope was clean; all named evidence existed and PNG dimensions matched documentation."
    },
    {
      "command": "git diff --cached --name-only",
      "result": "passed",
      "summary": "No staged files."
    }
  ],
  "validationOutput": [
    "npm test: 21 passed, 0 failed",
    "fresh npm run e2e: E2E_OK; MCP_E2E_OK; BROWSER_E2E_OK",
    "real browser: token length 43; progress cursor 3; zero page errors",
    "existing import target: exit 1 and content remained PRECIOUS",
    "claimed/null import: exit 1 and target_exists=no",
    "complete stale import: state=open actor=w generation=7 token_verified=yes",
    "CI replay: identical v0.3 archive hashes and checksum OK",
    "secret scan: 89 tracked files and history, 0 high-confidence matches",
    "evidence screenshots: valid 1440x960 and 390x844 PNGs"
  ],
  "residualRisks": [
    "S3 UNSCOPED: Node 22 node:sqlite emits its documented experimental API warning.",
    "S3 UNSCOPED: large uncommitted worktree plus generated evidence/release outputs requires normal final commit and release discipline."
  ],
  "noStagedFiles": true,
  "diffSummary": "v0.3 replaces the JSON lease model with a SQLite durable explicit-claim lifecycle, canonical HTTP state machine, updated CLI/MCP/browser/import surfaces, release tooling, documentation, tests, and evidence; the second-round browser token repair is verified end to end.",
  "reviewFindings": [
    "no blockers",
    "verified repair: web/app.js:10 retains the returned claim token and a real browser progress mutation succeeds",
    "verified prior repairs: bin/viq-import.js:4-8 preserves existing targets and rejects state/claim inconsistency",
    "verified CI: .github/workflows/ci.yml:46-50 uses deterministic v0.3 artifact names"
  ],
  "manualNotes": "PASS — final fresh verification completed against the v0.3 Daily Alpha brief."
}
```
