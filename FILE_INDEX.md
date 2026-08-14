# File index

This index describes the complete Codex handoff package.

Generated QA snapshot: 2026-08-13T21:03:33.792837+00:00

## Core files

| File                                         | Purpose                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.editorconfig`                              | Cross-editor text conventions                                                         |
| `.env.example`                               | Credential/environment variable template with no real secrets                         |
| `.github/ISSUE_TEMPLATE/bug_report.yml`      | GitHub issue template/config                                                          |
| `.github/ISSUE_TEMPLATE/config.yml`          | GitHub issue template/config                                                          |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | GitHub issue template/config                                                          |
| `.github/PULL_REQUEST_TEMPLATE.md`           | GitHub repository workflow/template specification                                     |
| `.gitignore`                                 | Secret/build/backup exclusions                                                        |
| `AGENTS.md`                                  | Binding Codex/agent repository instructions and authority order                       |
| `CHANGELOG.md`                               | Release changelog                                                                     |
| `CODE_OF_CONDUCT.md`                         | Project conduct policy                                                                |
| `CODEX_GOAL.md`                              | Human-readable Codex /goal wrapper                                                    |
| `CODEX_GOAL.txt`                             | Raw Codex /goal text                                                                  |
| `CONTRIBUTING.md`                            | Contributor workflow and invariants                                                   |
| `docs/00-overview.md`                        | 00 — Product overview                                                                 |
| `docs/01-product-requirements.md`            | 01 — Product requirements                                                             |
| `docs/02-coverage-matrix.md`                 | 02 — Coverage matrix                                                                  |
| `docs/03-architecture.md`                    | 03 — Architecture                                                                     |
| `docs/04-backup-format.md`                   | 04 — Backup bundle format                                                             |
| `docs/05-backup-engine.md`                   | Backup engine                                                                         |
| `docs/06-restore-engine.md`                  | Restore engine                                                                        |
| `docs/07-cli-and-ux.md`                      | CLI and UX specification                                                              |
| `docs/08-setup-user-guide.md`                | User guide and setup                                                                  |
| `docs/09-security-threat-model.md`           | Security and threat model                                                             |
| `docs/10-testing.md`                         | Test strategy                                                                         |
| `docs/11-operations-reliability.md`          | Operations and reliability                                                            |
| `docs/12-release-open-source.md`             | Release and public source repository standard                                         |
| `docs/13-acceptance-criteria.md`             | Product acceptance criteria                                                           |
| `docs/14-implementation-plan.md`             | Implementation plan                                                                   |
| `docs/15-source-of-truth.md`                 | Source of truth and platform revalidation                                             |
| `docs/16-troubleshooting.md`                 | Troubleshooting                                                                       |
| `docs/17-compatibility.md`                   | Compatibility policy                                                                  |
| `docs/18-data-classification.md`             | Data classification and handling                                                      |
| `docs/19-error-model.md`                     | Error model                                                                           |
| `docs/20-target-repository-structure.md`     | 20 — Target repository structure                                                      |
| `docs/21-maintainer-runbook.md`              | 21 — Maintainer and release runbook                                                   |
| `docs/22-ci-release-workflows.md`            | 22 — CI and release workflow specification                                            |
| `examples/backup.config.example.yaml`        | Backup configuration example                                                          |
| `examples/coverage.example.json`             | Example coverage report                                                               |
| `examples/github-actions.example.yml`        | Safe intentionally non-runnable CI scheduling template until real package publication |
| `examples/manifest.example.json`             | Example manifest                                                                      |
| `examples/restore-result.example.json`       | Example restore/parity result                                                         |
| `HANDOFF.md`                                 | Exact handoff instructions for Codex                                                  |
| `LICENSE`                                    | PolyForm Shield License 1.0.0, reproduced verbatim                                    |
| `NOTICE`                                     | Required PolyForm notices and protected line of business                              |
| `LICENSING.md`                               | Public source and separate commercial licensing explanation                           |
| `PLANS.md`                                   | Execution-plan contract Codex must maintain                                           |
| `README.md`                                  | Project overview and operator entry point                                             |
| `schemas/coverage.schema.json`               | Coverage report JSON Schema                                                           |
| `schemas/manifest.schema.json`               | Backup manifest JSON Schema                                                           |
| `SECURITY.md`                                | Security disclosure policy                                                            |
| `spec/coverage-registry.yaml`                | Canonical machine-oriented full-project coverage registry                             |
| `SUPPORT.md`                                 | Support and safe diagnostic guidance                                                  |

## QA snapshot

- Files before this index: 51
- Canonical coverage components: 55
- Coverage registry ↔ coverage matrix mismatch: none
- Codex `/goal` length: 2917 characters
- Markdown fence problems: 0
- Broken internal Markdown links: 0
- Heuristic credential hits: 0
- Manifest/coverage example schema checks: examples/manifest.example.json=PASS, examples/coverage.example.json=PASS

The remaining explicit `TBD`/replacement markers in release/security documentation are intentional release gates: Codex must replace them with values verified by the actual implementation, CI environment, package name and private security contact. They must not survive the first public release.
