# 23 — Current implementation status

This document is a **status snapshot**, not a replacement for the binding product requirements. When it conflicts with a higher-priority specification, the specification wins and the difference is a remaining implementation task.

Snapshot date: **2026-08-15**  
Implementation checkpoint before this documentation reconciliation: **`be4df4e`** (`test: complete coverage threshold hardening`)

## Validation summary

Latest local validation:

- `pnpm check`: PASS;
- test files: **70 passed**;
- tests: **395 passed**;
- statements: **94.48%**;
- branches: **90.32%**;
- functions: **93.22%**;
- lines: **95.72%**.

Latest GitHub CI on the checkpoint is green for the regular CI workflow. The workflow covers quality gates, unit/contract tests, integration tests, security-focused tests, production dependency audit, and an OS/Node matrix covering Ubuntu, macOS and Windows with Node 22 and 24.

CodeQL currently reaches analysis/SARIF generation, but GitHub cannot publish the result because code scanning is not enabled/accessible for the repository integration. This is a repository configuration gate, not evidence that the static-analysis result is clean.

## Implemented repository slices

The implementation currently includes:

- strict TypeScript ESM, locked dependencies, build/lint/format/test tooling;
- stable domain errors, redaction and secret-value handling;
- 55-component data-driven coverage registry and final-result semantics;
- secure ordinary/protected artifact sinks;
- deterministic bundle finalization, SHA-256 verification, inspect/coverage/verify;
- deterministic `.tar.zst` packing and hostile archive protections;
- backup checkpoints, artifact revalidation and resume;
- restore plan/checkpoint/executor primitives and semantic verification;
- database logical dump, inventory, excluded managed/extension state, managed-schema diff and restore primitives;
- Auth, Cron, Queues, Vault, publications and Database Webhook coverage;
- File Storage catalog + streamed content-addressed object capture;
- specialized Vector and Analytics/Iceberg capability handling with explicit platform-limit semantics;
- Management API client, contract snapshots/runtime validation and control-plane adapters;
- Auth config/SSO/TPA/signing-key capture;
- modern/legacy API-key capture and target replacement/rotation semantics;
- Edge Function deployed-representation capture and secret inventory;
- Vault root-key capture and guarded restore handler;
- project/add-on/branch/health/advisor/database/service/network/domain/private-link/log-drain/JIT related control-plane coverage;
- CLI commands for `doctor`, `backup`, `inspect`, `coverage`, `verify`, restore dry-run, `--help` and `--version`;
- cross-platform GitHub CI and contract-drift workflow.

## Current user-facing runtime limits

These are deliberate fail-closed gates in the current CLI:

| Area | Current behavior | Required end state |
| --- | --- | --- |
| Backup consistency | only explicit `best-effort` is accepted | implement real `verified` and `quiesced` pre/post inventory, selective retry and bounded failure |
| Secret protection | plaintext protected artifacts require explicit `--allow-plaintext-secrets` | wire standard `age` encryption and keep plaintext opt-in only |
| Destination | local destination only | wire tested streaming/resumable S3-compatible publication and independent remote integrity verification |
| Restore | integrity-first dry-run plan is exposed; core executor/handlers exist | wire `--apply`, protected substitutions, resume and final semantic parity through the CLI |
| Hosted E2E | partial live observations exist | pass dedicated source → encrypted verified backup → offline verify → fresh target restore → semantic parity |
| CodeQL | analysis runs, result publication fails on repository configuration | enable code scanning/access and obtain a green/dispositioned result |
| Release | normal CI exists | add remaining live-E2E/release/SBOM/provenance/package-smoke gates |

## Current CLI surface

Implemented global options:

```text
--config <path>
--json
--version
--help
```

Implemented commands:

```text
pgdumpster doctor [--project-ref <ref>] [--json]
pgdumpster backup --project-ref <ref> (--linked|--db-url-env <name>) [options]
pgdumpster inspect <bundle-directory|archive.tar.zst> [--json]
pgdumpster coverage <bundle-directory|archive.tar.zst> [--json]
pgdumpster verify <bundle-directory|archive.tar.zst> [--json]
pgdumpster restore <bundle-directory|archive.tar.zst> --target-project-ref <ref> --target-db-url-env <name> (--dry-run|--apply)
```

`restore --apply` is parsed but currently fails closed with `RESTORE_APPLY_NOT_IMPLEMENTED`.

The current backup command accepts `verified|best-effort|quiesced` syntactically, but only `best-effort` proceeds; the other modes fail closed until the consistency engine is complete.

## Contract/live evidence

The repository contains dated official-contract snapshots and runtime validation for the Management API surfaces used by adapters. Several slices have dedicated live observations, including Edge behavior, but those observations are **not equivalent to the required full hosted E2E**.

No documentation should describe the full hosted source-to-target recovery gate as passed until the exact procedure in `docs/10-testing.md` succeeds.

## Remaining implementation order

The shortest safe path to the release gate is:

1. implement real `verified`/`quiesced` cross-service consistency and selective retry;
2. wire `age` encryption for protected backup output;
3. wire S3-compatible destination publication/recovery semantics;
4. wire the existing restore executor/handlers through `restore --apply` and finish parity reporting;
5. seed/reset the dedicated hosted source/target fixtures and run the full live E2E;
6. fix the GitHub CodeQL repository-setting blocker and disposition any findings;
7. complete SBOM/provenance/package smoke/release workflow and final documentation/acceptance audit.

## Definition of done

Coverage thresholds, mocked tests, individual live endpoint observations and green ordinary CI are necessary evidence but are not the final release gate.

The product is complete only when every applicable item in `docs/13-acceptance-criteria.md` is evidenced and the live hosted E2E/parity gate is green.
