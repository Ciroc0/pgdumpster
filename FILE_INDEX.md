# File index

This index describes the maintained pgDumpster repository documentation and policy surfaces. It is no longer a bootstrap-package QA snapshot.

Last reconciled with the implementation branch: **2026-08-15**.

## Core repository files

| File | Purpose |
| --- | --- |
| `.editorconfig` | Cross-editor text conventions |
| `.env.example` | Credential/environment template with no real secrets |
| `.github/ISSUE_TEMPLATE/*` | Issue templates/config |
| `.github/PULL_REQUEST_TEMPLATE.md` | Pull-request template |
| `.github/workflows/ci.yml` | Quality, test, integration, security and OS/Node CI |
| `.github/workflows/codeql.yml` | CodeQL analysis workflow; repository code-scanning setting is still a release gate |
| `.github/workflows/contract-drift.yml` | Official contract-drift validation |
| `.gitignore` | Secret/build/backup exclusions |
| `AGENTS.md` | Binding agent instructions and authority order |
| `CHANGELOG.md` | Release changelog |
| `CODE_OF_CONDUCT.md` | Conduct policy |
| `CONTRIBUTING.md` | Contribution workflow/invariants |
| `HANDOFF.md` | Current maintainer/agent handoff |
| `LICENSE` | PolyForm Shield License 1.0.0 verbatim |
| `NOTICE` | Required notices/protected line of business |
| `LICENSING.md` | Public-source/commercial licensing explanation |
| `PLANS.md` | Current implementation ledger |
| `README.md` | Project/operator entry point |
| `SECURITY.md` | Security disclosure policy |
| `SUPPORT.md` | Support and safe diagnostic guidance |
| `package.json` / `pnpm-lock.yaml` | Package/runtime/dependency contract |
| `spec/coverage-registry.yaml` | Canonical 55-component coverage registry |
| `schemas/*.json` | Bundle manifest/coverage schemas |
| `contracts/*` | Dated official-platform contract snapshots |
| `src/*` | CLI and implementation |
| `tests/*` | Unit/integration/hardening tests |

## Documentation

| File | Purpose |
| --- | --- |
| `docs/00-overview.md` | Product overview |
| `docs/01-product-requirements.md` | Binding product requirements |
| `docs/02-coverage-matrix.md` | Binding coverage matrix |
| `docs/03-architecture.md` | Architecture target |
| `docs/04-backup-format.md` | Bundle format |
| `docs/05-backup-engine.md` | Backup-engine target behavior |
| `docs/06-restore-engine.md` | Restore-engine target behavior plus current apply boundary |
| `docs/07-cli-and-ux.md` | Current CLI surface and target UX contract |
| `docs/08-setup-user-guide.md` | Current development-use guide and explicit unavailable release features |
| `docs/09-security-threat-model.md` | Security/threat model |
| `docs/10-testing.md` | Test strategy and hosted-E2E release gate |
| `docs/11-operations-reliability.md` | Operations/reliability requirements |
| `docs/12-release-open-source.md` | Public source/release policy |
| `docs/13-acceptance-criteria.md` | Final done contract |
| `docs/14-implementation-plan.md` | Target execution plan |
| `docs/15-source-of-truth.md` | Platform source-of-truth/revalidation policy |
| `docs/16-troubleshooting.md` | Troubleshooting |
| `docs/17-compatibility.md` | Current tested compatibility/evidence and pending compatibility gates |
| `docs/18-data-classification.md` | Data classification/handling |
| `docs/19-error-model.md` | Error model |
| `docs/20-target-repository-structure.md` | Repository structure target |
| `docs/21-maintainer-runbook.md` | Maintainer/release runbook |
| `docs/22-ci-release-workflows.md` | Current CI workflows and remaining release-workflow requirements |
| `docs/23-current-status.md` | Non-binding current implementation/evidence snapshot |

## Documentation semantics

The high-priority numbered product documents are requirements. They intentionally describe the required end state even when a feature is still blocked in the current CLI.

Current implementation truth must be reflected in all of:

- `PLANS.md`;
- `docs/23-current-status.md`;
- the development-status section of `README.md`;
- `HANDOFF.md`.

A release is not complete until the acceptance criteria and hosted E2E/parity gate pass.
