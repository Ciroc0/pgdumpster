# pgDumpster execution plan

This file is the implementation ledger required by `AGENTS.md`. A checked item means the named evidence exists; it does not mean the overall release gate has passed.

## Objective

Build the complete production-ready pgDumpster CLI described by the repository specifications.

## Current milestone

Milestone 1 — authenticated platform preflight and capability discovery.

## Milestones

- [x] Read the complete repository documentation, schemas, coverage registry, examples, community files, and supplied licensing instruction.
- [x] Reconcile the pgDumpster brand and PolyForm Shield licensing decision across every specification and repository surface.
- [ ] Capture a dated, reproducible Supabase contract baseline from current official docs/OpenAPI and classify every coverage component.
- [x] Scaffold strict TypeScript ESM, Node support policy, locked dependencies, formatter, linter, tests, build, and thin CLI.
- [x] Implement coverage/manifest/error domains, schemas, secure output/redaction, safe paths, checksums, bundle reader/writer, inspect, coverage, and offline verify.
- [ ] Implement configuration, capability discovery, doctor, centralized Management API transport, runtime validation, rate limiting, and contract simulator.
- [ ] Implement database base dump plus schema-coverage, Auth data, migrations, managed-schema customization, extension state, Cron, Queues, Webhooks, Vault data/root-key, and publication adapters.
- [ ] Implement File Storage byte/metadata streaming, adversarial addressing, consistency, resume, stress coverage, and local/S3 destinations.
- [ ] Implement Auth config/SSO/TPA/signing keys, modern/legacy API keys, Edge Functions/secrets, and all registered control-plane adapters.
- [ ] Implement Vector and Analytics adapters with separate catalog/data completeness and explicit platform-limit behavior.
- [ ] Implement backup consistency coordinator, finalization, deterministic `tar.zst`, age encryption, plaintext opt-in, cancellation, and resume.
- [ ] Implement integrity-first dry-run restore DAG, executor, idempotent resume, protected rotation report, manual actions, and semantic parity.
- [ ] Complete unit, contract, subprocess, simulator, local integration, corruption, archive, secret-leak, resume, stress, and OS-matrix validation.
- [ ] Complete OSS/security/release documentation, CI, SBOM/provenance, clean-install/package smoke, and final self/security review.
- [ ] Run the dedicated live managed-Supabase source → encrypted backup → offline verify → clean-target restore → semantic parity E2E.

## Decision log

### 2026-08-13 — Canonical product identity

- Choice: brand `pgDumpster`; repository/package/CLI `pgdumpster`; domain `pgdumpster.com`; archive name `pgdumpster-<UTC>.tar.zst` (optionally age-encrypted).
- Reason: explicit maintainer decision; avoids implying official Supabase affiliation.
- Rejected: working name `Supabackup`, `supabackup` identifiers, and `.supabackup.tar.gz` as the canonical archive.
- Affected: all docs, schemas, examples, environment variables, paths, CI, package metadata, runtime output, and bundle identifiers.

### 2026-08-13 — Public license and commercial alternative

- Choice: public source is PolyForm Shield License 1.0.0, reproduced verbatim in `LICENSE`; required notices identify Mathias Kjær Pedersen trading as MKP Digital (CVR 45731170), the protected line of business, and `kontakt@mkpdigital.dk`; a separate proprietary commercial license may be negotiated in writing.
- Reason: explicit maintainer licensing instruction; competing hosted/managed/white-label backup products must not be permitted by the public license.
- Rejected: Apache-2.0, ELv2, AGPL, MIT, and wording that presents the repository license as `PolyForm Shield OR Commercial License`.
- Consequence: the project is **source-available**, not OSI open source. `package.json` must use `SEE LICENSE IN LICENSE`. External code contributions are not accepted until a CLA exists; issues, discussions, bug reports, and documentation corrections remain welcome.
- Conflict resolution: this supersedes the Apache/open-source language in `docs/12-release-open-source.md`, `docs/13-acceptance-criteria.md`, README, NOTICE, CONTRIBUTING, SUPPORT, FILE_INDEX, handoff/goal files, and other lower-priority material. Those files must be updated together before foundation completion.

### 2026-08-13 — Supabase contract evidence policy

- Choice: implement only from the current official Management API reference/OpenAPI, CLI source/help, product docs, and dedicated live observations, in that order. Store a dated endpoint/field/permission/restore-semantics ledger and fixtures derived without real secrets.
- Reason: Supabase contracts change frequently and the specifications contain baseline assumptions rather than sufficient implementation contracts.
- Rejected: training-memory endpoints, third-party blog contracts, reverse-engineered Dashboard calls without an official contract, or marking HTTP success as semantic coverage success.

### 2026-08-13 — Current changelog constraints already verified

- Extension version clauses are ignored from 2026-08-05; restore must enable compatible target defaults and compare semantics rather than promise source-version pinning.
- Direct writes to `cron.job` are unsupported; restore must use documented `pg_cron` functions.
- The hosted managed `realtime` schema is locked against object changes; publication/config restoration must not attempt to mutate managed schema objects.
- New Data API/OpenAPI access requires a service-role or secret key, not an anon/publishable key.
- Supabase JavaScript client libraries dropped Node 20 support on 2026-06-30; the initial runtime baseline will be Node 22+ unless dependency/runtime validation proves a stricter requirement.
- OAuth token callers must accept any successful 2xx response rather than hard-code 201.
- Source: current `https://supabase.com/changelog.md` reviewed 2026-08-13; endpoint-specific verification remains pending below.

### 2026-08-13 — Completion semantics

- Choice: the overall goal remains active until every applicable acceptance criterion, required CI job, and live managed-Supabase E2E/parity gate has passed.
- Reason: binding acceptance criteria explicitly prohibit replacing the live gate with local mocks.
- Consequence: when live credentials/projects become necessary, request dedicated source and clean target projects. Until then the live gate remains visibly unfulfilled and overall completion cannot be claimed.

### 2026-08-14 — Excluded PostgreSQL state is fail-closed

- Choice: the normal Supabase dump is supplemented by a catalog inventory and explicit data-only exports for applicable `auth`, `cron`, `pgmq`/`pgmq_public`, and `vault` schemas. Any extension-owned schema with persistent tables and no versioned classification blocks backup finalization.
- Reason: normal CLI dumps exclude managed and extension-owned schemas; treating an unknown persistent schema as harmless could silently lose recoverable application state.
- Boundary: these SQL captures are backup evidence, not proof of a supported restore path. Cron jobs must be recreated through supported `pg_cron` functions, and Queues/Vault/Auth require ordered semantic restore adapters and live parity validation before their components can be reported `backed_up` end-to-end.

### 2026-08-14 — File Storage addressing and contract boundary

- Choice: enumerate File Storage bucket/object metadata from the privileged PostgreSQL `storage` catalog and copy STANDARD-object bytes through the authenticated Storage data plane. Local payload paths are content-addressed by SHA-256 of `(bucket, NUL, key)`; raw object keys never become filesystem paths.
- Reason: direct catalog enumeration avoids hierarchical-list ambiguity and preserves complete metadata, while authenticated Storage GET preserves the supported byte plane. Content addressing prevents traversal, reserved-name, Unicode-normalization, and case-fold collisions.
- Boundary: REST object keys containing a path segment exactly `.` or `..` are rejected as a platform-contract failure because URL normalization can change the requested route. A future S3 adapter may cover such a key only after current hosted behavior is proven. Analytics buckets remain a separate coverage surface and are never counted as File Storage bytes.

### 2026-08-14 — Vault root-key protection boundary

- Choice: the pgsodium root key is runtime-validated as an exact 32-byte hex value, immediately registered with the central redactor, and written only through a `ProtectedArtifactSink`. Plaintext protected artifacts require explicit `--allow-plaintext-secrets` authorization and remain mode 0600 where POSIX permissions apply.
- Reason: the key must remain exact for Vault recovery, but allowing ordinary metadata writers to receive it would make accidental logs and plaintext leakage too easy.
- Security boundary: protected artifacts are constrained to `secrets/`; traversal and parent symlink/junction escapes are rejected. Default backup orchestration must use encrypted protected storage unless the explicit plaintext opt-in is present.
- Restore consequence: PUT is not part of the backup adapter. A later restore action must be plan-first, explicitly applied, and ordered before `database.vault_data`; current OpenAPI warns that changing the key can make older encrypted data inaccessible.

### 2026-08-14 — Auth control-plane fidelity boundary

- Choice: preserve the complete runtime-validated Auth config, SSO provider, third-party Auth, signing-key metadata, and legacy signing-key responses in protected artifacts. Unknown additive fields are retained.
- Exactness rule: an Auth config secret returned as a string is immediately registered with the central redactor and preserved, but remains `not_exportable` for identical restoration because the official read contract does not state that the returned value is complete, unmasked, or accepted by the write contract. A configured secret field omitted or returned null is classified separately as `auth_secret_not_returned`.
- Signing-key rule: public JWKs and key lifecycle metadata are preserved. Modern private signing material and the legacy shared secret are not exposed by the official response schemas, so their components are explicitly `not_exportable`; metadata alone is never reported as a complete signing-key backup.
- Endpoint rule: the documented SSO 404 is `not_applicable` for the project/plan. The official legacy signing-key documentation warns that the endpoint may be removed; a 404 is therefore `not_applicable`, while any other error fails the capture.
- Restore consequence: no write behavior is inferred from these GET contracts. Auth restore remains pending separate PATCH/create/import contract validation and live semantic parity.

### 2026-08-14 — API-key source fidelity and target rotation

- Choice: request project API keys with the official structured `reveal=true` query and preserve the complete response only in a protected artifact. Every returned non-empty key-like value is registered with the central redactor before subsequent processing.
- Backup rule: a non-masked returned `api_key` counts as exact source capture. Null, empty, bullet-masked, ellipsis-masked, or asterisk-masked values are `not_exportable`; metadata alone never counts as the key secret. The legacy enabled state is captured separately, and the binding removable-endpoint 404 rule is `not_applicable`.
- Restore rule: the current create schema accepts key type/name/description/JWT template but no caller-supplied key value. Therefore source values can be backed up exactly, while target restore must generate replacement values and produce a protected source-to-target rotation map; exact target key identity must not be claimed.
- Transport rule: query parameters are passed as structured values through the fixed-origin Management client. Embedded query or fragment text remains rejected in path input.

### 2026-08-14 — Edge deployed representation and secret-digest boundary

- Choice: capture the complete Management API `multipart/form-data` function-body response byte-for-byte together with the exact response content type, hash, size, list metadata, and pre/post per-function metadata. This is the deployed representation, not a claim that the original source repository was recovered.
- Consistency rule: function id/slug/status/version/update time/JWT/import-map/entrypoint/deployment-hash fields are compared before and after body streaming. A mismatch is retryable `BACKUP_SOURCE_DRIFT_DETECTED`; the index is not published and finalization cannot silently accept the partial capture.
- Source-fidelity rule: current official migration documentation says CLI download omits import maps and `deno.json`, but a live CLI v2.114.0 fixture returned both `deno.json` and `index.ts` byte-identically. The complete exposed multipart deployed representation is therefore `backed_up`; this does not claim recovery of the original Git repository or legacy bundle formats.
- Secret rule: current official CLI v2.114.0 renders `SecretResponse.value` under the `DIGEST` heading. pgDumpster preserves all returned names/digests/timestamps in a protected artifact, but marks original values `not_exportable` and never submits digests to the bulk-create secret endpoint.
- Filesystem rule: ordinary streamed artifacts and protected artifacts create each parent component only after no-follow lstat/realpath containment checks. A symlink/junction cannot cause even an intermediate directory to be created outside the bundle root.

## Contract revalidation ledger

Status vocabulary: `pending`, `documented`, `openapi-validated`, `fixture-tested`, `live-validated`, `platform-limit`.

| Surface                                                              | Current evidence target               | Status         | Notes                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management API auth/rate limits/OAuth                                | API reference + changelog             | fixture-tested | Bearer auth, any 2xx, 401/403, scoped proactive throttling, bounded 429/5xx/network retry, and runtime contract failures tested.                                                                                                                                                                           |
| Database dump/restore and managed schemas                            | CLI help/source + migration docs      | fixture-tested | Five official logical dump forms, password-free argv, atomic no-clobber outputs, and failure cleanup are fixture-tested; hosted permissions and restore remain pending.                                                                                                                                    |
| Extension inventory/Cron/Queues/Webhooks/Vault DB state              | product docs + live catalog contracts | fixture-tested | Catalog classification and explicit Auth/Cron/Queues/Vault data dumps are fixture-tested; unknown persistent extension schemas fail closed. Webhooks and semantic/live restore remain pending.                                                                                                             |
| Vault/pgsodium root key                                              | Management API OpenAPI                | fixture-tested | Beta GET/PUT `/v1/projects/{ref}/pgsodium`; GET exact-secret capture, contract failure, redaction, protected sink, and plaintext/junction guards are tested. PUT/live restore validation remains pending.                                                                                                  |
| Auth config/SSO/TPA/signing keys                                     | Management API OpenAPI + Auth docs    | fixture-tested | Five read endpoints and their dated schema subset are runtime-validated and fixture-tested. Complete responses are protected and additive fields preserved; secret/signing exactness limits are field-classified. Restore and live validation remain pending.                                              |
| Modern/legacy API keys                                               | Management API OpenAPI + key docs     | fixture-tested | `reveal=true` list capture and legacy enabled-state capture are protected and runtime-validated. Current create schema proves no source-value import field, so target replacement/rotation mapping is required. Live validation remains pending.                                                           |
| Edge Functions and secrets                                           | Management API OpenAPI + CLI/live     | live-validated | Raw multipart body, metadata drift, digest-only secrets, bounded streaming, no-clobber output, and path containment are fixture-tested. A live CLI v2.114.0 deployment/download proved `deno.json` and `index.ts` byte identity and secret digest semantics; direct adapter orchestration remains pending. |
| File Storage                                                         | Storage docs/API/S3 docs              | fixture-tested | Official Storage OpenAPI is hash-pinned; privileged SQL catalog normalization and streamed authenticated byte copy are fixture-tested with content addressing, SHA-256, size drift, retry, and unsafe-key guards. Live completeness/parity remains pending.                                                |
| Vector Storage                                                       | current official API/SDK docs         | pending        | Evolving surface; complete pagination and restore semantics required.                                                                                                                                                                                                                                      |
| Analytics/Iceberg Storage                                            | current official API/catalog docs     | pending        | Catalog and actual data export must be classified independently.                                                                                                                                                                                                                                           |
| Realtime/PostgREST/Storage/database configuration                    | Management API OpenAPI                | pending        | Field-level writable/read-only/masked semantics required.                                                                                                                                                                                                                                                  |
| Network/domains/private link/project topology/log drains/JIT/backups | Management API OpenAPI                | pending        | Billable/destructive/external prerequisites must be explicit.                                                                                                                                                                                                                                              |

## Validation log

### 2026-08-13 — Documentation and repository audit

- Command: read every file in `docs/00-overview.md` through `docs/22-ci-release-workflows.md`, plus root policy/community files, `spec/coverage-registry.yaml`, both JSON schemas, all examples, and `.github` templates.
- Result: PASS for completeness of the reading step. No product implementation exists yet. Found systemic old-name and Apache/open-source conflicts, missing `LICENSING.md`, placeholder release/security fields, and an intentionally non-runnable GitHub Actions example.

### 2026-08-13 — Supabase changelog baseline

- Command: `Invoke-WebRequest -UseBasicParsing -Uri 'https://supabase.com/changelog.md'` and review relevant breaking-change entries.
- Result: PASS; current document retrieved with HTTP 200. Material constraints recorded above. Endpoint-by-endpoint OpenAPI revalidation remains in progress.

### 2026-08-13 — License source

- Source: `https://polyformproject.org/licenses/shield/1.0.0.txt`.
- Result: official PolyForm Shield License 1.0.0 retrieved; the former Apache-2.0 `LICENSE` was identified for verbatim replacement, completed in the reconciliation slice below.

### 2026-08-13 — Brand and license reconciliation

- Command: repository-wide hidden-file search for the former brand, former environment prefix, Apache wording, `NOTICE.md`, and `tar.gz`, excluding the historical decision log and verbatim license.
- Result: PASS; no stale hits. Canonical identifiers are pgDumpster/`pgdumpster`/`PGDUMPSTER_*`; packed artifacts use `pgdumpster-<UTC>.tar.zst[.age]`.
- Command: byte comparison of local `LICENSE` with `https://polyformproject.org/licenses/shield/1.0.0.txt`.
- Result: PASS; byte-identical, length 5748, SHA-256 `67530f8e9adfcc5d2e9d72b804500cebb7472ff84c34a6729a80a2a9be901ee6`.

### 2026-08-13 — Toolchain and package-name baseline

- Observed: Node `24.16.0`, npm `11.13.0`, pnpm initially `10.17.1`, installed Supabase CLI `2.101.0`.
- Current registry checks: Supabase CLI stable `2.114.0`; `pgdumpster` returned npm E404 (available snapshot, not reserved).
- Verified CLI `2.114.0` help for `db dump`, `functions list`, `functions download`, and `secrets`; exact dump flags in the specification exist. Function download now also exposes `--use-api` and can download all functions when the name is omitted.

### 2026-08-13 — Foundation slice

- Dependencies: exact direct versions plus pnpm 11 lockfile; seven-day `minimumReleaseAge` policy is strict with no exceptions; only `esbuild` is permitted to run an install build script.
- Runtime policy: Node `>=22.15.0 <23 || >=24 <25`; Node 22.15 is the first 22.x release with built-in streaming Zstd, while Node 22 and 24 are current LTS lines.
- Implemented: strict TypeScript ESM configuration, formatter/linter/test/build scripts, data-driven registry loader, exact 55-component coverage invariant, final-result derivation, structured error domain, central redactor, and unit tests.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- Result: PASS; 2 test files, 10 tests. Initial lint findings were fixed before the recorded green run.

### 2026-08-13 — Offline integrity and finalization slices

- Implemented: strict runtime schemas for manifest and coverage, schema/example contract tests, safe cross-platform bundle paths, Unicode/case-fold collision rejection, SHA-256 deep verification, unindexed/missing/corrupt-file detection, symlink/special-file rejection, and real `inspect`, `coverage`, and `verify` CLI behavior for directory bundles.
- Implemented: atomic file writer and bundle finalizer; all 55 registry outcomes are required, the overall result is derived from coverage, transient checkpoint/partial material is rejected, the checksum index is deterministic, and `manifest.json` is written only after payload hashing and checksum-index finalization.
- Security validation: corruption, missing/extra files, Windows junction traversal, pre-aborted finalization, manifest/coverage drift, and secret-redaction canaries.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- Implemented: deterministic streaming `tar.zst` packing with fixed safe metadata and Zstd parameters; same-filesystem atomic no-clobber publication; archive-aware offline CLI; streaming extraction into an isolated temporary root with traversal, symlink/hardlink/special-entry, duplicate/case-fold collision, file-count, per-file byte, and total expanded-byte defenses.
- Result: PASS; 7 test files, 35 tests. Deterministic archive bytes, no-overwrite, abort-before-publication, packed CLI verify, traversal/link rejection, and decompression limits are covered. Encryption and destination/resume integration remain open.

### 2026-08-14 — Management transport and doctor slice

- Contract evidence: official Management OpenAPI `3.0.0`, title `Supabase API (v1)`, version `1.0.0`, 334072 bytes, SHA-256 `846aef2b9188ae843d8f782cc7f7ee1bed9dde63ba0ff8fc511d9627c98ea751`; official changelog 94433 bytes, SHA-256 `56164e5f8765c9a8f5e88cde994556efb96ed2a540e715151e61ae2389025393`.
- Reproducibility: dated baselines live in `contracts/`; `pnpm contracts:check` re-fetches both official sources and fails on byte/hash drift. Result: PASS on 2026-08-14.
- Implemented: protected secret values, explicit environment loading without implicit `.env`, fixed-origin HTTPS Management client, runtime-validated additive-tolerant project/health schemas, scoped proactive throttling, bounded 429/5xx/network retries, sanitized errors, and project/service discovery.
- Implemented: read-only `doctor` checks for Node, Supabase CLI, Management API, service health, direct PostgreSQL identity, privileged File Storage bucket listing, local destination/capacity, and `age`; stable JSON/human output and exit classes. A publishable/anon/unknown Storage credential cannot prove full access and fails closed.
- Subprocess validation found and fixed Windows ESM entrypoint detection; built CLI help and missing-config JSON are now exercised as a real child process.
- Commands: `pnpm contracts:check`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, built CLI smoke.
- Result: PASS; 11 test files, 48 tests. Full configuration-file merge/precedence and complete per-component capability discovery remain open, so the configuration/capability milestone is not checked yet.

### 2026-08-14 — Configuration, CI definition, and initial database capture

- Implemented: strict explicit YAML configuration with size, alias, duplicate-key, unknown-field, secret-field, symlink, and HTTPS endpoint defenses; deterministic CLI/config/environment precedence; no implicit `.env` loading.
- Implemented: pinned GitHub Actions definitions for quality, unit/contract, integration, security, Node 22/24 on Linux/macOS/Windows, scheduled contract drift, CodeQL, and Dependabot. Workflow YAML parses locally and `pnpm audit --prod --audit-level high` reports no known vulnerabilities; hosted jobs have not run and are not claimed as passed.
- Implemented: cancellation-aware bounded concurrency; shell-free cross-platform subprocess execution with bounded output; Windows Supabase npm shim resolution tested against installed CLI `2.101.0`.
- Implemented: five official Supabase logical dump forms, database password passed only through `PGPASSWORD`, unique partial outputs and atomic no-clobber publication. Catalog inventory records extensions, non-system schemas, persistent table counts/bytes, explicit state classification, and unknown persistent extension schemas.
- Implemented: dedicated applicable data-only dumps for Auth, Cron, Queues, and Vault state. These do not yet satisfy their restore/parity gates; Webhooks, managed-schema customizations, publications, and supported semantic restore remain open.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- Result: PASS; 15 test files, 59 tests. Hosted CI, local service integration, contract simulator, security matrix, and live managed-project validation remain open.

### 2026-08-14 — Database catalog, resume integrity, and initial File Storage slices

- Contract evidence: official Storage OpenAPI at `https://supabase.github.io/storage/api.json`, 97161 bytes, SHA-256 `fb46458a9e367dbbed68785e7ba6965bab329e9486f1969f36a124b9c662241c`; bucket pagination, object listing, authenticated object GET, and object-info operations are recorded in `contracts/` and included in `pnpm contracts:check`.
- Implemented: runtime-validated PostgreSQL publication membership including column lists/row filters, and explicit Supabase Database Webhook trigger definitions (`supabase_functions.http_request`). Official docs confirm Database Webhooks are trigger/`pg_net` integrations and Realtime Postgres Changes uses publication membership.
- Implemented: resumable backup checkpoint schema and state transitions; atomic mode-0600 writes; run/source/immutable-config binding; completed-artifact SHA-256/size revalidation; unsafe path and parent junction/symlink escape rejection; cancellation preservation.
- Implemented: explicit File Storage metadata dump from `storage` with Vector tables excluded, privileged SQL catalog for STANDARD buckets/objects, Analytics separation, unknown metadata preservation, and deterministic identity checks.
- Implemented: streaming authenticated Storage object download to unique partial files, content-addressed bundle paths, SHA-256 and byte-count validation, no-clobber publication, cancellation, bounded 429/5xx/network retry, and sanitized failures. Exact dot path segments fail closed due REST URL normalization.
- Reliability finding: Node 24's streaming Zstd binding intermittently emitted a trailing independent empty frame. pgDumpster now strips only the exact no-op frame before fsync/publication; the original failure reproduced after 20 loops and the fix passed 50 consecutive determinism loops.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm contracts:check`, `pnpm audit --prod --audit-level high`.
- Result: PASS for the normal local gate before coverage expansion; current suite subsequently reached 21 test files and 83 tests. Contract hashes match and production audit reports no known vulnerabilities.
- Coverage gate: FAIL and still open. `pnpm test:coverage` currently reports 87.20% lines, 85.94% statements, 81.17% functions, and 76.92% branches against the required 90% global thresholds. The threshold was not lowered; subprocess and live-collector coverage were raised with real execution/dependency-boundary tests, and remaining branches require additional tests.

### 2026-08-14 — Vault root-key backup adapter

- Current OpenAPI proof: GET `/v1/projects/{ref}/pgsodium` requires `secrets:read` and returns required `root_key`; PUT requires `secrets:write`. Both use `PgsodiumConfigResponse`; `root_key` is documented as 32 bytes encoded as 64 hex characters. PUT explicitly warns that replacement can make data encrypted with the older key inaccessible.
- Implemented: additive-tolerant runtime schema, exact root-key capture, immediate redactor registration, protected artifact `secrets/database-vault-root-key.json`, exact-fidelity coverage entry, and restore-order metadata.
- Implemented: explicit plaintext-secret opt-in gate, canonical mode-0600 atomic secret writes, `secrets/` namespace restriction, traversal rejection, and Windows junction/POSIX symlink parent-escape rejection.
- Focused result: PASS; exact capture, malformed contract, secret redaction, ordinary-output non-leakage, plaintext policy, restrictive mode, traversal, and junction escape tests.
- Full normal gate before the final junction test: PASS with 23 test files and 87 tests; contract hashes match and production audit reports no known vulnerabilities. Coverage remains FAIL at 87.37% lines, 86.12% statements, 81.50% functions, and 76.97% branches. The 90% thresholds remain unchanged.

### 2026-08-14 — Auth control-plane backup adapter

- Current OpenAPI proof: GET Auth config (`auth:read`), SSO providers (`auth:read`), third-party Auth (`auth:read`), signing keys (`secrets:read`), and legacy signing key (`secrets:read`) were extracted from the hash-pinned Management OpenAPI. `AuthConfigResponse` currently contains 237 required response fields; modern signing responses expose public JWK and lifecycle metadata but no private key material.
- Reproducibility: `contracts/supabase-auth-contracts-2026-08-14.json` contains only the five relevant operations and response schemas. `pnpm contracts:check` now re-extracts that subset from the fetched hash-pinned Management OpenAPI and fails if the subset or its source metadata differs.
- Implemented: concurrent read-only capture, runtime validation directly from the official schemas, deterministic SSO/TPA/signing ordering, protected artifacts, immediate secret redaction registration, documented 404 handling, per-secret coverage children, and explicit private signing-material limits.
- Focused result: PASS; lint, strict typecheck, five Auth adapter tests, and live contract-drift revalidation pass. Tests cover full 237-field contract fixtures, additive unknown fields, deterministic protected output, omitted secret classification, SMTP false-positive prevention, documented 404s, malformed signing-key fail-closed behavior, and derived secret-field inventory.
- Integration boundary: the adapter is not yet reachable through `pgdumpster backup` because the backup coordinator/CLI command remains pending. This slice is fixture-tested adapter evidence, not backup end-to-end completion or restore parity.
- Full local result after integration: PASS for `pnpm check` with 24 test files and 93 tests; `pnpm audit --prod --audit-level high` reports no known vulnerabilities. Coverage remains FAIL at 88.10% lines, 86.62% statements, 83.83% functions, and 77.54% branches; all four required thresholds remain 90%.

### 2026-08-14 — Modern and legacy API-key backup adapters

- Current OpenAPI proof: GET `/v1/projects/{ref}/api-keys` supports `reveal` and `secrets:read`; POST creates only `publishable` or `secret` keys from type/name/optional metadata and does not accept a source key value. GET legacy state returns required `enabled`. The relevant GET/POST/PATCH/PUT operations and four schemas are stored in `contracts/supabase-api-key-contracts-2026-08-14.json`.
- Reproducibility: `pnpm contracts:check` re-extracts and compares both Auth and API-key subsets against the freshly fetched, hash-pinned Management OpenAPI. Production response validation compiles those exact extracted OpenAPI schemas with AJV; normalized internal models are applied only after official validation.
- Implemented: fixed-origin structured query support, `reveal=true` key capture, deterministic inventory ordering, protected source key/metadata artifacts, exact-value redaction registration, masked/null value fail-closed classification, legacy enabled-state capture, documented 404 capability handling, and explicit replacement-required child records.
- Focused result: PASS; lint, strict typecheck, 15 Auth/API-key/Management transport tests, and contract drift checks pass. The create/rotation executor and protected target rotation map remain pending the restore milestone.
- Integration boundary: as with the Auth adapter, this capture is not yet reachable through a completed `pgdumpster backup` coordinator and has not been live-validated.
- Full local result: PASS for `pnpm check` with 25 test files and 98 tests, current official contract hashes, and `pnpm audit --prod --audit-level high`. Coverage remains FAIL at 88.60% lines, 86.93% statements, 84.61% functions, and 77.58% branches; thresholds remain unchanged at 90%.

### 2026-08-14 — Edge Functions and secrets backup adapter

- Current OpenAPI proof: list/get/body/deploy Function operations and list/create Secret operations require the documented `edge_functions:*`/`secrets:*` scopes. Seven relevant schemas and six operations are stored in `contracts/supabase-edge-contracts-2026-08-14.json` and re-extracted by `pnpm contracts:check`.
- Current CLI proof: official Supabase CLI v2.114.0 requests Function bodies with `Accept: multipart/form-data`, resolves paths from `Supabase-Path` or Content-Disposition, and labels listed `SecretResponse.value` as `DIGEST`. Although the official migration guide still says import maps and `deno.json` are not downloaded, live CLI v2.114.0 validation returned `deno.json` and `index.ts` byte-identically.
- Implemented: exact OpenAPI runtime validation; deterministic function/secret ordering; bounded concurrent raw-body streaming with byte limit, SHA-256, atomic no-clobber publication, multipart contract checks, and pre/post drift detection; protected digest inventory; `backed_up` classification for the complete exposed function representation; explicit secret-value platform limits.
- Security correction: parent directories for both ordinary and protected artifacts are now created component-by-component only after junction/symlink containment checks. Windows junction/POSIX symlink tests prove an escaped intermediate directory is not created.
- Focused result: PASS; 4 Edge tests and 6 artifact/protected-sink tests pass without disabled platform checks. Full gate is recorded separately.
- Live result: PASS for the isolated Edge contract fixture on project `xcprumxkpsapxdfnejdi`. CLI v2.114.0 deployed and downloaded `pgdumpster-edge-canary`; both returned files matched source byte sizes and SHA-256 hashes. A randomly generated canary secret was returned only as a 64-character lowercase hexadecimal SHA-256 digest of the source value, proving it is not an identically restorable secret. Neither the source value nor digest was logged or persisted.
- Historical boundary at this slice: pgDumpster's own Management client still needed a safely injected personal access token before its adapter could be exercised directly. The later direct-validation slice supersedes this credential gate; the user explicitly designated the project and its credential as disposable test infrastructure.

### 2026-08-14 — Backup coordinator core and fail-closed finalization

- Implemented: a strict ordered backup coordinator with atomic checkpoint transitions, immutable source/config identity, per-step attempt counts, checksum validation of completed artifacts, coverage persistence inside the checkpoint, interruption-safe resume, and final manifest creation only after all registered components have exactly one terminal classification.
- Integrity rule: finalization now verifies every artifact referenced by `coverage.json` exists as a regular indexed bundle file. Missing references, transient checkpoint material, incomplete registry coverage, changed completed artifacts, and source/config/step-order drift prevent `manifest.json` creation.
- Resume result: PASS; an interruption test proves a completed first step is checksum-validated and not rerun, a failed second step is retried, and the resumed bundle independently verifies. An incomplete-coverage test proves a partial run cannot be labeled complete.
- Full local result: PASS for `pnpm check` with 28 test files and 109 tests. Current official contract snapshots match and the production audit reports no known vulnerabilities. Coverage remains FAIL at 88.78% lines, 86.92% statements, 84.33% functions, and 77.72% branches; all four required thresholds remain unchanged at 90%.
- Integration boundary: this core deliberately does not expose `pgdumpster backup` until a production composition can classify every registry component through real adapters. Adapter omissions must not be converted into fictitious `not_exportable` outcomes.

### 2026-08-14 — Core control-plane configuration capture

- Current OpenAPI proof: eleven GET operations for PostgreSQL, Supavisor, PgBouncer, SSL enforcement, backup schedule, Realtime, PostgREST, Storage service configuration, custom hostname, vanity subdomain, and network restrictions are extracted with all transitive response schemas into `contracts/supabase-control-plane-contracts-2026-08-14.json`. `pnpm contracts:check` compares the subset with the hash-pinned current Management OpenAPI.
- Implemented: exact runtime validation and deterministic capture for the eleven matching registry components, with explicit 400/402/404 capability classifications only where the official endpoint defines the state. An unknown status or contract shape fails closed.
- Security decision: current official response schemas expose Supavisor/PgBouncer connection strings and an optional PostgREST `jwt_secret`. `database.pooler`, `database.pgbouncer`, and `rest.postgrest_config` are therefore corrected from `internal` to `secret`; their complete responses use the protected artifact sink and returned secret values are registered with the redactor before later processing.
- Focused result: PASS; lint, strict typecheck, five control-plane/registry tests, and current official contract drift checks pass. Live validation through pgDumpster's Management client remains gated on a safely injected PAT.

### 2026-08-14 — Direct managed-project adapter validation

- Credential handling: the user supplied a PAT through `.tmp/pgdumpster-e2e.env`; `.tmp/` is Git-, formatter-, and linter-ignored. The token was loaded only into process environment for each bounded test and was never printed or copied into fixtures, logs, plans, or tracked files.
- Project proof: Management API authentication through pgDumpster sees project `Test`, ref `xcprumxkpsapxdfnejdi`, status `ACTIVE_HEALTHY`, region `eu-west-3`.
- Live contract corrections: Realtime omits OpenAPI-required `private_only` at its default; Storage omits OpenAPI-required `databasePoolMode`; Auth omits OpenAPI-required `nimbus_oauth_email_optional`; valid live RFC 3339 timestamps use `+00:00` although several OpenAPI regexes only accept `Z`. These are narrow live-verified compatibility rules. All returned fields retain official type/format validation; unknown incompatible shapes still fail closed.
- Live control-plane result: PASS through pgDumpster for PostgreSQL config, Supavisor, PgBouncer, SSL, Realtime, PostgREST, Storage config, and network restrictions. Backup schedule, custom hostname, and vanity subdomain are explicitly `not_applicable` with `plan_not_entitled` on this project.
- Live sensitive-adapter result: PASS through pgDumpster for Auth, modern/legacy API keys, Edge Functions/secrets, and Vault root key. Auth correctly reports unexposed secret/signing material as `not_exportable`; SSO/TPA are `not_configured`; Edge function is `backed_up`, Edge secret remains digest-only `not_exportable`; API source values and Vault root key are captured only in protected ignored artifacts.
- Security result at this slice: no PAT, database password, API key, JWT secret, Edge secret source/digest, connection string, or Vault root key was emitted in command output. The later direct-validation decision supersedes the earlier password-rotation gate for this disposable project only.

### 2026-08-14 — Project state and diagnostics capture

- Current OpenAPI proof: project metadata, disk autoscale, billing add-ons, JIT access, branches, and service health operations plus their complete transitive response schemas are stored in `contracts/supabase-project-contracts-2026-08-14.json` and enforced by contract drift checks.
- Implemented: runtime-validated capture for `project.metadata`, `project.disk_autoscale`, `project.addons`, `project.jit_access`, `project.branches`, and `diagnostics.health`. Health requests now include the officially required complete `services` query; the JIT draft-2020-12 marker is normalized while its `oneOf`, required fields, enums, and closed-object rules remain enforced.
- Live result: PASS through pgDumpster. Metadata, add-ons, branches, and health are `backed_up`; disk autoscale is `not_configured`; JIT access is `not_applicable` from the live unavailable state. Seven focused project/doctor tests, lint, strict typecheck, and build pass.

### 2026-08-14 — Database live-E2E dependency probe

- Linked CLI proof: Supabase CLI v2.114.0 reached the linked Test project and began the remote role dump, but failed because Docker Desktop is unavailable. The probe output was zero bytes and is not accepted as a successful artifact.
- Host dependency result: `docker`, `pg_dump`, and `psql` are all absent from PATH. Current official documentation confirms that the Supabase CLI basisdump requires Docker and applies Supabase-specific filtering/role transformations that raw `pg_dump` does not reproduce. Docker is therefore mandatory for the basisdump; PostgreSQL 17 client tools remain required for documented restore/direct dedicated-state paths, not as a fictitious replacement for the filtered basisdump.
- Historical credential rule: the database password pasted into chat was unused at this probe. The user later explicitly waived rotation for this disposable test project; production guidance still requires local secret injection and forbids pasting credentials into chat or logs.
- Windows test-host result: Docker Desktop 4.86.0 / Docker CLI 29.7.2 was installed from the signed winget package. The daemon cannot start because firmware reports `VirtualizationFirmwareEnabled=false`; CPU VT-x and SLAT capabilities are present. Live database E2E remains pending BIOS/UEFI virtualization enablement and reboot.
- Distribution decision: pgDumpster depends on a reachable Docker-compatible daemon for the vendor backend but does not bundle Docker Desktop. Documentation calls out Docker Desktop's separate proprietary license and permits Linux Docker Engine/another daemon only when the active Supabase CLI compatibility is proven. A native backend remains unavailable until output and restore parity are proven; there is no silent fallback.

### 2026-08-14 â€” Linked WSL/Docker database backup validation

- Host result: Intel VMX was enabled in firmware; WSL `2.7.11.0` with kernel `6.18.33.2` and Docker Desktop `4.86.0` / Linux Engine `29.7.2` are live and reachable. Docker's initial `wsl is not installed` failure was resolved without weakening host security settings.
- Supply-chain decision: current CLI `2.114.0` was rejected by the repository's minimum-release-age policy. CLI `2.111.0` is the newest mature release at this gate, is exact-pinned as a development/E2E dependency, and passes lockfile policy. The external runtime CLI remains a documented prerequisite rather than a bundled production dependency.
- Credential/usability decision: live `supabase db dump --linked` and `supabase db query --linked --output json` obtain a short-lived login and succeed without a static database password. pgDumpster now supports exactly one database source mode: linked workspace (preferred) or direct connection URL (fallback). Ambiguous/missing modes fail closed; linked mode never injects `PGPASSWORD`.
- Contract hardening: linked query JSON is runtime-validated (`boundary`, `rows`, `warning`) before fixed inventory rows are normalized. Windows command discovery now supports both global npm shims and project-local `node_modules/.bin` npm/pnpm layouts without `shell: true`.
- Live adapter result on project `xcprumxkpsapxdfnejdi`: basis artifacts passed through pgDumpster (`database.roles` 370 bytes, `database.schema` 2402 bytes, `database.data` 9089 bytes). Inventory found 5 extensions, Auth 23 persistent tables, Storage 8, Vault 1, and no unclassified persistent schema.
- Dedicated-state result: `auth.data` 7702 bytes, `storage.file_metadata` 2115 bytes, and `database.vault_data` 944 bytes passed pgDumpster's no-empty/atomic publication checks. No `supabase_migrations`, Cron, or Queues schema is configured. Migration dumping is now capability-driven instead of treating a missing schema as an export failure.
- Linked catalog result: database publications/webhooks and File Storage bucket/object metadata now share the runtime-validated linked query transport. Live state is 1 publication, 0 publication members, 0 webhooks, 0 STANDARD buckets, and 0 objects.
- Concurrency finding: overlapping CLI `db query --linked` processes blocked on their temporary login-role lifecycle and one timed out at 120 seconds; the identical calls passed sequentially in 11.6 seconds. A process-wide bounded lane of 1 now serializes all linked queries. The original parallel caller passed live after the fix in 11.3 seconds.
- Focused validation: lint, strict typecheck, build, and 24 database/storage/process tests pass. This proves database capture adapters on the disposable source project; it does not yet prove final bundle composition or restore parity.

### 2026-08-14 - Project diagnostics and Management API v2 live validation

- Current-contract proof: project performance/security advisors and the project read-replica topology are runtime-validated from the pinned official v1 contracts. The current official Management API v2 document is separately pinned with source SHA-256 `6e0c9d8b71023edaa3d3abe066a781dc0645b64635e4896b3b2addf8103e691a`; log-drain and PrivateLink response subsets are extracted and checked for drift.
- Implemented: sanitized read-replica topology capture, read-only performance/security advisor capture, protected log-drain capture with recursive config-secret redaction, and ordinary PrivateLink association capture. Management transport accepts only exact fixed-origin `/v1/` and `/v2/` paths.
- 403 decision: the live log-drain GET returns 403 when the paid add-on is not selected. pgDumpster does not generalize that behavior: it classifies `not_configured` only when the separately runtime-validated billing response proves `log_drain` is available and absent from `selected_addons`; any ambiguous 403 remains a hard authorization failure.
- Live result on project `xcprumxkpsapxdfnejdi`: `project.read_replicas`, `project.log_drains`, and `network.private_link` are `not_configured`; performance and security advisor inventories are empty and captured under `diagnostics.readonly`. The correlated log-drain result records reason code `log_drain_addon_not_selected` and both source-contract hashes.
- Credential decision: the user explicitly designated this entire project as disposable test infrastructure and accepted the already-shared database password for that scope. Static password rotation is therefore not a gate for this project; linked CLI mode remains preferred because it avoids storing or passing that password.
- Focused validation: 13 Management transport/v2 tests, lint, strict typecheck, and build pass. The v1/v2/changelog/Storage contract drift gate also passes against current official sources.

### 2026-08-14 - Vector Storage and Analytics/Iceberg capability capture

- Current-contract proof: official Supabase documentation classifies Vector Storage and Analytics/Iceberg as alpha surfaces. Locked `@supabase/storage-js@2.111.0` exposes paginated Vector bucket/index/vector operations and Analytics bucket plus Iceberg REST catalog operations. The current Storage OpenAPI does not describe these alpha operations, so runtime schemas are derived from the current official SDK/reference and every response remains fail-closed.
- Data boundary: Vector `ListVectors` can return keys, float32 data, and metadata and is therefore fully exportable. The Iceberg REST catalog contains table metadata only; official Supabase guidance requires separately created S3 access/secret credentials to read the actual Parquet data from the S3-compatible endpoint. Catalog-only capture is never labeled full Analytics data backup.
- Implemented: complete pagination for Vector buckets, exact bucket/index detail capture, paginated protected vector pages with data+metadata, stable hashed artifact paths, cancellation, identity-drift and repeated-token defenses, Analytics bucket pagination, recursive namespace/table metadata capture, and explicit `failed` Analytics data coverage when a configured bucket lacks the separate S3 export path.
- Empty live result: all five specialized components are `not_configured` on the clean Test project. The real Storage endpoints accepted the captured privileged API key without exposing it in logs.
- Configured live Vector result: a temporary bucket, float32 index, and two metadata-bearing vectors were created, captured as `backed_up`, compared semantically using IEEE-754 float32 normalization, and deleted. Semantic parity passed and a post-cleanup listing found zero `pgdumpster-e2e-*` buckets.
- Focused validation: four specialized Storage tests, lint, strict typecheck, and build pass. Live Analytics data export/restore remains pending S3 credential lifecycle implementation and a configured fixture.

### 2026-08-14 - Complete backup composition and CLI live run

- Implemented: production backup composition across all current adapters, automatic privileged Storage credential discovery from revealed project API keys, linked/direct database source XOR, explicit plaintext-secret opt-in, local workspace output, checkpoint resume, optional deterministic `.tar.zst`, stable JSON final output, and registry/finalizer enforcement across exactly 55 top-level components.
- Credential correction: the first composed run selected a legacy `anon` JWT before a modern secret key and failed closed on Vector HTTP 403. Credential classification is now centralized; selection prioritizes a revealed modern `sb_secret_` key and accepts a legacy key only when its JWT role is `service_role`. A unit fixture proves an earlier-sorted legacy anon key cannot win.
- Resume proof: the failed composed run was resumed from its checkpoint. Previously completed database, Management, Edge, Auth, Vault, and File Storage steps were checksum-validated and skipped; the corrected specialized Storage step completed. Final result was 55 coverage entries, 47 verified bundle files, no `failed` component, and `complete_with_platform_limits` / `best_effort`.
- Archive proof: the resumed directory was deterministically packed as `pgdumpster-2026-08-14T01-50-20.856Z.tar.zst`; archive extraction and deep verification returned all 47 indexed files and all 55 coverage entries.
- Built CLI proof: `node dist/cli/main.js backup --project-ref xcprumxkpsapxdfnejdi --linked --output .tmp/cli-live-backups --consistency best-effort --allow-plaintext-secrets --archive --json` completed in 82.6 seconds. The emitted archive independently passed built `verify` with 47 files; built `coverage` reported 55 components, zero failed, and four explicit platform-limit entries.
- Honesty boundary: this build rejects `verified`/`quiesced` consistency, age encryption, and S3 destination publication with explicit errors because those production paths are not complete yet. It never relabels the working one-pass composition as verified consistency.
- Focused validation: backup CLI tests, Auth/API-key/Storage adapter tests, lint, strict typecheck, and build pass. Restore, cross-service stabilization, encrypted/S3 publication, full coverage threshold, and managed source-to-target parity remain open.

### 2026-08-14 - Restore plan and database executor foundation

- Implemented: runtime-validated deterministic 55-action restore plan, source-backup integrity prerequisite, source/target inequality, ordered phases/dependencies, conflict policy, exact/semantic/replacement/manual fidelity, explicit platform limits, manual actions, and billable-resource policy blocks. A failed source backup is rejected from standard restore.
- Built CLI dry-run proof: the live archive produced a 55-action plan for a distinct synthetic target ref without any target network call or mutation. It exposed 20 currently planned actions, four source platform limits/manual actions, and one apparent billable policy block.
- Classification correction: the apparent billable action was false because `project.addons` previously reported any successful inventory response as `backed_up`. The adapter now reports `not_configured` when the runtime-validated `selected_addons` list is empty; configured selections remain `backed_up`.
- Implemented: pinned-container `psql` executor using `public.ecr.aws/supabase/postgres:17.6.1.155`, verified-bundle containment, SQL-only artifacts, `ON_ERROR_STOP=1`, optional single transaction, shell-free argument arrays, bounded output/time, password-free database URL arguments, and password injection only through `PGPASSWORD`.
- Honesty boundary: `restore --apply` still fails before target mutation because the complete adapter graph and semantic parity verifier are not implemented. The dry-run command is real; apply is not claimed.
- Focused validation: restore plan/schema tests, source==target and billable-policy tests, database restore security/argument tests, project-state tests, lint, strict typecheck, and build pass.

### 2026-08-14 - Restore checkpoint hardening and live logical-database parity

- Implemented: atomic mode-0600 restore checkpoints bound to immutable plan SHA-256, backup operation, source ref, target ref, and exact action order. Action attempts and terminal fingerprints are preserved; completed actions are reverified on resume, and an interrupted/failed action is verified before retry so a crash after a successful mutation does not blindly duplicate it.
- Safety correction: all planned dependencies and all required handlers are preflighted before the first checkpoint or mutation. Unknown dependencies, cycles, planned dependencies blocked by a platform limit, and missing adapters fail before target state changes. Interruption/resume, crash-after-apply recovery, plan/target drift, missing adapter, dependency cycle, and semantic-parity failure tests pass.
- Current connection contract: official Supabase guidance recommends the Session Pooler on IPv4-only networks. The direct target hostname was IPv6-only from this host; Management pooler discovery identified `aws-1-eu-west-1.pooler.supabase.com`, and the target connection passed through Session Pooler port 5432 with user `postgres.lssgyqwmsitpwzqttuoy`. Credentials remained environment-only.
- Critical scope correction: the CLI's data-only basis dump included `auth.*` and `storage.*`, overlapping dedicated adapters. Repeated `--exclude` flags and comma-separated wildcard excludes were both live-proven ineffective with CLI 2.111.0 despite the dry-run translation. Base data capture now uses an inventory-derived positive `--schema` allowlist containing only `base_dump` schemas. Supabase-managed `pgbouncer`, `_analytics`, `_realtime`, `_supavisor`, Timescale, and other current internal schemas are explicitly classified as managed runtime. The live canary now reports only `public`, a 728-byte basis data dump, and zero dedicated-schema statements.
- Queue/storage flag correction: current CLI help declares `--schema` and `--exclude` as single string flags. Multi-schema Queue capture now passes one comma-separated schema value, and the two Vector metadata exclusions use one comma-separated value. Unit tests enforce the exact argument shape.
- Archive evidence: corrected built CLI backup run `fd16bd26-6fef-4fe8-99d6-50f55ad8cde5` produced `pgdumpster-2026-08-14T02-34-16.249Z.tar.zst`, result `complete_with_platform_limits` / `best_effort`, 55 coverage entries, and 47 independently verified files. `database.data` is 728 bytes with zero dedicated-schema COPY/INSERT statements; empty `project.addons` is correctly `not_configured`. Two earlier local archives are retained only as regression evidence and are not valid restore sources because their basis data scope overlaps dedicated dumps.
- Role compatibility decision: live `psql --single-transaction` rejected the platform-owned `GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin`. pgDumpster preserves the original role artifact, omits only two exact known platform-owned grant statements in a protected derived execution file (the live parameter grant and Supabase's documented `cli_login_postgres` grant), and still compares a complete target role re-dump against the unfiltered source fingerprint. Any missing semantic target state therefore fails rather than being silently omitted.
- Live target result: on clean target `lssgyqwmsitpwzqttuoy`, the ordered extensions, roles, schema, and base-data actions all applied and independently passed target re-dump/fingerprint parity. Fingerprints were respectively `31048a143d08c49b868c4a3a9e2962e2e54d6ae1d3470cf44eb22178cf1c3c51`, `168a95a9c745af5ed4679751f90419ac9dc434240a213b03e32a06d5664c2308`, `9ce7bb5dbf67dec8193c9d9d4504fcff43e82b19f4ed5e2ca3a74f79170192b7`, and `3e857d2eb3ebf1789439700493f89c3dd7dc7dcb5e1ce26e5fb775a148da4929`.
- Leakage incident and rule: a manual Supabase CLI `db dump --dry-run --debug` probe printed a short-lived CLI login credential in its generated shell script. No static project password, PAT, archive secret, or product output was exposed, but this still violates the test-output policy. Debug dry-run is prohibited for future credentialed probes; subsequent validation used ordinary commands and sanitized pgDumpster boundaries. The final secret-leakage gate remains unfulfilled until the complete test matrix proves no recurrence.
- Local validation: focused restore/dump/inventory suites, strict typecheck, lint, and build pass. This is real live parity for four logical database components, not complete restore; Auth/Vault/dedicated database state, managed-schema deltas, publications, Storage, Edge, Auth/control-plane, API-key rotation, full report, and full source-to-target E2E remain open.

### 2026-08-14 - Managed-schema delta correction and canonical v4 archive

- Contract correction: `supabase db diff --linked --schema auth,storage --output <path>` writes a SQL file only when a diff exists; status JSON is emitted on stdout and operational progress on stderr. pgDumpster no longer parses either stream as the diff. It accepts only a bounded real non-symlink output file, atomically publishes the artifact, treats an absent file as `not_configured`, and rejects empty/invalid/oversized files.
- Command-discovery correction: the earlier live adapter process selected global Supabase CLI `2.101.0` from PATH while `npx` selected the repository-pinned `2.111.0`. Command discovery now deterministically prefers a readable project-local `node_modules/supabase/dist/supabase.js` on every OS and remains shell-free. `doctor` and the compatibility guide now enforce the actually validated range `>=2.111.0 <3.0.0`; 2.101.0 is explicitly rejected.
- Live managed-schema result: the locked CLI 2.111.0 completed the isolated Auth/Storage diff in 38.7 seconds and produced zero artifacts on the clean source. A configured artifact path is unit-proven. A live canary cannot be created through current hosted user credentials: `postgres` has no `CREATE` privilege on `auth` or `storage`, does not own `auth.users`, and cannot `SET ROLE supabase_auth_admin`. pgDumpster records this as a fixture-creation limitation rather than fabricating configured live success; historically existing customizations remain exportable through the official diff.
- Vault correction: inventory now counts exact `vault.secrets` rows. Empty Vault state is `not_configured`; configured ciphertext rows are captured exactly, but current hosted target `postgres` cannot insert into the `supabase_admin`-owned table and current Vault functions generate new identifiers/ciphertext. Configured Vault data is therefore marked non-identically-restorable with an actionable platform-limit report instead of claiming exact restore. The independently exportable root key remains exact and was live-restored/read back earlier.
- Canonical source archive: run `3effb137-0b24-44d2-bde8-efaf93a23b1f` produced `pgdumpster-2026-08-14T03-30-45.148Z.tar.zst`, result `complete_with_platform_limits` / `best_effort`, 55 coverage entries, 44 files, 93,943 indexed bytes, zero failed components, and four explicit platform-limit components. Built deep verify passed all 44 indexed files. `database.auth_storage_customizations` and `database.vault_data` are both correctly `not_configured`.
- Target dry-run: the canonical archive produced a 55-action plan for target `lssgyqwmsitpwzqttuoy`, status `ready_with_platform_limits`. Both empty database surfaces are skipped as not applicable; the only manual platform-limit actions are Auth config, Auth modern/legacy signing material, and Edge secret values. No mutation occurred during dry-run.
- Focused validation: 22 doctor/process/database-dump tests, strict typecheck, lint, and build pass. The complete restore-handler graph, mutation report, configured service fixtures, encrypted/S3 publication, full suite/coverage/security matrix, and final clean-target E2E remain open.

## Known platform limits

Only verified limits belong here. Every runtime instance must map to a coverage component and actionable reason code.

- Cross-service point-in-time atomicity is unavailable across PostgreSQL, Storage bytes, Edge deployments, and control-plane APIs. pgDumpster provides observed pre/post consistency with bounded stabilization, never a fictitious transaction.
- Deployed Edge Function export is not automatically the original source repository. Live CLI v2.114.0 returned the fixture's `deno.json` and `index.ts` byte-identically despite the official migration guide's omission warning, so pgDumpster backs up the complete exposed deployed representation without claiming original-repository fidelity.
- Database-only clone/restore does not copy File Storage bytes/settings, Edge Functions, Auth settings/API keys, Realtime settings, database extensions/settings, or replicas; dedicated adapters are required.
- Modern Auth signing-key private material and the legacy shared signing secret are not exposed by the current official read schemas. pgDumpster preserves public/lifecycle metadata and reports the missing exact material as `not_exportable`; live restore semantics remain pending.
- Modern API-key source values are revealable when authorized, but the current create contract cannot import the same opaque value. Exact target identity is a verified platform limit; safe restore requires target-generated replacements and a protected rotation map.
- Configured Vault ciphertext rows are exportable exactly, but current hosted target credentials cannot insert into the platform-owned `vault.secrets` relation and the exposed functions generate new identifiers/ciphertext. Exact configured Vault-data identity is therefore not currently restorable through a supported contract; root-key restoration remains independently exact.
- Analytics data and other platform-limit classifications remain pending current OpenAPI plus live validation and must not be presumed.

## Outcomes and retrospective

Not complete. Foundation, offline bundle/archive integrity, authenticated preflight, and initial database capture slices pass locally. Most adapters, encryption/destinations/resume, restore, hosted CI/security matrix, and the required live managed-Supabase E2E/parity gate remain pending.

### 2026-08-14 — Realtime postgres_changes_pool contract drift

- Official Management API v1 OpenAPI changed from SHA-256 `846aef2b9188ae843d8f782cc7f7ee1bed9dde63ba0ff8fc511d9627c98ea751` to `6f0d585db14bb6b601b0e6d1bbd5af8be37c1ee1c91411c097f3c4764c6d73a4`.
- Semantic subset comparison showed Auth, Project, API key and Edge unchanged; the control-plane subset changed because Realtime added `postgres_changes_pool`.
- Current OpenAPI defines `RealtimeConfigResponse.postgres_changes_pool` as required, nullable, integer 1–100 and adds the same writable field to `UpdateRealtimeConfigBody`.
- Live GET observations against both dedicated hosted Supabase source and target test projects on 2026-08-14 returned the property as absent, not null.
- Runtime validation therefore treats `postgres_changes_pool` as live-verified optional on GET while preserving the current OpenAPI write contract.
- Restore fixture coverage proves a backed-up non-null `postgres_changes_pool` value is included in the Realtime PATCH body and semantic parity comparison.
- `pnpm contracts:check` PASS against the updated official v1 contract baseline.
- `pnpm check` PASS: 41 test files, 166 tests.
- `pnpm test:coverage` remains a separate release blocker at 82.29% statements, 72.50% branches, 77.68% functions and 83.47% lines versus the configured 90% global thresholds.
