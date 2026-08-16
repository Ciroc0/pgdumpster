# 22 — CI and release workflow specification

This document records both the **current workflow implementation** and the remaining release-workflow requirements.

Status snapshot: **2026-08-16**.

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

Earlier GitHub Actions quota exhaustion blocked newly pushed workflow runs before meaningful execution. Such quota/billing failures are **not** code-quality failures and must not be reported as a failed implementation gate. Current candidate commits still require a fresh successful remote CI run before they count as release evidence.

The latest complete local result after hosted restore regression hardening is:

- `pnpm check`: **PASS**;
- **116 test files / 726 tests: PASS**;
- **94.61% statements / 90.04% branches / 92.55% functions / 95.65% lines**;
- every configured 90% global coverage threshold: **PASS**.

Once quota is available again, the current branch must be rerun through the normal CI matrix before release evidence is considered current.

### Contract drift

A dedicated contract-drift workflow exists and remains part of the platform source-of-truth strategy.

### CodeQL

The CodeQL workflow initializes and analyzes JavaScript/TypeScript with pinned actions and `security-events: write` permission. On the earlier attempted repository run it reached analysis/SARIF generation but failed during result publication/status because GitHub code scanning was not enabled/accessible to the integration (`Resource not accessible by integration`).

This is a **configuration gate**. It must not be documented as a clean static-analysis result, and it also must not be misreported as a discovered code vulnerability.

## Implemented release workflow and remaining gates

`.github/workflows/release.yml` is implemented but intentionally cannot publish from the current development package: it only runs for a `v*` tag and rejects both `package.json.private: true` and `0.0.0-development`. For a valid candidate, it runs frozen install, `pnpm check`, coverage, tag/version/repository-identity validation, CI-built `npm pack`, SHA-256 checksums, CycloneDX SBOM generation, clean install/CLI smoke, npm trusted publishing with provenance, GitHub artifact attestation and a GitHub Release containing the package, checksums and SBOM.

This implementation is not execution evidence. Remaining release gates include:

- current-candidate CI, including CodeQL result publication and disposition of any findings;
- protected hosted source/target E2E workflow for a release candidate;
- final release candidate version, changelog and registry trusted-publisher configuration. The trusted publisher must target GitHub owner `Ciroc0`, repository `pgdumpster` and workflow filename `release.yml`, with `npm publish` explicitly allowed;
- actual tagged workflow execution, including published-artifact checksum/install verification;

The standard `age` path, S3 publication/recovery and Cloudflare R2 interoperability are implemented and live-validated. A disposable hosted source-to-clean-target restore has also passed with explicit platform limits; it is not a tagged, protected-workflow release-candidate run.

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

`live-e2e.yml` is the protected `workflow_dispatch` implementation of this
gate. It requires the `release-e2e` GitHub Environment and its source/target
project refs, pooler URLs, Management token, scoped source Storage key and
`age` recipient/identity secrets. It rejects equal refs and a target that still contains the dedicated
fixture or Storage buckets before it seeds the source, so an operator must reset
or recreate the disposable target explicitly between runs. Its only persistent
workflow output is a sanitized terminal-status summary; temporary encrypted
bundles, config and the age identity are removed on exit.

## Release workflow requirements

The implemented release workflow is designed to:

- run from a protected tag/release/candidate commit;
- require all ordinary CI and security gates green on the same candidate;
- require the live E2E green for the same candidate;
- validate version/changelog consistency;
- perform a clean build/package/install smoke;
- generate SBOM;
- generate provenance/attestation where the registry supports it;
- prefer short-lived trusted publishing/OIDC over long-lived registry tokens;
- verify the package before publish and upload its checksum; the final release procedure must additionally verify the published registry artifact checksum/install;
- create release notes without secret-bearing artifacts.

Current npm contract note: npm trusted publishing requires npm CLI >= 11.5.1 and Node >= 22.14.0, a GitHub-hosted runner, `id-token: write`, and an exact `package.json.repository.url` match. npm generates package provenance automatically for trusted GitHub publishing only when both repository and package are public. The repository remains private during this development phase, so provenance is a release-time/public-visibility dependency rather than current evidence.

## Permissions and artifacts

Use least privilege. Untrusted PRs must not receive live E2E/release secrets. Default `GITHUB_TOKEN` permissions must remain explicit and minimized.

Safe artifacts include sanitized test summaries, fake-fixture coverage reports, SBOM and intended release packages. Unsafe artifacts include `.env`, live HTTP traces, secret-bearing backup bundles, decrypted age payloads, age identity files, Vault/API/Edge secrets and rotation maps.

## Failure policy

Required jobs must not use blanket `continue-on-error`. Security, integrity, restore and live-E2E gates cannot be bypassed as “flaky” release exceptions.

Quota/billing blockage is tracked separately from job execution status. Once quota is restored, required workflows must actually run and pass; a previously quota-blocked run is not release evidence.
