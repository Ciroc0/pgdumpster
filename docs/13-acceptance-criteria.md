# Product acceptance criteria

This file is the final “done” contract. A feature is not complete merely because code exists.

## A. Repository and build

- [ ] TypeScript project builds with strict type checking.
- [ ] ESM/runtime packaging is deterministic.
- [ ] Supported Node LTS versions are documented and CI-tested.
- [ ] Linux, macOS and Windows CI pass.
- [ ] Dependency lockfile is committed.
- [ ] `format`, `lint`, `typecheck`, `build`, `test` scripts exist and pass.
- [ ] No placeholder package/install claims remain.
- [ ] PolyForm Shield 1.0.0 is reproduced verbatim; NOTICE, LICENSING, contribution, community, and security files match the source-available/commercial-license model.

## B. CLI

- [ ] `pgdumpster doctor`.
- [ ] `pgdumpster backup`.
- [ ] `pgdumpster inspect`.
- [ ] `pgdumpster verify`.
- [ ] `pgdumpster coverage`.
- [ ] `pgdumpster restore`.
- [ ] `--json` stable machine mode.
- [x] `--non-interactive` deterministic behavior. Evidence: global parser accepts the explicit prompt-free mode, rejects duplicates and regression coverage is in `tests/unit/cli-help.test.ts` (2026-08-16 local gate).
- [ ] stable exit codes.
- [ ] no secret values in normal output.

## C. Coverage registry

- [ ] Coverage registry is data-driven, not scattered conditionals.
- [ ] Every registered component has exactly one terminal status.
- [ ] Unknown/unhandled required component cannot disappear.
- [ ] Final result semantics match `complete`, `complete_with_platform_limits`, `failed`.
- [ ] Platform limits are explicit and actionable.

## D. Database backup

- [ ] roles exported.
- [ ] schema exported.
- [ ] data exported.
- [ ] migration history handled.
- [ ] custom managed `auth`/`storage` schema changes handled.
- [ ] extensions inventoried.
- [ ] all database schemas are coverage-classified.
- [ ] persistent state excluded by normal Supabase CLI dump is captured through dedicated adapters.
- [ ] Auth schema data is captured and verified.
- [ ] Cron jobs are captured when configured.
- [ ] Queues, active/archive messages and behavior-critical permissions are captured when configured.
- [ ] Database Webhooks are captured when configured.
- [ ] Vault encrypted database rows are captured when configured.
- [ ] unknown persistent extension-owned state cannot be silently skipped.
- [ ] Realtime publication state inventoried.
- [ ] dump commands use safe subprocess argument arrays.
- [ ] database credentials never leak to logs.
- [ ] all database payload hashes verify.

## E. Vault

- [ ] pgsodium/Vault root key exported when available.
- [ ] key never appears in stdout/stderr/logs.
- [ ] protected in bundle.
- [ ] restored before dependent encrypted database state.
- [ ] live E2E proves encrypted fixture remains decryptable.

## F. Auth

- [ ] Auth DB state captured through database path.
- [ ] Auth service config captured.
- [ ] SSO config captured where configured.
- [ ] third-party Auth config captured where configured.
- [ ] signing-key metadata captured.
- [ ] non-exportable private signing material explicitly reported.
- [ ] restore reports token/session continuity implications when exact signing continuity is impossible.

## G. API keys and secrets

- [ ] modern API keys inventoried and revealed only when authorized/needed.
- [ ] exact source secret values protected.
- [ ] target-generated replacement keys handled.
- [ ] protected rotation map generated.
- [ ] legacy-key capability handled without assuming endpoint exists forever.
- [ ] Edge Function secret values exported where API exposes them.
- [ ] secret canary never leaks to logs.

## H. Edge Functions

- [ ] all deployed functions enumerated.
- [ ] metadata/config captured.
- [ ] deployed export/source representation captured.
- [ ] documented missing repository artifacts are not misrepresented as backed up.
- [ ] secrets restored before deploy.
- [ ] target function inventory/parity verified.

## I. File Storage

- [ ] all File buckets captured.
- [ ] all object bytes captured.
- [ ] public/private and restrictions captured.
- [ ] content type/cache-control/relevant metadata preserved.
- [ ] arbitrary object size streams without equivalent RAM usage.
- [ ] object keys cannot escape local paths.
- [ ] Unicode/Windows reserved/path traversal adversarial tests pass.
- [ ] interruption resumes without corruption.
- [ ] target object parity verifies.

## J. Vector and Analytics

- [ ] separate capability adapters exist.
- [ ] vector config/data backed up if complete API path is supported.
- [ ] analytics catalog/data independently classified.
- [ ] metadata-only export can never be labeled full data backup.
- [ ] unsupported/non-exportable data is explicit.

## K. Control plane

- [ ] project metadata.
- [ ] database service config.
- [ ] Realtime config.
- [ ] PostgREST config.
- [ ] Storage config.
- [ ] network restrictions.
- [ ] custom domains.
- [ ] private networking/add-ons where applicable.
- [ ] backup schedule/log drain config where exposed.
- [ ] branch topology inventoried where exposed.
- [ ] child branch data not falsely included in parent backup.

## L. Consistency

- [ ] `verified`, `best-effort`, `quiesced` modes implemented.
- [ ] pre/post inventories use canonical comparison.
- [ ] changed components are retried selectively.
- [ ] bounded retry prevents infinite backup.
- [ ] continuously changing source fails verified mode.
- [ ] absence of Storage object versioning is represented in limitations.
- [ ] result states do not call best-effort drift “verified”.

## M. Integrity and bundle

- [ ] canonical directory format implemented.
- [ ] manifest schema validates.
- [ ] coverage schema validates.
- [ ] SHA-256 for payloads.
- [ ] final marker/manifest written last.
- [ ] optional deterministic archive.
- [ ] `age` encryption path tested.
- [ ] plaintext secrets require explicit opt-in.
- [ ] malicious archive extraction tests pass.
- [ ] corrupted bundle is rejected before restore mutation.

## N. S3-compatible destination

- [ ] local destination works.
- [ ] S3-compatible destination works.
- [ ] large output uses streaming/multipart.
- [ ] remote completion marker written last.
- [ ] remote integrity is independently verified.
- [ ] interrupted remote upload can resume/recover safely.

## O. Restore

- [ ] integrity check always precedes mutation.
- [ ] dry-run produces complete action graph.
- [ ] `--apply` mandatory.
- [ ] source==target rejected.
- [ ] fresh target path tested.
- [ ] conflict `fail` default.
- [ ] no fake global rollback claim.
- [ ] billable resources require explicit flag.
- [ ] networking applied late.
- [ ] custom DNS/external resource actions emitted.
- [ ] semantic parity report generated.
- [ ] restore can resume safely.

## P. Security

- [ ] threat model reviewed.
- [ ] no shell command concatenation.
- [ ] TLS verification cannot be casually disabled.
- [ ] secret-aware logger/redactor.
- [ ] no environment dump.
- [ ] no telemetry by default.
- [ ] archive path/symlink/bomb protections.
- [ ] dependency/static analysis clean or findings dispositioned.
- [ ] generated SBOM on release.

## Q. Testing

- [ ] unit tests.
- [ ] API contract fixtures.
- [ ] local Supabase integration.
- [ ] Management API fault simulator.
- [ ] Storage stress tests.
- [ ] consistency mutation tests.
- [ ] resume/fault-injection tests.
- [ ] corruption tests.
- [ ] secret leakage tests.
- [ ] archive security tests.
- [ ] OS matrix tests.
- [ ] live hosted source→target E2E.
- [ ] live E2E includes Vault, Storage, Edge secrets/functions, Auth/database and service config.
- [ ] post-restore semantic parity passes.

## R. Documentation

- [ ] README matches implementation.
- [ ] install/setup guide tested from clean environment.
- [ ] every CLI command documented.
- [ ] credential/scopes documented.
- [ ] backup format documented.
- [ ] restore behavior documented.
- [ ] troubleshooting documented.
- [ ] compatibility matrix populated with actually tested versions.
- [ ] platform limitations and manual actions documented.
- [ ] source-of-truth references revalidated before release.

## Final release gate

The product may be called complete only when **every applicable checkbox above is satisfied** and live hosted E2E is green.

If Codex cannot access credentials/resources required for the live E2E, it must state that the implementation is awaiting that external release gate. It must not replace the evidence with a claim that mocked/local tests are equivalent.
