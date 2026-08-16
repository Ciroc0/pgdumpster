# 22 - CI and release workflow specification

This document records both the **current workflow implementation** and the remaining release-workflow requirements.

Status snapshot: **2026-08-16**.

## Current workflows

The repository currently contains:

- `.github/workflows/ci.yml`;
- `.github/workflows/codeql.yml`;
- `.github/workflows/contract-drift.yml`.

### Regular CI

`ci.yml` currently provides:

- `quality` - frozen install, formatter, lint, strict typecheck and build;
- `test-unit-contract` - build + full test suite on Node 22;
- `test-integration` - CLI/simulator integration slice;
- `test-security` - archive/secret guards plus production dependency audit;
- `test-os` - Ubuntu/macOS/Windows × Node 22/24 CLI/config/filesystem/archive coverage.

The preceding candidate SHA `0197c4f65f4f020adf3c814d6251fdf494514ee2` passed the whole regular CI workflow on 2026-08-16: [run `31976965121`](https://github.com/Ciroc0/pgdumpster/actions/runs/31976965121). It is exact-SHA evidence for that candidate only; the current `0.1.1` candidate must rerun it.

The latest complete local result after Edge Function source-tree restore hardening is:

- `pnpm check`: **PASS**;
- **118 test files / 760 tests: PASS**;
- **94.47% statements / 90.02% branches / 92.66% functions / 95.44% lines**;
- every configured 90% global coverage threshold: **PASS**.

The current official-contract and protected hosted-E2E workflows remain separate release evidence gates.

### Contract drift

A dedicated contract-drift workflow exists and remains part of the platform source-of-truth strategy.

### CodeQL

The CodeQL workflow initializes and analyzes JavaScript/TypeScript with pinned actions and `security-events: write` permission. It completed successfully for preceding candidate SHA `0197c4f65f4f020adf3c814d6251fdf494514ee2` on 2026-08-16: [run `31976965125`](https://github.com/Ciroc0/pgdumpster/actions/runs/31976965125). A newer candidate must repeat this check.

## Implemented release workflow and remaining gates

`.github/workflows/release.yml` is implemented but intentionally cannot publish until a valid `v*` tag targets a public-repository SemVer candidate. The repository guard is fail-closed: npm provenance and GitHub artifact attestations need public-repository eligibility on the relevant non-Enterprise plans. Before any publish it verifies `vX.Y.Z === package.json.version`, fetches `origin/main` and requires the release SHA to be contained there. It then uses the GitHub Actions API to require successful `CI`, `CodeQL` and `Live hosted E2E` workflow runs with `head_sha === GITHUB_SHA`; success on an older or different commit is rejected. For a valid candidate, it runs frozen install, `pnpm check`, coverage, CI-built `npm pack`, SHA-256 checksums, a CycloneDX SBOM from a fresh production install of that tarball, and a local tarball install/CLI smoke before publishing. After publish it downloads the exact package version from npm, verifies registry/downloaded SHA-512 integrity and package identity against the CI-built tarball, performs a fresh registry install and repeats the CLI smoke. It then creates GitHub artifact attestation and a GitHub Release containing the package, checksums and SBOM.

This implementation is not execution evidence. Remaining release gates include:

- current `0.1.1` candidate CI, CodeQL, contract drift and protected hosted source/target E2E;
- public non-development SemVer candidate, changelog and compatibility/current-contract review. Because npm cannot configure a trusted publisher before a package exists, the first publish uses a short-lived package-scoped `NPM_TOKEN` secret; immediately afterward the trusted publisher must target GitHub owner `Ciroc0`, repository `pgdumpster` and workflow filename `release.yml`, with `npm publish` explicitly allowed, and the token secret/workflow mapping must be removed;
- actual `v0.1.1` tagged workflow execution, including same-SHA CI/CodeQL/protected-E2E evidence and published-artifact checksum/install verification. `v0.1.0` failed before `npm publish` in its SBOM step and is not a published package;

The standard `age` path, S3 publication/recovery and Cloudflare R2 interoperability/performance are implemented and live-validated. Comparative provider fault/load testing is optional confidence work, not a release gate. A disposable hosted source-to-clean-target restore has also passed with explicit platform limits; it is not a tagged, protected-workflow release-candidate run.

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
project refs, pooler URLs, Management token, scoped source/target privileged service keys for the Storage/Auth smokes and
`age` recipient/identity secrets. It rejects equal refs and a target that still contains the dedicated
fixture, Storage buckets, E2E Auth users or any deployed Edge Function before it seeds the source, so an operator must reset
or recreate the disposable target explicitly between runs. Its only persistent
workflow output is a sanitized terminal-status summary; temporary encrypted
bundles, config, age identity and newly created UUID-named restore artifacts
are removed on exit without touching pre-existing local restore files.

## Release workflow requirements

The implemented release workflow is designed to:

- run from a protected tag/release/candidate commit contained in `origin/main`;
- require successful `CI` and `CodeQL` workflow runs whose `head_sha` exactly equals the release SHA;
- require a successful protected `Live hosted E2E` workflow run whose `head_sha` exactly equals the release SHA;
- validate version/changelog consistency;
- perform a clean build/package/install smoke;
- generate SBOM;
- generate provenance/attestation where the registry supports it;
- prefer short-lived trusted publishing/OIDC over long-lived registry tokens;
- verify the package before publish and upload its checksum; download the published registry artifact, compare its identity and SHA-512 integrity with the CI-built tarball, then fresh-install and smoke it;
- create release notes without secret-bearing artifacts.

Current npm contract note: npm trusted publishing requires npm CLI >= 11.5.1 and Node >= 22.14.0, a GitHub-hosted runner, `id-token: write`, and an exact `package.json.repository.url` match. npm generates package provenance automatically for trusted GitHub publishing only when both repository and package are public. GitHub artifact attestations are likewise public-repository-only on GitHub Free, Pro and Team. The repository remains private during this development phase, so provenance/attestation are release-time public-visibility dependencies rather than current evidence.

## Permissions and artifacts

Use least privilege. Untrusted PRs must not receive live E2E/release secrets. Default `GITHUB_TOKEN` permissions must remain explicit and minimized.

Safe artifacts include sanitized test summaries, fake-fixture coverage reports, SBOM and intended release packages. Unsafe artifacts include `.env`, live HTTP traces, secret-bearing backup bundles, decrypted age payloads, age identity files, Vault/API/Edge secrets and rotation maps.

## Failure policy

Required jobs must not use blanket `continue-on-error`. Security, integrity, restore and live-E2E gates cannot be bypassed as “flaky” release exceptions.

Quota/billing blockage is tracked separately from job execution status. Once quota is restored, required workflows must actually run and pass; a previously quota-blocked run is not release evidence.
