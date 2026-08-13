# ADR 0006: Apache-2.0 public-source preparation

Status: accepted; publication not authorized

Maks approved Apache License 2.0. The repository therefore includes the canonical Apache License 2.0 text in `LICENSE`, uses SPDX identifier `Apache-2.0` in package metadata, and includes the license in the local bundle and installation.

No `NOTICE` file is included. viqueue currently has no required attribution notices, bundled third-party runtime code, or approved project-owner attribution to place there. Apache-2.0 does not require creating a NOTICE file when none is needed. No personal or company copyright assignment is invented.

Public-source hygiene is intentionally small: contribution guidance, an honest security process placeholder, changelog/version policy, explicit package file allowlist, and release-content tests. A separate code of conduct and issue/PR templates are deferred until a public hosting location and governance process exist; generic boilerplate would claim processes the project does not yet operate.

Version `0.2.0` remains a pre-1.0 local release-candidate identifier. This change does not publish a package, create a public repository, clear the name, or assert production readiness. Public hosting/publication and concrete private vulnerability reporting remain external authority/setup gates.
