# 22 — CI and release workflow specification

Codex must create actual workflow files during implementation. This document defines their required behavior.

## Pull-request CI

Required jobs:

### `quality`

- install with frozen lockfile;
- formatter check;
- lint;
- strict typecheck;
- build.

### `test-unit-contract`

- unit tests;
- Management API contract fixtures;
- error/redaction tests.

### `test-integration`

- local Supabase integration where supported;
- Management API simulator;
- database dump wrapper tests.

### `test-security`

- archive traversal/symlink/bomb tests;
- secret-canary leakage test;
- dependency audit/review;
- static analysis.

### `test-os`

Matrix:

- Ubuntu;
- macOS;
- Windows.

At least CLI/config/filesystem/subprocess tests execute on each OS.

## Live E2E

Protected secrets only.

Triggers:

- protected/manual workflow;
- nightly optional;
- mandatory before release.

Must:

1. validate source/target refs are dedicated test refs;
2. seed source;
3. run encrypted verified backup;
4. offline verify;
5. dry-run restore;
6. restore target;
7. run semantic parity;
8. run application smoke tests;
9. scan logs for canary secrets;
10. publish only sanitized test summary.

Do not upload decrypted bundle as CI artifact.

## CodeQL/static analysis

Run on pull requests/default branch according to GitHub-supported schedule.

Pin security/release-critical third-party actions to immutable SHAs after implementation chooses them.

## Dependency update automation

Dependabot/Renovate may open updates.

No blind automerge for:

- Supabase CLI/API client;
- archive libraries;
- crypto libraries;
- HTTP/S3 libraries;
- runtime major updates.

Those can change backup semantics or security.

## Release workflow

Requirements:

- protected tag/release trigger;
- requires main/expected commit;
- all required checks green;
- live E2E green for candidate commit;
- version/changelog consistency;
- clean build from source;
- package tests;
- SBOM;
- provenance/attestation where registry supports it;
- publish using short-lived/modern trusted publishing where possible;
- verify published package checksum/install;
- create GitHub release notes.

No long-lived registry token if trusted publishing/OIDC is available for the chosen registry.

## Secret permissions

Workflows use least privilege:

- PR workflows cannot access live E2E secrets from untrusted forks;
- release credentials only in protected environment;
- default `GITHUB_TOKEN` permissions explicitly minimized.

## Artifacts

Safe artifacts:

- test reports without secrets;
- coverage reports using fake fixtures;
- SBOM;
- build/package artifact intended for release.

Unsafe:

- `.env`;
- live HTTP traces;
- backup bundle containing secret data;
- rotation map;
- Vault/API/Edge secrets.

## CI failure policy

Do not mark required jobs `continue-on-error`.

Do not use blanket test exclusions to ship.

Known flaky tests must be fixed or isolated with a documented issue and cannot include integrity/restore/live-E2E release gates.
