# pgDumpster execution plan

This is the implementation ledger required by `AGENTS.md`. A checked item means the named implementation/evidence exists; it does **not** mean the overall release gate has passed.

Last reconciled with repository state: **2026-08-16**.

## Objective

Build the production-ready pgDumpster CLI described by the binding repository specifications, without silent coverage gaps and without replacing live recovery evidence with mocks.

## Current milestone

**Release convergence — encrypted publication, restore apply/parity, hosted recovery proof and release hardening.**

The broad capture/restore architecture, cross-service consistency layer, standard local `age` encryption and S3-compatible publication path now exist. Remaining work is concentrated in final release/security hardening.

## Current evidence

Latest complete local gates on 2026-08-16 after live-restore regression hardening:

- `pnpm check`: **PASS**;
- **116 test files / 728 tests: PASS**;
- global coverage: **94.61% statements / 90.04% branches / 92.55% functions / 95.65% lines**;
- all independent 90% global thresholds: **PASS**;
- the disposable hosted fixture completed encrypted backup, offline verification, clean-target restore and database/File Storage semantic checks with explicit platform limits; the private Storage bucket/object was restored and directly verified on target; Cloudflare R2 S3 publication, completion-marker, materialization and offline verification passed;
- the current candidate's local live-E2E harness completed the same encrypted source-to-clean-target sequence after the managed-schema `pg-delta` repair: backup/verify/restore/parity reached their expected terminal states, all 55 coverage components were terminal, and database, direct Storage byte-hash plus restored Auth password-login smokes matched; the protected GitHub Environment execution remains separate release evidence;
- current official Supabase/OpenAPI, Storage and changelog contract snapshots: **MATCH**;
- a consumer install of the generated `pgdumpster-0.0.0-development.tgz` passed `--version`, `doctor --help` and `restore --help`; this is local package smoke evidence only, not a public publish/release claim;
- current `npm pack --dry-run --json` package audit reports 364 files, includes the compiled CLI/contracts/schemas, contains no development-only test/docs/scripts/workflow paths and remains `private: true`; this is package-content evidence only, not a release claim;
- all 10 product backup steps have concrete consistency adapters and partial-cleanup wiring;
- default `verified`, explicit `quiesced`, and `best-effort` consistency are accepted by the backup CLI;
- best-effort drift is preserved as `drift_detected`, including across resume;
- verified/quiesced drift handling is covered at pre-snapshot, copy and post-snapshot phases;
- interrupted-step resume cleanup and symlink-safe cleanup are covered;
- atomic writer `.partial-<uuid>` leftovers are fail-safe during finalization;
- standard `age` encryption/decryption is implemented through a shell-free subprocess wrapper;
- encrypted backup publication produces `.tar.zst.age` and cleans normal plaintext archive/workspace output;
- inspect/coverage/verify and restore dry-run accept `.tar.zst.age` with a configured identity-file reference;
- Windows encrypted-output publication behavior is covered by the local test suite.

GitHub Actions quota is currently exhausted for this account, so remote CI cannot provide a meaningful new branch signal until the quota resets. Local `pnpm check` and `pnpm test:coverage` remain the active quality gates during that period. The earlier regular CI matrix passed on its validated checkpoint. CodeQL analysis previously reached SARIF generation, but result publication/status remained blocked by repository code-scanning configuration.

The disposable hosted source → encrypted verified backup → offline verify →
clean-target restore → semantic-parity observation is **PASS with explicit
platform limits**: the source and target fixture are both presently readable
and contain the expected two `pgdumpster_e2e.jobs` rows. It proves the
implemented database/File Storage/control-plane paths, not a release-candidate
CI execution or automatic fidelity for components the platform cannot export or
import exactly.

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
- [x] Re-run global coverage after the completed consistency slice and keep all configured thresholds green.
- [x] Wire standard `age` encryption into local backup publication and verified bundle input; keep plaintext secret output behind explicit opt-in.
- [x] Implement S3-compatible streaming/multipart publication, completion marker, remote integrity verification and interruption recovery with local fault-injection coverage.
- [x] Run S3-provider interoperability validation against a scoped Cloudflare R2 bucket.
- [x] Complete CLI `restore --apply`: executable plans assemble handlers against the verified bundle root, validate handler completeness and all action materials before checkpoint/mutation, derive target database/Management/privileged-Storage credentials from planned capabilities, and bind resume to an immutable prior plan. Auth config/SSO/TPA plus modern/legacy API-key state use current validated contracts. Modern keys create replacements and atomically write a `0600` protected rotation map; Auth SSO/TPA use exact semantic verification; default `fail` performs no mutation on target conflict and explicit `replace` is limited to documented scoped replacement operations. Unsupported automatic components remain explicit platform/manual limits and blocked plans fail before mutation. Disposable hosted database/File Storage semantic-parity observations exist; the protected release-candidate E2E remains a separate evidence gate.
- [ ] Complete the remaining provider-scale/performance and release-evidence gaps required by `docs/10-testing.md`; the deterministic Management API simulator, 10k small-object orchestration, 100k inventory, bounded 32 MiB object streaming and 64 MiB database-dump streaming regressions are complete.
- [ ] Enable/fix CodeQL result publication and disposition any actual high/critical findings.
- [ ] Execute the implemented SBOM/provenance/package-smoke/release workflow for a valid candidate, then complete final source-of-truth revalidation.
- [ ] Run the already locally passing current-candidate hosted E2E through its protected GitHub Environment with application smoke for every automatically restorable configured component. The database/File Storage/Auth/control-plane observation is complete; Vault ciphertext, Edge secret plaintext and private Auth signing material remain documented manual/platform limits.
- [x] Add a protected `workflow_dispatch` hosted-E2E harness which validates distinct source/target pooler bindings, rejects a target containing a dedicated database, Storage or Auth fixture, seeds deterministic database and Auth fixtures, requires a passing source `doctor`, runs encrypted verified backup/offline verify/terminal-coverage/dry-run/apply, validates the parity report and compares post-restore database, direct stream-hashed File Storage and Auth password-login smoke state. It emits only a sanitized terminal summary and removes temporary config, bundle, age identity and new UUID-named restore artifacts without touching existing local restore files. Execution against a protected Environment remains separate evidence.
- [ ] Perform the final `docs/13-acceptance-criteria.md` evidence audit and release only when every applicable item is satisfied.

## Current CLI truth

The CLI continues to fail closed for unfinished release behavior:

- backup consistency defaults to `verified`; `verified`, `best-effort` and `quiesced` are all implemented through the product consistency layer;
- standard local `age` encryption is implemented: `encryption.mode: age` requires `encryption.recipient`, outputs `.tar.zst.age`, and encrypted input uses configured `encryption.identityFile`;
- non-encrypted secret-bearing backup still requires explicit `--allow-plaintext-secrets`;
- configured S3 destination → resumable multipart publication, remote byte/SHA-256 verification and an observable completion marker written last; Cloudflare R2 interoperability is live-validated.
- `restore --apply` → `RESTORE_ADAPTER_MISSING` when any planned component lacks a concrete handler; this is intentionally pre-mutation. The remaining unsupported automatic components must receive documented handlers or explicit platform/manual classifications before a full plan can execute.
- `restore --apply` → `RESTORE_PLAN_BLOCKED` before reading target credentials or calling target APIs when backup/source/policy constraints make the plan non-executable.

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

### Encryption boundary

Standard `age` is the implemented encrypted local transport/storage wrapper.

- The canonical working form remains the directory bundle.
- Encrypted publication first creates the deterministic `.tar.zst` form and wraps it as `.tar.zst.age`.
- Normal successful encrypted publication removes the plaintext archive and directory workspace.
- Missing `age` tooling is represented as a dependency failure; `doctor` also probes `age --version`.
- Decryption accepts an identity-file path reference, not private-key contents through normal CLI arguments.
- A hard process kill may leave the protected resumable workspace/checkpoint; crash recovery is not falsely represented as an always-zero-plaintext-at-rest guarantee during execution.

### Database excluded state

The normal Supabase dump is supplemented by explicit inventory/capture for managed and extension-owned persistent state. Unknown persistent extension state fails closed rather than disappearing from coverage.

### File Storage addressing

Storage object keys never become local filesystem paths. Payloads are content-addressed and indexed by logical `(bucket,key)` metadata, preventing traversal/reserved-name/case-fold/Unicode path collisions.

### Vault root-key boundary

The root key is treated as a protected secret, registered with the central redactor and restored only through a guarded plan-first action before dependent encrypted state. Target Vault non-emptiness blocks replacement.

The ordinary logical target role cannot insert captured `vault.secrets`
ciphertext. Consequently root-key continuity is automatically verified, while
target decryption of copied Vault ciphertext requires a Supabase physical
restore/clone flow or explicit secret recreation with ID mapping. This is an
explicit manual fidelity boundary, not a pending automatic restore feature.

### Auth fidelity boundary

Complete runtime-validated responses are preserved where safe, but secrets/private signing material that the official API cannot guarantee as exactly exportable/importable are explicitly `not_exportable`. Metadata is never promoted to secret continuity.

### API-key restore boundary

Source modern API-key values can be captured when the official reveal contract exposes them. Target create semantics generate replacement values, so restore requires a protected source-to-target rotation map rather than false exact-equality claims.

### Edge deployed representation

The backed-up function body is the deployed representation returned by the platform, not a claim to recover the original Git repository. Function secret responses that expose digests are not misrepresented as original secret values.

### Realtime contract boundary

Current Realtime contract drift, including optional `postgres_changes_pool` and numeric writable settings, is runtime-validated. Nullable read fields are not guessed into unsupported PATCH values.

## Validation log

### 2026-08-16 — bounded large Storage stream regression

- Added a 32 MiB Storage download fixture which creates and emits only 64 KiB chunks, then verifies byte count, digest and persisted artifact. It exercises the production stream → hash → file pipeline without constructing the full payload in the test or the download path.
- Local validation: focused Storage stream tests **5 tests, PASS**; `pnpm test:coverage`: **115 test files / 724 tests, PASS**. Global coverage: **94.61% statements / 90.04% branches / 92.55% functions / 95.65% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — Storage inventory scale regression

- Added a deterministic 100,000-object Storage catalog inventory regression that verifies catalog normalization and canonical ordering without live data.
- Local validation: focused Storage catalog tests **4 tests, PASS**; `pnpm test:coverage`: **115 test files / 723 tests, PASS**. Global coverage: **94.61% statements / 90.04% branches / 92.55% functions / 95.65% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — deterministic Management API fault simulator

- Added an in-process queued Management API simulator that deterministically models latency, connection resets, 429 retry headers, changing paginated/eventually-consistent responses, mutation between snapshots, secret-bearing fixture bodies and stale ETag headers. The test asserts transport sequencing without any live API dependency.
- Local validation: focused simulator tests **2 tests, PASS**; `pnpm test:coverage`: **115 test files / 722 tests, PASS**. Global coverage: **94.63% statements / 90.07% branches / 92.55% functions / 95.65% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — explicit non-interactive CLI contract

- Added global `--non-interactive` parsing with duplicate rejection. The CLI remains prompt-free and this flag does not bypass mandatory restore `--apply` behavior.
- Local validation: focused CLI-help regression **8 tests, PASS**; `pnpm check`: **PASS**; `pnpm test:coverage`: **114 test files / 720 tests, PASS**. Global coverage: **94.61% statements / 90.04% branches / 92.55% functions / 95.65% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — command-help release smoke repair

- Fixed `pgdumpster <command> --help` so it returns usage and exits successfully before configuration or credential loading. Previously, `pgdumpster doctor --help` incorrectly reached doctor argument parsing and reported `INTERNAL_INVARIANT_VIOLATION`.
- Added a regression covering `doctor`, `backup`, `inspect`, `coverage`, `verify` and `restore` command help. The built CLI smoke test now passes for `doctor --help` and `backup --help`.
- Local validation: **114 test files / 716 tests, PASS**. Global coverage: **94.66% statements / 90.11% branches / 92.50% functions / 95.68% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — live-restore regression hardening

- A hosted encrypted backup and offline verification completed against a dedicated test source. An apply run on a disposable target exposed two fail-closed defects before a complete E2E claim: source `legacy` API keys were incorrectly rejected, and a resume invocation could rebuild and overwrite the immutable plan before checkpoint verification.
- Legacy keys now map only to the target's already-generated matching legacy identity and are never posted. Resume now reads the bounded persisted plan beside the checkpoint, validates its hash and source/target/policy bindings, and never rewrites that record.
- The target run remains partial evidence only; it is not semantic-parity proof. A fresh target rerun is required.
- Local validation: **114 test files / 718 tests, PASS**. Global coverage: **94.62% statements / 90.05% branches / 92.52% functions / 95.65% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — hosted encrypted restore and parity observation

- On separate disposable managed-Supabase projects, an encrypted `verified` backup completed with 44 files and offline verification passed. Restore onto a clean target completed as `restored_with_platform_limits`; all 16 planned mutations were verified, with six documented non-exportable/manual platform limits.
- Database semantic checks matched source and target for the fixture's account/job counts, enum, RLS policies, trigger behavior/checksums and Realtime publication. This is a real hosted source-to-target recovery observation, including resume recovery after an intentional live failure.
- The fixture had no File Storage bucket/object and no external S3-compatible destination. Therefore Storage streaming/provider interoperability and the final fully applicable hosted E2E remain pending.

### 2026-08-16 — hosted File Storage restore observation

- A private source bucket containing one 38-byte marker object was captured in a second encrypted, offline-verified 45-file archive. Restore onto a fresh target completed with Storage service configuration, bucket, object and metadata actions all verified.
- Direct target Storage API verification found the private bucket and exactly one restored `fixtures/marker.txt` object at 38 bytes. This closes the managed-Storage streaming E2E evidence; a separate external S3-compatible provider remains untested.

### 2026-08-16 — S3 capability/status reconciliation

- Audited the current S3 adapter, configured bundle input and CLI/output wiring against the release acceptance criteria. The implementation performs bounded multipart upload, persists protected upload state, resumes committed parts, recovers a fully uploaded object when only its marker is missing, verifies remote metadata plus streamed bytes, then conditionally writes and rereads `COMPLETE.json` last.
- Focused local evidence: **7 test files / 40 tests, PASS**, including cancellation, malformed/out-of-scope locator, marker, overwrite, missing response identity, multipart-conflict and vanished-upload cases.
- `PLANS.md` previously incorrectly described configured S3 as `DESTINATION_NOT_IMPLEMENTED`; it is now explicitly classified as implemented but missing real-provider interoperability evidence.

### 2026-08-16 — immutable restore-plan evidence

- `restore --apply` now atomically writes the runtime-validated immutable plan as a `0600` record beside the checkpoint before executor mutation. Machine and human results return that path together with checkpoint and parity-report paths.
- CLI regression validates the persisted plan identity and verifies that database and Management secrets are absent from both plan and parity records. Focused local validation: **2 test files / 13 tests, PASS**; `tsc --noEmit`: **PASS**. Full `pnpm check`: **113 test files / 710 tests, PASS**. Global coverage: **94.64% statements / 90.08% branches / 92.50% functions / 95.68% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — planned credential-minimization boundary

- The restore capability registry now declares automatic components requiring target database and Management credentials, alongside the existing privileged Storage credential subset. The CLI derives all three requirements from planned actions and only constructs their corresponding handlers when the credential is necessary.
- A database-only restore regression succeeds with a target database URL but no Management credential or network call. Exact capability tests prevent handler and credential requirement lists from drifting.
- Focused local validation: **2 test files / 13 tests, PASS**; `tsc --noEmit`: **PASS**. Full `pnpm check`: **113 test files / 710 tests, PASS**. Global coverage: **94.64% statements / 90.10% branches / 92.50% functions / 95.68% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — Storage credential capability ownership

- Removed the CLI-local list of Storage components requiring a privileged target credential. The CLI now queries the canonical restore capability boundary, so planner capability, handler wiring and credential discovery cannot diverge through a duplicated list.
- Added an exact capability regression covering every automatic Storage handler requiring that credential. Focused local validation: **2 test files / 11 tests, PASS**; `tsc --noEmit`: **PASS**. Full `pnpm check`: **113 test files / 708 tests, PASS**. Global coverage: **94.64% statements / 90.10% branches / 92.48% functions / 95.68% lines**; all 90% global thresholds: **PASS**.

### 2026-08-16 — blocked-plan credential-discovery boundary

- Extracted `assertRestorePlanExecutable` as the core boundary used by both CLI and executor. It rejects `plan.status: blocked` before CLI reads the target database URL, loads the target Management token or performs target API discovery.
- Added a CLI regression with no target credentials and a mocked fetch; it deterministically returns `RESTORE_PLAN_BLOCKED` and makes no network call.
- Focused local validation: **2 test files / 12 tests, PASS**; `tsc --noEmit`: **PASS**. Full `pnpm check`: **113 test files / 707 tests, PASS**. Global coverage: **94.62% statements / 90.10% branches / 92.39% functions / 95.66% lines**; all 90% global thresholds: **PASS**.

### 2026-08-15 — restore artifact preflight checkpoint

- `restore --apply` now validates every artifact named by a planned action after handler-completeness validation and before checkpoint creation or target mutation. Direct artifacts must be non-symlink files and resolve within the verified bundle root.
- Verified-input checksum enforcement rejects a removed declared artifact even earlier as `BUNDLE_INCOMPLETE`; the executor is not invoked and diagnostics remain redacted.
- Local result: **110 test files / 690 tests, PASS**. Global coverage: **94.67% statements / 90.01% branches / 92.45% functions / 95.73% lines**; all 90% global thresholds: **PASS**.

### 2026-08-15 — Analytics restore-fidelity checkpoint

- The current official Analytics/Iceberg surface is alpha and requires separate S3 credentials for table data. pgDumpster captures catalog metadata but cannot export the referenced data plane.
- Metadata-only Analytics capture now yields explicit `not_exportable` data and `not_identically_restorable` catalog fidelity, so restore reports manual platform limits instead of failing with a missing handler.
- `docs/06-restore-engine.md` was reconciled with the implemented guarded `restore --apply` behavior; it continues to state that final semantic parity and hosted E2E are pending.

### 2026-08-15 — control-plane handler audit checkpoint

- Audited capture surfaces that could otherwise become `planned` without a mutation handler. Vanity subdomain, disk/autoscale, selected add-ons, JIT access, read-replica topology, log drains and PrivateLink now carry `not_identically_restorable` source fidelity.
- The restore planner turns those captured read-only surfaces into explicit manual platform limits. It never proceeds to a fabricated mutation endpoint, including when a billable-resource opt-in is supplied.

### 2026-08-15 — Auth provider restore checkpoint

- Refreshed the dated official Auth contract snapshot with the current SSO-provider and Third-party Auth mutation contracts.
- Added runtime-validated Management API `POST` and `DELETE` transport methods.
- `restore --apply` now assembles Auth SSO and Third-party Auth handlers. They compare canonical semantic provider collections, fail before mutation on a divergent non-empty target under the default `fail` policy, and allow only explicit scoped delete/recreate under `replace`.
- Local result: **108 test files / 678 tests, PASS**; contract-drift check: **PASS**.
- Global coverage: **94.71% statements / 90.01% branches / 92.46% functions / 95.83% lines**; all 90% global thresholds: **PASS**.

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
- Local `pnpm check` after the initial slice: **85 test files / 500 tests, PASS**.

### 2026-08-15 — post-consistency coverage hardening checkpoint

- Added focused failure/security-path tests for Edge, Vault, specialized Storage, safe cleanup and generic consistency cleanup/cancellation semantics.
- Final local suite: **88 test files / 525 tests, PASS**.
- Global coverage: **94.47% statements / 90.74% branches / 92.05% functions / 95.64% lines**.
- Repository 90% global thresholds: **PASS**.
- Coverage thresholds were not lowered and production files were not excluded to recover the gate.

### 2026-08-15 — standard age encryption checkpoint

- Added shell-free `age` encrypt/decrypt subprocess wrapper with bounded diagnostics, cancellation, atomic publication and restrictive output permissions.
- Windows durability handling uses a writable file descriptor before `fsync`, covered by the local Windows test run.
- Backup config `encryption.mode: age` now requires a recipient and no longer needs the plaintext opt-in.
- Encrypted backup publication produces `.tar.zst.age` and removes normal plaintext archive/workspace output on success.
- `.tar.zst.age` is accepted by inspect/coverage/verify and restore dry-run with configured `encryption.identityFile`.
- Latest local suite: **92 test files / 541 tests, PASS**.
- Global coverage: **94.45% statements / 90.51% branches / 91.89% functions / 95.64% lines**.
- Repository 90% global thresholds: **PASS**.

### 2026-08-16 — managed-schema diff engine compatibility

- Current official Supabase CLI documentation was revalidated. The legacy
  `db diff` engine has known publication, Storage-bucket and
  `security_invoker`-view failure modes that occur in the disposable hosted
  fixture. The current `--use-pg-delta` engine completed a read-only
  `auth,storage` diff on that fixture with an empty delta.
- `dumpManagedSchemaCustomizations` now selects `--use-pg-delta` explicitly,
  rather than inheriting the installed CLI's legacy default. Its exact
  shell-free invocation is covered by the database-dump regression.
- Focused database dump/restore validation: **2 test files / 23 tests,
  PASS**; `pnpm lint` and `pnpm build`: **PASS**. Full candidate validation
  and a repeat encrypted hosted E2E remain pending.

### 2026-08-16 — current-candidate local hosted E2E

- Re-ran the hardened live harness after explicitly selecting `pg-delta` for
  managed `auth`/`storage` schema customizations. The encrypted verified
  source-to-clean-target sequence completed locally: backup
  `complete_with_platform_limits`, offline verification `verified`, restore
  and parity `restored_with_platform_limits`, **55** terminal coverage
  components, **19** verified planned restore actions, and matching database,
  direct Storage byte-hash and restored Auth password-login smoke.
- The only manual actions were the already classified PgBouncer, Auth secret
  fields/signing material, Edge secret digest and deployed Edge dependency
  platform limits. The short-lived age identity and sanitized local summary
  were removed after observation.

### 2026-08-16 — restored Auth application smoke

- The live harness now creates one disposable confirmed Auth user only after a
  clean-target preflight that also rejects residual `pgdumpster-e2e-*` Auth
  fixtures. Following encrypted backup and restore, it signs in to the target
  using that source password and requires the restored user ID/email to match.
- A fresh local managed-Supabase run passed backup
  `complete_with_platform_limits`, offline verification `verified`, restore and
  parity `restored_with_platform_limits`, all **55** terminal coverage
  components, **19** verified planned actions, database/Storage smokes and the
  Auth password smoke. The only manual actions remained the six documented
  platform limits; no secret material was written to the result.
- Local validation: `pnpm check`: **PASS**; `pnpm test:coverage`: **116 test
  files / 728 tests, PASS**. Global coverage: **94.61% statements / 90.04%
  branches / 92.55% functions / 95.65% lines**; all 90% global thresholds:
  **PASS**.

### 2026-08-16 — 10k small Storage-object orchestration regression

- Added a deterministic 10,000-object fixture through the actual product
  file-storage backup step. It verifies that every one-byte object reaches the
  protected object index in source order and that active downloads never exceed
  configured bounded concurrency.
- This closes the local 10k-small-object fixture requirement only. It does not
  claim RSS/throughput evidence for a real provider, a large database dump or
  a provider-scale S3 upload.
- Local validation: focused product-backup tests **5 tests, PASS**.

### 2026-08-16 — large database-dump streaming regression

- Added a deterministic 64 MiB `database.data` dump fixture whose simulated CLI
  process streams 64 KiB chunks directly into the production `.partial`
  artifact. The test verifies the final artifact byte count without constructing
  a 64 MiB SQL value in the fixture or pgDumpster process.
- This closes the local large-database-dump fixture requirement only. Provider
  throughput/RSS, retries and checkpoint-overhead evidence remain separate.
- Local validation: focused database-dump tests **11 tests, PASS**.

### 2026-08-16 — Cloudflare R2 multipart scale observation

- Published and independently verified a disposable **128 MiB** encrypted-form
  transport object to the scoped Cloudflare R2 test bucket through
  `publishS3Backup`, using 5 MiB multipart parts and concurrency 4. The run
  completed in **8,497 ms** (**15.06 MiB/s**) with observed process peak RSS
  **152,346,624 bytes**; it then removed both object and completion marker.
- This is provider-specific live S3 publication evidence. It does not yet
  establish comparative retry, requests-per-second or checkpoint-overhead
  measurements under provider fault/load conditions.
- This is real managed-Supabase evidence for the current candidate. It does
  not substitute for the separately required protected GitHub Environment
  workflow execution.

### GitHub CI / CodeQL note

The earlier regular CI matrix passed on its validated checkpoint. Current Actions quota is exhausted, so newly pushed commits are expected to be blocked by quota until reset and should not be interpreted as code-quality failures. CodeQL publication remains a separate repository-configuration gate.

## Next implementation order

1. deterministic Management API simulator and the specified Storage scale/stream evidence;
2. protected full-fixture hosted E2E (Vault, Edge/secrets, Auth/service config and application smoke) and resolve any resulting fidelity gap;
3. CodeQL result publication/current-candidate CI when GitHub configuration/quota permit it;
4. trusted-publisher setup, SemVer/tagged release workflow, published-artifact verification and final acceptance audit.
