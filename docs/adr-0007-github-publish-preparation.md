# ADR 0007: bounded GitHub publish preparation

Status: prepared; execution remains with the release coordinator

The authorized target is the public GitHub repository `makscee/viqueue` and prerelease tag/release `v0.2.0`. This repository records corresponding package metadata, GitHub private vulnerability-reporting instructions, concise release notes, and a least-permission CI workflow.

CI runs on pushes and pull requests to `main`, grants only `contents: read`, uses Node.js 22, and validates tests, build, secret scan, complete local E2E, deterministic bundle generation, and checksum. It has no publish, release, package, deployment, write-token, artifact-upload, or external announcement step.

The release asset is versioned as `viqueue-v0.2.0-rc.tar.gz`; its internal directory uses the same name. The archive is deterministic and accompanied by a SHA-256 file. The package version remains `0.2.0`; GitHub must mark the release as a prerelease. Nothing in this phase creates a repository, remote, tag, release, package publication, domain, or announcement.
