# Product acceptance criteria

This file is the final “done” contract. A feature is not complete merely because code exists.

## Evidence audit - 2026-08-16

The checkboxes below remain the binding criterion-level ledger. This audit records their current classification without converting code review into acceptance. **Implemented + evidenced** means current local tests and/or recorded disposable live evidence; **implemented but evidence missing** means the code exists but needs current-candidate, scale or protected live proof; **implementation missing** means a required path is absent; **platform/manual limit** means automatic exact fidelity is not available and requires an operator procedure; **release-time/external gate** requires GitHub/npm/repository action.

| Criteria                 | Classification                   | Evidence / remaining action                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A.1–A.2, A.5–A.6         | implemented + evidenced          | Strict ESM build, frozen lockfile and local `pnpm check` pass.                                                                                                                                                                                                                                                                                                                                      |
| A.3–A.4                  | implemented + evidenced          | Release SHA `dd0d42c128907de473f71024196a62da2f124bcb` passed CI run `31979435085`, including Node 22/24 on Ubuntu, macOS and Windows, before `v0.1.2` published.                                                                                                                                                                                                                                   |
| A.7–A.8                  | implemented but evidence missing | Package metadata/license/community files exist; final clean-history and candidate-package audit remain release gates.                                                                                                                                                                                                                                                                               |
| B.18–B.24, B.26–B.27     | implemented + evidenced          | CLI/parser, JSON/error/redaction regressions exist.                                                                                                                                                                                                                                                                                                                                                 |
| B.25                     | implemented + evidenced          | `--non-interactive` parser regression added on 2026-08-16.                                                                                                                                                                                                                                                                                                                                          |
| C                        | implemented + evidenced          | Data-driven registry requires one terminal result and explicit limits.                                                                                                                                                                                                                                                                                                                              |
| D                        | implemented + evidenced          | Database dump/inventory/adapters and focused regressions exist; full hosted extension fixture remains under Q.                                                                                                                                                                                                                                                                                      |
| E.60–E.63                | implemented + evidenced          | Protected root-key capture/restore ordering and leak regressions exist.                                                                                                                                                                                                                                                                                                                             |
| E.64                     | platform/manual limit            | The protected root key is restored and live-verified, but the logical target role cannot insert the captured encrypted `vault.secrets` rows. Exact target decryption therefore requires a documented Supabase physical restore/clone flow or explicit secret recreation with ID mapping; it must not be represented as an automatic logical-restore proof.                                          |
| F                        | implemented + evidenced          | Auth capture/restore contracts and non-exportable signing-material reporting are covered locally.                                                                                                                                                                                                                                                                                                   |
| G.78–G.82, G.84          | implemented + evidenced          | Modern/legacy replacement and protected rotation-map flows have regressions.                                                                                                                                                                                                                                                                                                                        |
| G.83                     | platform/manual limit            | Export only what the current Edge secret API exposes; plaintext-unavailable values require documented substitution, not fake exact restoration.                                                                                                                                                                                                                                                     |
| H.88–H.92                | implemented + evidenced          | The invalid Management API body path remains rejected. The guarded CLI source-tree capture/deploy path has local regressions and a managed source-to-target deploy plus invocation smoke passed on 2026-08-16. Worker-local `file:///tmp/...` metadata is normalized as non-portable; the downloaded source tree is the deploy authority.                                                           |
| H.93                     | platform/manual limit            | The current Edge secret endpoint exposes digests rather than source plaintext. Plaintext-unavailable values require documented substitution; function source deployment is independent but runtime secret continuity cannot be claimed without that operator action.                                                                                                                                |
| I.97–I.100, I.102–I.105  | implemented + evidenced          | Streamed catalog/object capture, adversarial keys, resume and clean-target private-object verification exist.                                                                                                                                                                                                                                                                                       |
| I.101                    | implemented + evidenced          | `tests/unit/storage-download.test.ts` streams a 32 MiB object as 64 KiB chunks while asserting digest, byte count and persisted output without constructing an equivalent-size body.                                                                                                                                                                                                                |
| J                        | platform/manual limit            | Vector/Analytics use separate capability outcomes; unsupported data is never labeled a full export.                                                                                                                                                                                                                                                                                                 |
| K.117–K.127              | implemented but evidence missing | Capture/classification is covered; every mutable control-plane path needs a current documented write contract or remains an explicit limit.                                                                                                                                                                                                                                                         |
| L–M                      | implemented + evidenced          | Consistency, resume, archive integrity, `age`, hostile archive and corruption tests pass.                                                                                                                                                                                                                                                                                                           |
| N                        | implemented + evidenced          | Multipart/resume/marker/integrity tests plus live Cloudflare R2 interoperability passed.                                                                                                                                                                                                                                                                                                            |
| O.163–O.174              | implemented + evidenced          | Guarded `--apply`, immutable plan/checkpoint, conflict/billable gates, dependency ordering and disposable source→target observations exist.                                                                                                                                                                                                                                                         |
| P.178–P.184              | implemented + evidenced          | Threat model, shell-free process wrappers, redaction and archive protections have local tests.                                                                                                                                                                                                                                                                                                      |
| P.185                    | implemented + evidenced          | CodeQL run `31979435100` completed successfully for release SHA `dd0d42c128907de473f71024196a62da2f124bcb`.                                                                                                                                                                                                                                                                                         |
| P.186                    | implemented + evidenced          | Release run `31979898052` generated a CycloneDX SBOM from a fresh production install of the packed artifact, published `v0.1.2`, verified the registry artifact and created the attestation and GitHub Release.                                                                                                                                                                                     |
| Q.190–Q.192, Q.195–Q.200 | implemented + evidenced          | Unit/contract/local integration, consistency, resume, corruption, secret and archive regressions exist; prior OS-matrix evidence is not current-candidate evidence.                                                                                                                                                                                                                                 |
| Q.193                    | implemented + evidenced          | Deterministic queued simulator covers latency, reset, 429, changing response/pagination, mutation, secret fixture and stale-ETag scenarios.                                                                                                                                                                                                                                                         |
| Q.194                    | implemented + evidenced          | Deterministic 10k small-object orchestration, 100k inventory, 32 MiB object-stream and 64 MiB database-dump regressions exist. A 128 MiB Cloudflare R2 baseline measured 13.61 MiB/s, 34 requests, zero observed retries, 154,140,672-byte peak RSS and checkpoint-state persistence. Comparative provider fault injection is additional confidence evidence, not a pre-public release requirement. |
| Q.201–Q.203              | implemented + evidenced          | Release SHA `dd0d42c128907de473f71024196a62da2f124bcb` passed protected Live E2E run `31979442398` with terminal 55-component coverage, 20 verified planned restore actions, matching database/direct Storage/Auth smokes and restored Edge Function invocation. Vault ciphertext, Edge secret plaintext and private Auth signing material remain explicit manual/platform limits.                  |
| R.207–R.215              | implemented + evidenced          | Release run `31979898052` passed CI-built and registry fresh-install CLI smoke; manual/platform limits remain explicitly documented.                                                                                                                                                                                                                                                                |
| R.216                    | implemented + evidenced          | Official contract drift run `31979441181` passed at the release candidate SHA.                                                                                                                                                                                                                                                                                                                      |

The immediate local implementation and `v0.1.2` release evidence are complete. Future release candidates must repeat official contract drift, protected hosted E2E and tagged release actions.

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
- [x] arbitrary object size streams without equivalent RAM usage. Evidence: the 32 MiB/64 KiB chunked download regression verifies byte count, SHA-256 and persisted output without creating an equivalent-size body.
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
- [x] Management API fault simulator. Evidence: `tests/fixtures/management-api-simulator.ts` and its deterministic regression scenarios (2026-08-16 local coverage gate).
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
