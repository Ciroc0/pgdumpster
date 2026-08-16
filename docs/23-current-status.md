# 23 — Current implementation status

This document is a **status snapshot**, not a replacement for the binding product requirements. When it conflicts with a higher-priority specification, the specification wins and the difference is a remaining implementation task.

Snapshot date: **2026-08-16**.

## Validation summary

Latest complete local validation after live-restore regression hardening:

- `pnpm check`: **PASS**;
- test files: **116 passed**;
- tests: **726 passed**;
- statements: **94.61%**;
- branches: **90.04%**;
- functions: **92.55%**;
- lines: **95.65%**.

All independent repository coverage thresholds remain at 90% and pass. No production file was excluded and no threshold was lowered to recover coverage.

Current official Supabase/OpenAPI, Storage and changelog contract snapshots match. A consumer installation of the generated development `.tgz` passed `--version`, `doctor --help` and `restore --help`; it is local package-smoke evidence, not a public publish/release claim.

GitHub Actions quota is currently exhausted for the account, so newly pushed workflow runs are expected to be blocked by quota until reset. That is not a meaningful remote quality signal for the current branch; local `pnpm check` and `pnpm test:coverage` are the active gates in the meantime. Earlier regular CI passed its quality/test/integration/security and Ubuntu/macOS/Windows Node 22/24 matrix checkpoint.

CodeQL previously reached analysis/SARIF generation, but GitHub could not publish the result because code scanning was not enabled/accessible to the repository integration. This remains a repository configuration gate, not evidence that the static-analysis result is clean.

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
- Edge Function deployed-representation capture and secret inventory;
- Vault root-key capture and guarded restore handler;
- project/add-on/branch/health/advisor/database/service/network/domain/private-link/log-drain/JIT related control-plane coverage;
- CLI commands for `doctor`, `backup`, `inspect`, `coverage`, `verify`, restore dry-run, `--help` and `--version`;
- cross-platform GitHub CI and contract-drift workflow.

## Current user-facing runtime limits

These are the remaining deliberate fail-closed gates in the current CLI:

- **Backup consistency**: `verified`, `best-effort` and `quiesced` are implemented. Backup defaults to `verified`. This is an application-level stabilization contract across the source surfaces pgDumpster can observe; it is not a claim that Supabase exposes one atomic cross-service snapshot transaction.
- **Secret protection**: standard `age` encryption is implemented for local backup publication. Non-encrypted secret-bearing backups still require explicit `--allow-plaintext-secrets`.
- **Encrypted input**: `.tar.zst.age` is supported by inspect/coverage/verify and restore dry-run when config supplies `encryption.identityFile`. pgDumpster never needs the private key value as a CLI argument.
- **Destination**: local and configured S3-compatible destinations are exposed. S3 uses resumable multipart publication, writes a completion marker last and independently verifies the referenced remote object; a scoped Cloudflare R2 provider passed encrypted publication, marker and materialized offline verification.
- **Restore**: integrity-first dry-run planning and the checkpointed executor are exposed through CLI `--apply`. A blocked plan is rejected before target credential/resource discovery; executable plans derive database, Management and privileged Storage credential needs from planned automatic capabilities. The CLI validates all planned handlers and artifacts, then atomically persists the immutable plan, checkpoint and final parity report with restrictive permissions around mutation. Auth config, SSO, Third-party Auth and legacy API-key state have current-contract handlers; modern API keys create replacements and a local `0600` protected rotation map. SSO/TPA default to no-mutation conflict failure and require explicit `--conflict replace` for scoped delete/recreate. Read-only PgBouncer, backup-schedule, custom-hostname/vanity-subdomain, Analytics metadata/data, disk/autoscale, add-ons, read replicas, log-drains, PrivateLink and JIT-access sources are explicit platform limits until a current documented mutation contract and semantic handler exist. It fails closed for any unimplemented planned component.
- **Hosted E2E**: disposable-source encrypted backup, offline verify and clean-target restore completed as `restored_with_platform_limits`. Database checks verified account/job counts, enum, RLS, trigger/checksum behavior and Realtime publication after resume recovery. A current read-only source/target smoke confirmed matching fixture state: 2 accounts, 2 jobs, 2 valid trigger-derived checksums, 2 RLS policies, 1 user trigger and 1 Realtime table membership. A separate private Storage bucket/object fixture was also restored and directly verified by target API metadata/size. `live-e2e.yml` now automates the protected encrypted database recovery sequence with distinct-ref/clean-target guards and sanitized output; it still requires its first protected Environment execution. Cloudflare R2 S3 interoperability passed; protected current-candidate evidence remains pending.
- **CodeQL**: analysis has run, but result publication remains blocked on repository configuration/access. Any eventual findings must still be dispositioned.
- **Release**: normal CI exists. `.github/workflows/release.yml` is implemented for public npm trusted publishing through GitHub Actions OIDC, CI-built package smoke, CycloneDX SBOM, SHA-256 checksums, GitHub artifact attestation and GitHub Releases. It deliberately rejects the current private `0.0.0-development` package, and has not run for a valid release tag. Current-candidate CI/CodeQL, protected release-candidate E2E, trusted-publisher setup, tag/version/changelog finalization and published-artifact verification remain required.

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

The repository contains dated official-contract snapshots and runtime validation for the Management API surfaces used by adapters. The hosted encrypted backup, offline verification, clean-target database/File Storage restore and applicable semantic-parity observation have passed on disposable projects, with non-exportable hosted surfaces reported as platform limits. This is not equivalent to a protected, tagged release-candidate E2E run.

No documentation should describe the full hosted source-to-target recovery gate as passed until the exact procedure in `docs/10-testing.md` succeeds.

## Remaining implementation order

The shortest safe path to the release gate is:

1. establish the remaining provider-scale/performance evidence required by `docs/10-testing.md`;
2. execute the protected current-candidate hosted E2E and resolve any executable fidelity gap without weakening fail-closed behavior;
3. fix the GitHub CodeQL repository-setting blocker, disposition any findings and rerun current-candidate CI;
4. configure npm trusted publishing, finalize version/changelog and run the tagged release workflow;
5. verify the published artifact, then complete the final documentation/acceptance audit.

## Definition of done

Coverage thresholds, local tests, individual live endpoint observations and green ordinary CI are necessary evidence but are not the final release gate.

The product is complete only when every applicable item in `docs/13-acceptance-criteria.md` is evidenced and the live hosted E2E/parity gate is green.
