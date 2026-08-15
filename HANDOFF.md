# Maintainer / agent handoff

This repository is no longer a pre-implementation bootstrap package. It contains a substantial pgDumpster implementation and is currently in **release-convergence** work.

## Start here

1. Read `AGENTS.md` for binding authority and repository rules.
2. Read `PLANS.md` for the current implementation ledger.
3. Read `docs/23-current-status.md` for the concise status/evidence snapshot.
4. Use `docs/01-product-requirements.md`, `docs/02-coverage-matrix.md` and `docs/13-acceptance-criteria.md` as the binding end-state contract.
5. Do not remove fail-closed guards merely to make a command appear complete.

## Current implementation checkpoint

Latest complete local gate on 2026-08-15 after the cross-service consistency/resume hardening and standard `age` encryption slices:

- `pnpm check`: **PASS**;
- **92 test files / 541 tests: PASS**;
- global coverage: **94.45% statements / 90.51% branches / 91.89% functions / 95.64% lines**;
- all independent 90% coverage thresholds: **PASS**;
- all 10 product backup steps have consistency adapters and step-owned partial cleanup;
- default `verified`, explicit `quiesced` and `best-effort` flow through the backup CLI;
- best-effort observable drift is persisted as `drift_detected` across checkpoint/resume;
- standard `age` recipient encryption is wired into backup publication;
- encrypted backup output is `.tar.zst.age`; successful encrypted publication removes the plaintext archive and working bundle;
- `.tar.zst.age` is accepted by inspect/coverage/verify and restore dry-run when an `encryption.identityFile` reference is configured;
- the `age` subprocess path is shell-free, bounded, atomic and maps missing tooling to the dependency error domain;
- Windows encrypted-output publication is covered by the local test suite;
- `doctor` checks `age --version` and reports availability separately from the remaining destination/restore gates.

The account's GitHub Actions quota is currently exhausted, so newly pushed workflows may be blocked by quota. Use local `pnpm check` and `pnpm test:coverage` as the active quality gates until reset; do not interpret quota failures as code failures.

## Consistency boundary

The consistency phase is implemented end-to-end for the current backup product steps.

- `verified`: stable pre/post evidence is required; observable drift causes bounded selective retry after safe cleanup.
- `quiesced`: observable drift fails immediately.
- `best-effort`: a valid copy can complete without verified retry, but observed drift is reported as `drift_detected`.
- copy-time drift from source-specific adapters participates in the same policy.
- interrupted non-completed steps are cleaned before resume.

This is an application-level cross-service stabilization contract. It is not a claim that Supabase exposes one atomic snapshot transaction across PostgreSQL, Storage, Management APIs, Edge and every managed service.

## Encryption boundary

Standard `age` archive encryption is implemented for local publication.

- Backup config `encryption.mode: age` requires `encryption.recipient`.
- Encrypted backup automatically creates the deterministic `.tar.zst` transport form and wraps it as `.tar.zst.age`; users do not need `--archive` separately.
- `--allow-plaintext-secrets` remains required only when creating a non-encrypted secret-bearing backup.
- Reading `.tar.zst.age` requires a configured `encryption.identityFile`; the private key material itself is not accepted as a CLI argument.
- `doctor` can prove whether the `age` executable is available. A direct backup with missing tooling also fails through the dependency error domain.
- A hard process kill can still leave the protected resumable workspace/checkpoint; crash recovery is separate from normal encryption cleanup.

## Remaining hard gates

The current CLI deliberately blocks unfinished release behavior:

- S3-compatible destination publication is not wired;
- `restore --apply` is not wired through the complete executor/substitution/parity path;
- the dedicated hosted source-to-target recovery E2E has not passed;
- CodeQL result publication is blocked by repository code-scanning configuration/access;
- SBOM/provenance/package-smoke/release workflow remains to be completed.

The safe implementation order is recorded in `PLANS.md`.

## Validation commands

Normal local gate:

```bash
pnpm check
pnpm test:coverage
```

Do not report a release as complete from these commands alone. The final gate requires the hosted E2E procedure in `docs/10-testing.md`.

## Live test boundary

Dedicated hosted Supabase source and target projects are test-only resources. Never substitute mocks for the final source → encrypted verified backup → offline verify → fresh-target restore → semantic-parity proof.

Never print, commit or paste live credentials, `age` identity contents or backup secret material into documentation, test fixtures, logs or issue/PR comments.

## Naming and license

- Brand: `pgDumpster`.
- Repository/package/CLI: `pgdumpster`.
- Domain: `pgdumpster.com`.
- License: PolyForm Shield License 1.0.0, with separate commercial licensing available by written agreement.
