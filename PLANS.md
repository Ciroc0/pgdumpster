# pgDumpster execution plan

This is the implementation ledger required by `AGENTS.md`. A checked item means the named implementation/evidence exists; it does **not** mean the overall release gate has passed.

Last reconciled with repository state: **2026-08-15**.

## Objective

Build the production-ready pgDumpster CLI described by the binding repository specifications, without silent coverage gaps and without replacing live recovery evidence with mocks.

## Current milestone

**Release convergence — encrypted publication, restore apply/parity, hosted recovery proof and release hardening.**

The broad capture/restore architecture and the cross-service consistency layer now exist. Remaining work is concentrated in standard `age` encryption, S3 publication, CLI restore-apply/parity wiring, full hosted E2E and release/security hardening.

## Current evidence

Latest complete local gate on 2026-08-15 after the consistency/resume hardening slice:

- `pnpm check`: **PASS**;
- **85 test files / 500 tests: PASS**;
- all 10 product backup steps have concrete consistency adapters and partial-cleanup wiring;
- default `verified`, explicit `quiesced`, and `best-effort` consistency are accepted by the backup CLI;
- best-effort drift is preserved as `drift_detected`, including across resume;
- verified/quiesced drift handling is covered at pre-snapshot, copy and post-snapshot phases;
- interrupted-step resume cleanup and symlink-safe cleanup are covered;
- atomic writer `.partial-<uuid>` leftovers are fail-safe during finalization.

The most recent recorded global coverage percentages predate this slice: 94.48% statements / 90.32% branches / 93.22% functions / 95.72% lines. Run `pnpm test:coverage` again before treating those percentages as current evidence.

GitHub Actions quota is currently exhausted for this account, so remote CI cannot provide a meaningful new branch signal until the quota resets. Local `pnpm check` remains the active quality gate during that period. The earlier regular CI matrix passed on its validated checkpoint. CodeQL analysis previously reached SARIF generation, but result publication/status remained blocked by repository code-scanning configuration.

The full hosted source → encrypted verified backup → offline verify → clean-target restore → semantic-parity E2E remains **PENDING**.

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
- [x] Run the regular GitHub quality/test/integration/security/OS-matrix workflow successfully on the earlier validated implementation checkpoint.
- [x] Implement real `verified`, `best-effort` and `quiesced` cross-service consistency with concrete adapters for every product step, canonical source snapshots, copy-time drift detection, bounded verified retry, quiesced fail-fast semantics, safe provisional/partial cleanup, resume preservation and manifest drift reporting.
- [ ] Re-run global coverage after the completed consistency slice and keep all configured thresholds green.
- [ ] Wire standard `age` encryption into backup publication and verification; keep plaintext secret output behind explicit opt-in.
- [ ] Wire S3-compatible streaming/multipart publication, completion marker, remote integrity verification and interruption recovery.
- [ ] Wire the existing restore executor/handlers through CLI `restore --apply`, protected replacement-key output, resume and final semantic parity report.
- [ ] Complete the Management API simulator/stress/performance/release-evidence gaps required by `docs/10-testing.md` where not already covered by current tests.
- [ ] Enable/fix CodeQL result publication and disposition any actual high/critical findings.
- [ ] Complete SBOM/provenance/package smoke/release workflow and final source-of-truth revalidation.
- [ ] Run the dedicated live managed-Supabase source → encrypted `verified` backup → offline verify → clean-target restore → application smoke tests → semantic parity E2E.
- [ ] Perform the final `docs/13-acceptance-criteria.md` evidence audit and release only when every applicable item is satisfied.

## Current CLI truth

The CLI continues to fail closed for unfinished release behavior:

- backup consistency defaults to `verified`; `verified`, `best-effort` and `quiesced` are all implemented through the product consistency layer;
- S3 configuration → `DESTINATION_NOT_IMPLEMENTED`;
- `age` configuration → `ENCRYPTION_NOT_IMPLEMENTED`;
- secret-bearing plaintext backup still requires explicit `--allow-plaintext-secrets`;
- `restore --apply` → `RESTORE_APPLY_NOT_IMPLEMENTED`.

The remaining guards are release blockers, not placeholders to remove without their underlying implementations.

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

### Consistency boundary

`verified` means every product backup step participates in the consistency contract. Mutable source state is observed before/after copy where supported, copy-time drift signals are promoted into the same policy, verified mode retries only after safe cleanup, quiesced mode fails on observable drift, and best-effort records detected drift without falsely reporting verification. Resume cleans interrupted step-owned partial artifacts before rerun and preserves earlier best-effort drift evidence.

This is still an application-level cross-service stabilization contract, not a claim that Supabase exposes one atomic transaction spanning PostgreSQL, Management APIs, Storage, Edge and every managed service.

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
- Local result at that checkpoint: 70 test files, 395 tests, all green.
- Global coverage at that checkpoint: 94.48% statements, 90.32% branches, 93.22% functions, 95.72% lines.
- Repository 90% global thresholds: PASS.

### 2026-08-15 — consistency and resume hardening checkpoint

- Concrete consistency adapters cover all 10 product backup steps.
- Drift handling covers pre-snapshot, copy-time and post-snapshot observations.
- Verified mode performs bounded retry only after safe provisional/partial cleanup; quiesced mode fails on observable drift; best-effort persists `drift_detected` through checkpoint/resume.
- Hard-interruption resume cleanup is step-scoped and symlink-safe.
- Bundle finalization removes only recognized UUID writer partials and still rejects unrecognized transient-looking files.
- CLI consistency guard removed; default `verified`, explicit `quiesced` and `best-effort` now flow to product execution.
- CLI exit-code mapping includes consistency → 6, source-component failures → 5 and destination/I/O → 8.
- Final local `pnpm check`: **85 test files / 500 tests, PASS**.

### GitHub CI / CodeQL note

The earlier regular CI matrix passed on its validated checkpoint. Current Actions quota is exhausted, so newly pushed commits are expected to be blocked by quota until reset and should not be interpreted as code-quality failures. CodeQL publication remains a separate repository-configuration gate.

## Next implementation order

1. refresh global coverage evidence for the completed consistency slice;
2. `age` encryption;
3. S3 destination;
4. restore `--apply` + parity wiring;
5. hosted E2E;
6. CodeQL/release/SBOM/provenance;
7. final acceptance audit.
