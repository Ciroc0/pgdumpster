# Maintainer / agent handoff

This repository is no longer a pre-implementation bootstrap package. It contains a substantial pgDumpster implementation and is currently in **release-convergence** work.

## Start here

1. Read `AGENTS.md` for binding authority and repository rules.
2. Read `PLANS.md` for the current implementation ledger.
3. Read `docs/23-current-status.md` for the concise status/evidence snapshot.
4. Use `docs/01-product-requirements.md`, `docs/02-coverage-matrix.md` and `docs/13-acceptance-criteria.md` as the binding end-state contract.
5. Do not remove fail-closed guards merely to make a command appear complete.

## Current implementation checkpoint

Before this documentation reconciliation the branch checkpoint was `be4df4e` (`test: complete coverage threshold hardening`).

Validated locally:

- 70 test files / 395 tests;
- 94.48% statements;
- 90.32% branches;
- 93.22% functions;
- 95.72% lines;
- `pnpm check` passes.

Regular GitHub CI is green on that checkpoint, including Ubuntu/macOS/Windows × Node 22/24.

## Remaining hard gates

The current CLI deliberately blocks unfinished release behavior:

- `verified`/`quiesced` cross-service consistency is not implemented end-to-end;
- `age` encryption is not wired;
- S3-compatible destination publication is not wired;
- `restore --apply` is not wired through the complete executor/parity path;
- the dedicated hosted source-to-target recovery E2E has not passed;
- CodeQL result publication is blocked by repository code-scanning configuration;
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

Never print, commit or paste live credentials into documentation, test fixtures, logs or issue/PR comments.

## Naming and license

- Brand: `pgDumpster`.
- Repository/package/CLI: `pgdumpster`.
- Domain: `pgdumpster.com`.
- License: PolyForm Shield License 1.0.0, with separate commercial licensing available by written agreement.
