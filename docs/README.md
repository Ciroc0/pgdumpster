# Documentation guide

## Operating pgDumpster

Start with the repository [README](../README.md). It contains the normal encrypted backup and recovery sequence.

- [08 - User guide and setup](08-setup-user-guide.md): prerequisites, credentials, encryption, local/S3 backup input, resume, dry-run, and recovery workflow.
- [07 - CLI and UX reference](07-cli-and-ux.md): implemented commands, flags, configuration schema, JSON output, and exit codes.
- [16 - Troubleshooting](16-troubleshooting.md): error-specific recovery guidance.
- [17 - Compatibility](17-compatibility.md): supported runtime policy, tested environments, and platform fidelity boundaries.
- [23 - Current status](23-current-status.md): implementation/release evidence snapshot for a specific version; not a forward-looking feature promise.

## Understanding recovery boundaries

- [00 - Product overview](00-overview.md): scope, non-goals, and recovery model.
- [02 - Coverage matrix](02-coverage-matrix.md): what each registered component captures, restores, or reports as a limit.
- [04 - Backup bundle format](04-backup-format.md): artifact layout and integrity model.
- [06 - Restore engine](06-restore-engine.md): restore ordering, safety controls, and fidelity outcomes.
- [18 - Data classification](18-data-classification.md): handling of credentials and secret-bearing artifacts.
- [19 - Error model](19-error-model.md): structured failure categories and codes.

## Maintainer and contributor reference

- [01 - Product requirements](01-product-requirements.md), [03 - Architecture](03-architecture.md), [05 - Backup engine](05-backup-engine.md), [09 - Security threat model](09-security-threat-model.md), [10 - Testing](10-testing.md), and [11 - Operations and reliability](11-operations-reliability.md) define engineering constraints.
- [12 - Release and open source](12-release-open-source.md), [13 - Acceptance criteria](13-acceptance-criteria.md), [14 - Implementation plan](14-implementation-plan.md), [15 - Source of truth](15-source-of-truth.md), [20 - Target repository structure](20-target-repository-structure.md), [21 - Maintainer runbook](21-maintainer-runbook.md), and [22 - CI/release workflows](22-ci-release-workflows.md) are maintainer/reference material.

Documents that describe requirements, targets, or future work are not evidence that a CLI option exists. For executable syntax, use [07 - CLI and UX reference](07-cli-and-ux.md) and the installed command's `pgdumpster --help` output.
