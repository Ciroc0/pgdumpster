# 23 — Current implementation status

This document is a **status snapshot**, not a replacement for the binding product requirements. When it conflicts with a higher-priority specification, the specification wins and the difference is a remaining implementation task.

Snapshot date: **2026-08-15**.

## Validation summary

Latest complete local validation after the consistency/resume hardening slice:

- `pnpm check`: **PASS**;
- test files: **85 passed**;
- tests: **500 passed**.

The most recent recorded global coverage percentages predate this slice:

- statements: **94.48%**;
- branches: **90.32%**;
- functions: **93.22%**;
- lines: **95.72%**.

Those percentages were green against the repository's independent 90% thresholds, but `pnpm test:coverage` must be rerun after this slice before they are treated as current coverage evidence.

GitHub Actions quota is currently exhausted for the account, so newly pushed workflow runs are expected to be blocked by quota until reset. That is not a meaningful remote quality signal for the current branch; local `pnpm check` is the active gate in the meantime. Earlier regular CI passed its quality/test/integration/security and Ubuntu/macOS/Windows Node 22/24 matrix checkpoint.

CodeQL previously reached analysis/SARIF generation, but GitHub could not publish the result because code scanning was not enabled/accessible to the repository integration. This remains a repository configuration gate, not evidence that the static-analysis result is clean.

## Implemented repository slices

The implementation currently includes:

- strict TypeScript ESM, locked dependencies, build/lint/format/test tooling;
- stable domain errors, redaction and secret-value handling;
- 55-component data-driven coverage registry and final-result semantics;
- secure ordinary/protected artifact sinks;
- deterministic bundle finalization, SHA-256 verification, inspect/coverage/verify;
- deterministic `.tar.zst` packing and hostile archive protections;
- backup checkpoints, artifact revalidation and resume;
- cross-service consistency orchestration for all 10 product backup steps;
- canonical source snapshots plus adapter-specific equality where volatile source evidence must be excluded;
- verified bounded retry after safe provisional/partial cleanup;
- quiesced fail-fast behavior on observable source drift;
- best-effort drift detection with final `drift_detected` reporting and checkpoint/resume preservation;
- copy-time drift promotion for Storage/Edge/specialized surfaces in addition to pre/post snapshot comparison;
- hard-interruption cleanup of non-completed step-owned artifacts before resume;
- symlink-safe cleanup and fail-closed scope validation;
- finalization handling for recognized UUID-based atomic-writer partials while rejecting unrecognized transient-looking files;
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

These are the remaining deliberate fail-closed gates in the current CLI:

- **Backup consistency**: `verified`, `best-effort` and `quiesced` are implemented. Backup defaults to `verified`. This is an application-level stabilization contract across the source surfaces pgDumpster can observe; it is not a claim that Supabase exposes one atomic cross-service snapshot transaction.
- **Secret protection**: plaintext protected artifacts require explicit `--allow-plaintext-secrets`. Standard `age` encryption still needs to be wired.
- **Destination**: only local destination is exposed. Streaming/resumable S3-compatible publication and independent remote integrity verification remain unimplemented.
- **Restore**: integrity-first dry-run planning is exposed and the core executor/handlers exist. CLI `--apply`, protected substitutions, resume and final semantic parity still need to be wired end-to-end.
- **Hosted E2E**: partial live observations exist, but the dedicated source → encrypted verified backup → offline verify → fresh-target restore → semantic parity procedure has not passed yet.
- **CodeQL**: analysis has run, but result publication remains blocked on repository configuration/access. Any eventual findings must still be dispositioned.
- **Release**: normal CI exists. Remaining coverage refresh, live-E2E, SBOM, provenance, package-smoke and final release gates are still required.

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

Backup consistency accepts `verified|best-effort|quiesced`; omitted consistency defaults to `verified`. Best-effort output distinguishes `best_effort` from `drift_detected`.

`restore --apply` is parsed but currently fails closed with `RESTORE_APPLY_NOT_IMPLEMENTED`.

## Consistency implementation boundary

All 10 product backup steps have concrete consistency adapters and partial-cleanup wiring:

1. database;
2. project-state;
3. control-plane;
4. platform-v2;
5. auth;
6. api-keys;
7. edge;
8. vault-root-key;
9. file-storage;
10. specialized-storage.

The coordinator requires complete adapters and partial-cleanup support for verified/quiesced execution. Verified mode can retry a drifting step within the configured bound only after provisional state is safely removed. Quiesced mode fails on observable drift. Best-effort completes a valid copy without retrying for pre/post mismatch but records detected drift instead of claiming verification.

Some source APIs only provide observable fingerprints rather than a transactional snapshot primitive. The guarantee is therefore bounded by the strongest stable evidence each official source surface exposes.

## Contract/live evidence

The repository contains dated official-contract snapshots and runtime validation for the Management API surfaces used by adapters. Several slices have dedicated live observations, including Edge behavior, but those observations are **not equivalent to the required full hosted E2E**.

No documentation should describe the full hosted source-to-target recovery gate as passed until the exact procedure in `docs/10-testing.md` succeeds.

## Remaining implementation order

The shortest safe path to the release gate is:

1. refresh current global coverage evidence with `pnpm test:coverage`;
2. wire standard `age` encryption for protected backup output;
3. wire S3-compatible destination publication/recovery semantics;
4. wire the existing restore executor/handlers through `restore --apply` and finish protected substitutions/parity reporting;
5. seed/reset the dedicated hosted source/target fixtures and run the full live E2E;
6. fix the GitHub CodeQL repository-setting blocker and disposition any findings;
7. complete SBOM/provenance/package smoke/release workflow and final documentation/acceptance audit.

## Definition of done

Coverage thresholds, local tests, individual live endpoint observations and green ordinary CI are necessary evidence but are not the final release gate.

The product is complete only when every applicable item in `docs/13-acceptance-criteria.md` is evidenced and the live hosted E2E/parity gate is green.
