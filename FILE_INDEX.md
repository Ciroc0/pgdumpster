# File index

This index describes the maintained pgDumpster repository documentation and policy surfaces. It is no longer a bootstrap-package QA snapshot.

Last reconciled with the implementation branch: **2026-08-15**.

## Core repository files

- `.editorconfig`: cross-editor text conventions.
- `.env.example`: credential/environment template with no real secrets.
- `.github/ISSUE_TEMPLATE/*`: issue templates/config.
- `.github/PULL_REQUEST_TEMPLATE.md`: pull-request template.
- `.github/workflows/ci.yml`: quality, test, integration, security and OS/Node CI.
- `.github/workflows/codeql.yml`: CodeQL analysis workflow; repository code-scanning setting is still a release gate.
- `.github/workflows/contract-drift.yml`: official contract-drift validation.
- `.gitignore`: secret/build/backup exclusions.
- `AGENTS.md`: binding agent instructions and authority order.
- `CHANGELOG.md`: release changelog.
- `CODE_OF_CONDUCT.md`: conduct policy.
- `CONTRIBUTING.md`: contribution workflow/invariants.
- `HANDOFF.md`: current maintainer/agent handoff.
- `LICENSE`: PolyForm Shield License 1.0.0 verbatim.
- `NOTICE`: required notices/protected line of business.
- `LICENSING.md`: public-source/commercial licensing explanation.
- `PLANS.md`: current implementation ledger.
- `README.md`: project/operator entry point.
- `SECURITY.md`: security disclosure policy.
- `SUPPORT.md`: support and safe diagnostic guidance.
- `package.json` / `pnpm-lock.yaml`: package/runtime/dependency contract.
- `spec/coverage-registry.yaml`: canonical 55-component coverage registry.
- `schemas/*.json`: bundle manifest/coverage schemas.
- `contracts/*`: dated official-platform contract snapshots.
- `src/*`: CLI and implementation.
- `tests/*`: unit/integration/hardening tests.

## Consistency and resume implementation

- `src/core/backup/consistency.ts`: generic verified/best-effort/quiesced consistency engine; handles pre-snapshot, copy-time and post-snapshot drift, bounded verified retry and safe cleanup requirements.
- `src/core/backup/coordinator.ts`: step orchestration, checkpoint drift persistence, consistency adapter enforcement, interrupted-step resume cleanup and final manifest consistency result.
- `src/core/checkpoint/backup.ts`: backup checkpoint schema including persisted `consistencyDriftDetected` state and resume integrity validation.
- `src/core/backup/database-consistency-adapter.ts`: database source snapshot/equality and database-owned cleanup.
- `src/core/backup/file-storage-consistency-adapter.ts`: File Storage catalog/object consistency plus shared database-artifact ownership boundary.
- `src/core/backup/management-consistency-adapters.ts`: project-state, control-plane, platform-v2, Auth and API-key consistency probes and scoped cleanup.
- `src/core/backup/edge-consistency-adapter.ts`: Edge function metadata/secret-digest consistency with deployed-body drift evidence retained in the capture path.
- `src/core/backup/vault-root-key-consistency-adapter.ts`: protected Vault root-key fingerprint consistency and scoped cleanup.
- `src/core/backup/specialized-storage-consistency-adapter.ts`: Vector/Analytics consistency fingerprints with logical vector identity normalization and explicit platform-limit semantics.
- `src/security/safe-remove.ts`: symlink-safe, bundle-root-confined cleanup primitive used by consistency retry/resume cleanup.
- `src/core/bundle/finalize.ts`: final bundle traversal/integrity and recognized atomic-writer partial cleanup/fail-closed transient-file handling.

Primary focused tests:

- `tests/unit/backup-consistency.test.ts`;
- `tests/unit/backup-consistency-snapshot-drift.test.ts`;
- `tests/unit/backup-consistency-result.test.ts`;
- `tests/unit/backup-coordinator-consistency.test.ts`;
- `tests/unit/backup-resume-partial-cleanup.test.ts`;
- `tests/unit/database-consistency-adapter.test.ts`;
- `tests/unit/file-storage-consistency-adapter.test.ts`;
- `tests/unit/management-consistency-adapters.test.ts`;
- `tests/unit/final-consistency-adapters.test.ts`;
- `tests/unit/product-consistency-wiring.test.ts`;
- `tests/unit/safe-remove.test.ts`;
- `tests/unit/bundle-finalize.test.ts`;
- `tests/unit/backup-cli.test.ts`.

Latest local full gate after this slice: **85 test files / 500 tests, `pnpm check` PASS**. Global coverage percentages must be refreshed separately with `pnpm test:coverage` before they are quoted as current post-slice evidence.

## Documentation

- `docs/00-overview.md`: product overview.
- `docs/01-product-requirements.md`: binding product requirements.
- `docs/02-coverage-matrix.md`: binding coverage matrix.
- `docs/03-architecture.md`: architecture target.
- `docs/04-backup-format.md`: bundle format.
- `docs/05-backup-engine.md`: backup-engine target behavior.
- `docs/06-restore-engine.md`: restore-engine target behavior plus current apply boundary.
- `docs/07-cli-and-ux.md`: current CLI surface and target UX contract.
- `docs/08-setup-user-guide.md`: current development-use guide and explicit unavailable release features.
- `docs/09-security-threat-model.md`: security/threat model.
- `docs/10-testing.md`: test strategy and hosted-E2E release gate.
- `docs/11-operations-reliability.md`: operations/reliability requirements.
- `docs/12-release-open-source.md`: public source/release policy.
- `docs/13-acceptance-criteria.md`: final done contract.
- `docs/14-implementation-plan.md`: target execution plan.
- `docs/15-source-of-truth.md`: platform source-of-truth/revalidation policy.
- `docs/16-troubleshooting.md`: troubleshooting, including verified/quiesced/best-effort operational guidance.
- `docs/17-compatibility.md`: current tested compatibility/evidence and pending compatibility gates.
- `docs/18-data-classification.md`: data classification/handling.
- `docs/19-error-model.md`: error model.
- `docs/20-target-repository-structure.md`: repository structure target.
- `docs/21-maintainer-runbook.md`: maintainer/release runbook.
- `docs/22-ci-release-workflows.md`: current CI workflows and remaining release-workflow requirements.
- `docs/23-current-status.md`: non-binding current implementation/evidence snapshot.

## Documentation semantics

The high-priority numbered product documents are requirements. They intentionally describe the required end state even when a feature is still blocked in the current CLI.

Current implementation truth must be reflected in all of:

- `PLANS.md`;
- `docs/23-current-status.md`;
- the development-status section of `README.md`;
- `HANDOFF.md`.

A release is not complete until the acceptance criteria and hosted E2E/parity gate pass.
