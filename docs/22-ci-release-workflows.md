# 22 — CI and release workflow specification

This document records both the **current workflow implementation** and the remaining release-workflow requirements.

Status snapshot: **2026-08-15**.

## Current workflows

The repository currently contains:

- `.github/workflows/ci.yml`;
- `.github/workflows/codeql.yml`;
- `.github/workflows/contract-drift.yml`.

### Regular CI

`ci.yml` currently provides:

- `quality` — frozen install, formatter, lint, strict typecheck and build;
- `test-unit-contract` — build + full test suite on Node 22;
- `test-integration` — CLI/simulator integration slice;
- `test-security` — archive/secret guards plus production dependency audit;
- `test-os` — Ubuntu/macOS/Windows × Node 22/24 CLI/config/filesystem/archive coverage.

The earlier validated implementation checkpoint passed the regular CI workflow, including the OS/Node matrix.

The account's GitHub Actions quota is currently exhausted. Newly pushed workflow runs may therefore be blocked before meaningful execution until the quota resets. Such quota/billing failures are **not** code-quality failures and must not be reported as a failed implementation gate.

During this period, local `pnpm check` and `pnpm test:coverage` are the active development gates. The latest complete local result after the standard `age` slice is:

- `pnpm check`: **PASS**;
- **92 test files / 541 tests: PASS**;
- **94.45% statements / 90.51% branches / 91.89% functions / 95.64% lines**;
- every configured 90% global coverage threshold: **PASS**.

Once quota is available again, the current branch must be rerun through the normal CI matrix before release evidence is considered current.

### Contract drift

A dedicated contract-drift workflow exists and remains part of the platform source-of-truth strategy.

### CodeQL

The CodeQL workflow initializes and analyzes JavaScript/TypeScript with pinned actions and `security-events: write` permission. On the earlier attempted repository run it reached analysis/SARIF generation but failed during result publication/status because GitHub code scanning was not enabled/accessible to the integration (`Resource not accessible by integration`).

This is a **configuration gate**. It must not be documented as a clean static-analysis result, and it also must not be misreported as a discovered code vulnerability.

## Missing release workflows/gates

The repository does not yet have a completed release-grade live-E2E/publish pipeline. Remaining work includes:

- current branch CI rerun once Actions quota permits meaningful execution;
- protected hosted source/target E2E workflow;
- S3-compatible publication/recovery implementation and release evidence;
- restore `--apply`/parity implementation and release evidence;
- release workflow tied to an exact candidate commit/tag;
- SBOM generation;
- provenance/attestation where supported;
- clean package/install smoke verification;
- publication policy/registry finalization;
- final CodeQL result publication and finding disposition.

The standard local `age` encryption path is implemented and locally gated; it is no longer listed as a missing implementation slice. The full encrypted hosted recovery procedure is still pending because S3/restore-apply/parity/live-E2E remain incomplete.

## Live E2E requirement

Protected secrets only. The release E2E must:

1. validate source/target refs are dedicated test refs;
2. reset/seed source and clean target state;
3. run an encrypted `verified` backup;
4. run offline verify;
5. inspect terminal coverage for every registered component;
6. dry-run restore;
7. apply restore to the fresh target;
8. apply required generated-key substitutions through the tested workflow;
9. run semantic parity and application-level smoke checks;
10. scan logs for secret canaries;
11. publish only a sanitized result summary;
12. clean/reset test data according to test-account policy.

Do not upload decrypted bundles, rotation maps, age identity material or live secret material as CI artifacts.

## Release workflow requirements

The eventual release workflow must:

- run from a protected tag/release/candidate commit;
- require all ordinary CI and security gates green on the same candidate;
- require the live E2E green for the same candidate;
- validate version/changelog consistency;
- perform a clean build/package/install smoke;
- generate SBOM;
- generate provenance/attestation where the registry supports it;
- prefer short-lived trusted publishing/OIDC over long-lived registry tokens;
- verify the published artifact checksum/install;
- create release notes without secret-bearing artifacts.

## Permissions and artifacts

Use least privilege. Untrusted PRs must not receive live E2E/release secrets. Default `GITHUB_TOKEN` permissions must remain explicit and minimized.

Safe artifacts include sanitized test summaries, fake-fixture coverage reports, SBOM and intended release packages. Unsafe artifacts include `.env`, live HTTP traces, secret-bearing backup bundles, decrypted age payloads, age identity files, Vault/API/Edge secrets and rotation maps.

## Failure policy

Required jobs must not use blanket `continue-on-error`. Security, integrity, restore and live-E2E gates cannot be bypassed as “flaky” release exceptions.

Quota/billing blockage is tracked separately from job execution status. Once quota is restored, required workflows must actually run and pass; a previously quota-blocked run is not release evidence.
