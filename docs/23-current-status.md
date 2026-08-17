# 23 - Current implementation status

This document is a **status snapshot**, not a replacement for the binding product requirements. When it conflicts with a higher-priority specification, the specification wins and the difference is a remaining implementation task.

Snapshot date: **2026-08-16**.

## Validation summary

Latest complete local validation after Edge Function source-tree restore hardening:

- `pnpm check`: **PASS**;
- test files: **118 passed**;
- tests: **761 passed**;
- statements: **94.47%**;
- branches: **90.02%**;
- functions: **92.66%**;
- lines: **95.44%**.

All independent repository coverage thresholds remain at 90% and pass. No production file was excluded and no threshold was lowered to recover coverage.

Current official Supabase/OpenAPI, Storage and changelog contract snapshots match. A consumer installation of the generated development `.tgz` passed `--version`, `doctor --help`, `backup --help` and `restore --help`; it is local package-smoke evidence, not a public publish/release claim.

A current read-only `npm pack --dry-run --json` audit reports 372 package files with compiled CLI, contracts and schemas included and no test/docs/scripts/workflow paths. `v0.1.2` published this package; the audit records package contents rather than a future-release claim.

Release SHA `dd0d42c128907de473f71024196a62da2f124bcb` passed GitHub CI, CodeQL, official-contract drift and protected Live hosted E2E on 2026-08-16. CI run `31979435085` includes quality/test/integration/security and Ubuntu/macOS/Windows Node 22/24; CodeQL run `31979435100`, contract-drift run `31979441181` and protected E2E run `31979442398` passed before the `v0.1.2` release run `31979898052` published the package. A future candidate must repeat all four gates for its own exact SHA.

## Implemented repository slices

The implementation currently includes:

- strict TypeScript ESM, locked dependencies, build/lint/format/test tooling;
- stable domain errors, redaction and secret-value handling;
- 55-component data-driven coverage registry and final-result semantics;
- secure ordinary/protected artifact sinks;
- deterministic bundle finalization, SHA-256 verification, inspect/coverage/verify;
- deterministic `.tar.zst` packing and hostile archive protections;
- standard `age` archive encryption/decryption through a shell-free subprocess wrapper;
- atomic `.tar.zst.age` publication with restrictive permissions and cleanup of temporary output;
- encrypted backup CLI publication that removes plaintext archive/workspace after success and attempts the same cleanup on encryption failure;
- `.tar.zst.age` input for inspect/coverage/verify and restore dry-run through configured `encryption.identityFile`;
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
- Auth config restore through a current Management API PATCH contract (excluding non-exportable masked secret fields), Cron, Queues, Vault, publications and Database Webhook coverage;
- File Storage catalog + streamed content-addressed object capture;
- specialized Vector and Analytics/Iceberg capability handling with explicit platform-limit semantics;
- Management API client, contract snapshots/runtime validation and control-plane adapters;
- deterministic queued Management API fault simulator for latency, reset, 429, stale ETag and eventual-consistency scenarios;
- Auth config/SSO/TPA/signing-key capture;
- modern/legacy API-key capture and target replacement/rotation semantics;
- Edge Function metadata/secret inventory plus guarded CLI-source-tree capture and deploy handler; managed source-to-target deployment and invocation evidence passed;
- Vault root-key capture and guarded restore handler;
- project/add-on/branch/health/advisor/database/service/network/domain/private-link/log-drain/JIT related control-plane coverage;
- CLI commands for `doctor`, `backup`, `inspect`, `coverage`, `verify`, restore dry-run, `--help` and `--version`;
- cross-platform GitHub CI and contract-drift workflow.

## Current user-facing runtime limits

These are the remaining deliberate fail-closed gates in the current CLI:

- **Backup consistency**: `verified`, `best-effort` and `quiesced` are implemented. Backup defaults to `verified`. This is an application-level stabilization contract across the source surfaces pgDumpster can observe; it is not a claim that Supabase exposes one atomic cross-service snapshot transaction.
- **Secret protection**: standard `age` encryption is implemented for local backup publication. Non-encrypted secret-bearing backups still require explicit `--allow-plaintext-secrets`.
- **Encrypted input**: `.tar.zst.age` is supported by inspect/coverage/verify and restore dry-run when config supplies `encryption.identityFile`. pgDumpster never needs the private key value as a CLI argument.
- **Destination**: local and configured S3-compatible destinations are exposed. S3 uses resumable multipart publication, writes a completion marker last and independently verifies the referenced remote object; a scoped Cloudflare R2 provider passed encrypted publication, marker and materialized offline verification. The latest disposable 128 MiB multipart baseline completed at 13.61 MiB/s with 34 requests, zero observed retries, 154,140,672-byte peak RSS and observed checkpoint-state persistence; its object/marker were removed. Comparative provider fault injection is optional additional confidence evidence.
- **Restore**: integrity-first dry-run planning and the checkpointed executor are exposed through CLI `--apply`. A blocked plan is rejected before target credential/resource discovery; executable plans derive database, Management and privileged Storage credential needs from planned automatic capabilities. The CLI validates all planned handlers and artifacts, then atomically persists the immutable plan, checkpoint and final parity report with restrictive permissions around mutation. Auth config, SSO, Third-party Auth and legacy API-key state have current-contract handlers; modern API keys create replacements and a local `0600` protected rotation map. SSO/TPA default to no-mutation conflict failure and require explicit `--conflict replace` for scoped delete/recreate. Edge Functions archive a CLI-downloaded source tree with safe paths and checksums, reconstruct an isolated workdir and deploy through the current supported CLI path; the invalid Management API deployed body is never used as deployment input. Read-only PgBouncer, backup-schedule, custom-hostname/vanity-subdomain, Analytics metadata/data, disk/autoscale, add-ons, read replicas, log-drains, PrivateLink and JIT-access sources are explicit platform limits until a current documented mutation contract and semantic handler exist. It fails closed for any unimplemented planned component.
- **Hosted E2E**: local execution and the protected GitHub Environment run for release SHA `dd0d42c128907de473f71024196a62da2f124bcb` completed with backup `complete_with_platform_limits`, offline verification `verified`, restore/parity `restored_with_platform_limits`, 55 terminal coverage components, 20 verified planned restore actions, matching database, direct stream-hashed private Storage, restored Auth password login and restored Edge Function invocation smokes. Supabase returns worker-local `file:///tmp/...` metadata after deploy; this is normalized as non-portable while the CLI-downloaded source tree remains the deploy authority. PgBouncer, Auth secret/signing and Edge-secret-digest remain manual/platform limits. A future release candidate must repeat the protected run. Cloudflare R2 S3 interoperability passed.
- **CodeQL**: release SHA `dd0d42c128907de473f71024196a62da2f124bcb` passed CodeQL run `31979435100`. This exact-SHA evidence is not transferable to a future candidate.
- **Release**: `v0.1.2` is published. `.github/workflows/release.yml` uses GitHub Actions OIDC trusted publishing, CI-built package smoke, a CycloneDX SBOM generated from a fresh production installation of that package, SHA-256 checksums, GitHub artifact attestation and GitHub Releases. It requires a public repository, a non-private SemVer package, its release SHA on `origin/main`, and successful CI, CodeQL and protected Live hosted E2E runs for that exact SHA. It downloads, integrity-verifies and fresh-installs the published package after npm publish. The `NPM_TOKEN` bootstrap secret has been removed.

## Current CLI surface

Implemented global options:

```text
--config <path>
--json
--non-interactive
--version
--help
```

Implemented commands:

```text
pgdumpster doctor [--project-ref <ref>] [--json]
pgdumpster backup --project-ref <ref> (--linked|--db-url-env <name>) [options]
pgdumpster inspect <bundle-directory|archive.tar.zst|archive.tar.zst.age> [--json]
pgdumpster coverage <bundle-directory|archive.tar.zst|archive.tar.zst.age> [--json]
pgdumpster verify <bundle-directory|archive.tar.zst|archive.tar.zst.age> [--json]
pgdumpster restore <bundle-directory|archive.tar.zst|archive.tar.zst.age> --target-project-ref <ref> --target-db-url-env <name> (--dry-run|--apply)
```

Backup consistency accepts `verified|best-effort|quiesced`; omitted consistency defaults to `verified`. Best-effort output distinguishes `best_effort` from `drift_detected`.

For `encryption.mode: age`, backup requires `encryption.recipient`, automatically produces the deterministic archive transport form, encrypts it as `.tar.zst.age`, and removes normal plaintext staging after successful publication. `--archive` is therefore not required separately for an encrypted backup.

`doctor` probes `age --version`. If the executable is missing when encryption/decryption is attempted, the runtime maps that failure to the dependency error domain. The backup command does not currently duplicate the `doctor` probe before source capture, so operators should keep `doctor` as the intended preflight step. A hard process termination can still leave the protected resumable workspace/checkpoint; crash recovery is separate from normal encryption cleanup.

`restore --apply` performs target credential preflight and handler-completeness validation. A plan with an unsupported planned component fails before mutation with `RESTORE_ADAPTER_MISSING`; a fully supported plan proceeds through the existing checkpointed executor. `--resume <checkpoint>` rereads the checkpoint-bound immutable plan, verifies its hash and bindings, and does not rewrite it.

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

The repository contains dated official-contract snapshots and runtime validation for the Management API surfaces used by adapters. The hosted encrypted backup, offline verification, clean-target database/File Storage restore, restored Auth password login and applicable semantic-parity observation have passed on disposable projects, with non-exportable hosted surfaces reported as platform limits. The protected, tagged release-candidate E2E also passed for `v0.1.2`.

The protected `v0.1.2` run proves the full hosted source-to-target recovery procedure for its SHA; a newer release candidate must not inherit that evidence.

## Release-gate status

R2/S3 interoperability and performance evidence are complete. `v0.1.2` passed its exact-SHA CI, CodeQL, official-contract drift and protected `release-e2e`, then published with package/SBOM/checksum/attestation/GitHub Release evidence. GitHub OIDC trusted publishing is configured and the temporary bootstrap token is removed.

No unfulfilled release gate remains for `v0.1.2`. Every future release must repeat the exact-SHA gates.

## Definition of done

Coverage thresholds, local tests, individual live endpoint observations and green ordinary CI are necessary evidence but are not the final release gate.

The product is complete only when every applicable item in `docs/13-acceptance-criteria.md` is evidenced and the live hosted E2E/parity gate is green.
