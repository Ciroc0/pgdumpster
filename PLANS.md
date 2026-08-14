# pgDumpster execution plan

This is the implementation ledger required by `AGENTS.md`. A checked item means the named implementation/evidence exists; it does **not** mean the overall release gate has passed.

Last reconciled with repository state: **2026-08-15**.

## Objective

Build the production-ready pgDumpster CLI described by the binding repository specifications, without silent coverage gaps and without replacing live recovery evidence with mocks.

## Current milestone

**Release convergence — complete the remaining runtime gates and hosted recovery proof.**

The broad capture/restore architecture now exists. Remaining work is concentrated in verified cross-service consistency, encrypted output, S3 publication, CLI restore-apply/parity wiring, full hosted E2E and release/security hardening.

## Current evidence

At implementation checkpoint `be4df4e`:

- `pnpm check`: PASS;
- 70 test files / 395 tests: PASS;
- coverage: 94.48% statements / 90.32% branches / 93.22% functions / 95.72% lines;
- regular GitHub CI: PASS, including Ubuntu/macOS/Windows × Node 22/24 matrix;
- CodeQL: analysis executes, but result publication/status is blocked because repository code scanning is not enabled/accessible to the integration;
- full hosted source → encrypted verified backup → offline verify → clean-target restore → semantic-parity E2E: **PENDING**.

See `docs/23-current-status.md` for the concise operator-facing snapshot.

## Milestones

- [x] Read/reconcile the repository documentation, schemas, coverage registry, licensing and product identity.
- [x] Establish strict TypeScript ESM, Node support policy, locked dependencies, formatter, linter, build and tests.
- [x] Establish dated Supabase contract snapshots/runtime validation for implemented Management API adapters and fail-closed transport semantics.
- [x] Implement the 55-component coverage registry, manifest/error domains, redaction, safe paths, checksums, secure artifact sinks, inspect/coverage/offline verify and deterministic `.tar.zst` archive handling.
- [x] Implement authenticated platform preflight/doctor, Management API transport, runtime validation, retry/rate-limit behavior and project capability discovery.
- [x] Implement database logical dump/inventory plus Auth data, migrations, managed-schema customizations, extension state, Cron, Queues, Webhooks, Vault ciphertext and publication capture.
- [x] Implement File Storage catalog/object streaming with content-addressed paths, metadata capture, integrity checks, bounded concurrency and resume-safe primitives.
- [x] Implement Auth config/SSO/TPA/signing metadata, modern/legacy API keys, Edge Functions/secrets, Vault root-key capture and broad control-plane adapters.
- [x] Implement Vector/Analytics capability adapters with separate completeness semantics and explicit platform limits.
- [x] Implement backup coordinator/checkpoints/finalization and complete product backup orchestration across the registered components.
- [x] Implement restore plan, restore checkpoints, executor, database/control-plane/publication/Vault handlers and semantic verification primitives.
- [x] Raise meaningful global test coverage above the repository's 90% thresholds without lowering/excluding production code.
- [x] Run the regular GitHub quality/test/integration/security/OS-matrix workflow successfully on the current implementation checkpoint.
- [ ] Implement real `verified` and `quiesced` cross-service consistency: canonical pre/post inventories, selective retry, bounded stabilization and correct best-effort drift reporting.
- [ ] Wire standard `age` encryption into backup publication and verification; keep plaintext secret output behind explicit opt-in.
- [ ] Wire S3-compatible streaming/multipart publication, completion marker, remote integrity verification and interruption recovery.
- [ ] Wire the existing restore executor/handlers through CLI `restore --apply`, protected replacement-key output, resume and final semantic parity report.
- [ ] Complete the Management API simulator/stress/performance/release-evidence gaps required by `docs/10-testing.md` where not already covered by current tests.
- [ ] Enable/fix CodeQL result publication and disposition any actual high/critical findings.
- [ ] Complete SBOM/provenance/package smoke/release workflow and final source-of-truth revalidation.
- [ ] Run the dedicated live managed-Supabase source → encrypted `verified` backup → offline verify → clean-target restore → application smoke tests → semantic parity E2E.
- [ ] Perform the final `docs/13-acceptance-criteria.md` evidence audit and release only when every applicable item is satisfied.

## Current CLI truth

The CLI intentionally fails closed instead of pretending unfinished behavior works:

- S3 configuration → `DESTINATION_NOT_IMPLEMENTED`;
- `age` configuration → `ENCRYPTION_NOT_IMPLEMENTED`;
- backup consistency other than explicit `best-effort` → `CONSISTENCY_MODE_NOT_IMPLEMENTED`;
- `restore --apply` → `RESTORE_APPLY_NOT_IMPLEMENTED`.

Those guards are release blockers, not placeholders to remove without their underlying implementations.

## Decision log

### Product identity and license

- Brand: `pgDumpster`.
- Repository/package/CLI: `pgdumpster`.
- Domain: `pgdumpster.com`.
- Public source license: PolyForm Shield License 1.0.0; project is source-available, not OSI open source.
- Separate commercial licensing may be negotiated in writing.

### Contract evidence policy

Implement platform behavior from current official Supabase API/OpenAPI, CLI source/help and product documentation, with dedicated live observations where needed. Do not infer undocumented write semantics from GET success or training memory. Breaking response shapes fail closed.

### Completion semantics

The goal remains active until every applicable acceptance criterion, required CI/release gate and the hosted source-to-target recovery/parity test pass. Mock/local tests cannot replace the live gate.

### Database excluded state

The normal Supabase dump is supplemented by explicit inventory/capture for managed and extension-owned persistent state. Unknown persistent extension state fails closed rather than disappearing from coverage.

### File Storage addressing

Storage object keys never become local filesystem paths. Payloads are content-addressed and indexed by logical `(bucket,key)` metadata, preventing traversal/reserved-name/case-fold/Unicode path collisions.

### Vault root-key boundary

The root key is treated as a protected secret, registered with the central redactor and restored only through a guarded plan-first action before dependent encrypted state. Target Vault non-emptiness blocks replacement.

### Auth fidelity boundary

Complete runtime-validated responses are preserved where safe, but secrets/private signing material that the official API cannot guarantee as exactly exportable/importable are explicitly `not_exportable`. Metadata is never promoted to secret continuity.

### API-key restore boundary

Source modern API-key values can be captured when the official reveal contract exposes them. Target create semantics generate replacement values, so restore requires a protected source-to-target rotation map rather than false exact-equality claims.

### Edge deployed representation

The backed-up function body is the deployed representation returned by the platform, not a claim to recover the original Git repository. Function secret responses that expose digests are not misrepresented as original secret values.

### Realtime contract boundary

Current Realtime contract drift, including optional `postgres_changes_pool` and numeric writable settings, is runtime-validated. Nullable read fields are not guessed into unsupported PATCH values.

## Validation log

### 2026-08-14/15 — coverage hardening checkpoint

- Focused hardening batches expanded Management/client, artifact/bundle/database/restore/checkpoint/process/storage/config/Auth/control-plane/Vault/executor behavior.
- Final local result: 70 test files, 395 tests, all green.
- Global coverage: 94.48% statements, 90.32% branches, 93.22% functions, 95.72% lines.
- Repository 90% global thresholds: PASS.

### 2026-08-15 — CI checkpoint

- Regular `CI` workflow on `be4df4e`: PASS.
- Matrix includes Ubuntu, macOS and Windows with Node 22 and 24.
- CodeQL job performs extraction/analysis and generates SARIF, then fails as a configuration error because code scanning is not enabled/accessible for the repository integration. Do not treat that as either a clean CodeQL result or a code finding.

## Next implementation order

1. verified/quiesced consistency;
2. age encryption;
3. S3 destination;
4. restore `--apply` + parity wiring;
5. hosted E2E;
6. CodeQL/release/SBOM/provenance;
7. final acceptance audit.
