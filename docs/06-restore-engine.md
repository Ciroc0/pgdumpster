# Restore engine

## Principle

A backup is not professionally useful until its restore path has been implemented and proven. Restore targets a **different hosted Supabase project** by default. Standard restore refuses source==target.

## Current implementation status

As of 2026-08-16:

- bundle verification precedes restore planning;
- deterministic restore-plan generation exists;
- restore checkpoints and a resumable executor exist in core modules;
- database, control-plane, publication and Vault root-key handlers exist with semantic verification behavior;
- conflict and billable-resource policy are represented in the plan;
- the CLI exposes `--dry-run` and guarded `--apply`;
- `--apply` executes only from a verified bundle root and rejects a blocked plan before reading target credentials or discovering target resources. For an executable plan, it acquires the target database URL and Management credential only when an actually planned handler requires each credential; it atomically persists the immutable plan with restrictive permissions before executor checkpoint/mutation, rejects unsupported planned components and unsafe/missing planned artifacts, and uses the checkpointed executor for supported actions.

This is not a release-completeness claim. Final parity reporting is implemented and a disposable hosted source-to-target database/File Storage observation exists; the required protected full-fixture hosted validation remains incomplete.

The remaining sections describe the **binding target restore contract**. They must not be read as a claim that unsupported platform/manual-limit components are automatically restorable.

## Commands

Current/target syntax uses an environment-variable name for the database URL so the secret itself is not placed on the command line.

Dry run:

```bash
pgdumpster restore ./pgdumpster-<UTC>.tar.zst \
  --target-project-ref <target-ref> \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

Target apply form:

```bash
pgdumpster restore ./pgdumpster-<UTC>.tar.zst \
  --target-project-ref <target-ref> \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --apply
```

Mutation may never be inferred from an interactive confirmation; explicit `--apply` remains mandatory.

## Preconditions before mutation

1. verify archive/bundle integrity and schemas;
2. decrypt/protect sensitive payload workspace when encrypted bundles are supported;
3. run target preflight/doctor-equivalent capability checks;
4. reject source==target;
5. identify incompatible target state;
6. calculate the exact deterministic restore graph;
7. show non-restorable/manual actions and platform substitutions;
8. identify billable operations;
9. persist the plan/checkpoint before mutation.

Default conflict policy is `fail`.

## Restore action graph

Every action records an id, component, phase, operation, risk, billable flag, dependencies, source status, restore policy, fidelity and artifact references. The executor validates adapters/dependencies/cycles before mutation and verifies completed work when resuming.

## Required ordering

### 1. Target discovery and compatibility

Check target project/API/database/extension/plan capabilities and credentials. Do not mutate on incompatible prerequisites.

### 2. Prerequisite extensions and service/database state

Enable compatible required target features/extensions before dependent SQL. Do not blindly copy extension-owned schemas or create billable infrastructure.

### 3. Vault root key

When required, apply the backed-up root key before dependent Vault ciphertext. Replacement is refused when target Vault emptiness cannot be proven. Secret values never belong in logs/output.

### 4. Database roles

Restore role definitions with explicit handling for password material that the source dump cannot reproduce exactly.

### 5. Database schema

Apply schema with strict failure behavior (`ON_ERROR_STOP` or equivalent supported mechanism) and sanitized errors.

### 6. Database user data

Restore normal application data without bulldozing target-managed platform state.

### 7. Auth and persistent extension data

Restore dedicated `auth.data`, Vault ciphertext, Cron, Queues, Database Webhooks and other captured persistent extension state through their supported semantics and prerequisites.

### 8. Migration history and managed-schema customizations

Restore only the project-owned/custom deltas captured separately from platform-managed objects.

### 9. Realtime publication state

Restore/verify publication and table membership after database state exists.

### 10. Storage service and File buckets

Restore service/bucket configuration with deterministic conflict handling. Never silently alter public/private, MIME or size-limit semantics.

### 11. File Storage objects

Stream-upload every logical `(bucket,key)`, preserve supported metadata, verify source checksum before upload and target parity afterward.

### 12. Vector / Analytics

Restore only where a complete documented/exportable path exists. Source `not_exportable` remains a visible platform limitation.

### 13. Edge secrets

Restore supported secret values/substitutions before dependent functions and never print them.

### 14. Edge Functions

The Management API's captured deployed body is not a deployable source-tree input: a live probe was rejected for missing deployment metadata/entrypoint material. pgDumpster therefore captures the Supabase CLI `functions download --use-api` source tree, validates every regular file/checksum/path, reconstructs an isolated `supabase/` workdir with per-function `config.toml`, and deploys through `functions deploy --use-api`. Target semantic metadata/inventory is then verified. This is not a claim to recover original Git repository artifacts that Supabase did not expose. A current managed-project source-to-target proof remains required.

### 15. Auth configuration

Apply supported service config/SSO/TPA settings. External OAuth/SMTP/provider-side resources remain manual actions.

### 16. Signing state

Recreate only what the platform permits. Non-exportable private material means exact cryptographic/session continuity cannot be claimed.

### 17. API keys

Where target APIs generate replacement secrets, create equivalent definitions and produce a **protected** source-to-target rotation mapping. Exact secret equality is not a success condition when import is impossible.

### 18. Realtime/PostgREST/Storage control plane

Apply writable service configuration and verify normalized semantic equivalence.

### 19. Networking/domains/private connectivity

Apply late to avoid locking the restore process out. External DNS prerequisites are manual actions.

### 20. Billable resources

Potentially chargeable resources require explicit `--allow-billable-resources`; otherwise they remain planned/blocked by policy rather than being created silently.

### 21. Semantic parity

A restore is not successful because requests returned 2xx. Compare backed-up intent with target database, Storage, Edge, Auth/service config, project/network config, substitutions and explicit platform limits.

Target protected/report outputs include the deterministic plan, result, parity report, manual actions and protected rotation map.

## Conflict policy

Supported top-level policies:

- `fail` — default;
- `replace` — only for adapters with explicit safe/tested replacement semantics.

There is no vague global merge mode.

## Rollback model

pgDumpster does not claim atomic rollback across PostgreSQL, Storage and Management APIs. The normal safety model is a fresh target, action/checkpoint logging, stop-on-hard-failure and deterministic resume/cleanup guidance. It does not automatically delete an existing target project.

## Idempotency and resume

Adapters compare before mutation where practical, tolerate exact existing state, fail on incompatible state and revalidate already completed actions when resuming. A completed checkpoint action must still semantically verify before it is trusted.

## Restore result

A restore may be:

- `restored` — all applicable restorable state semantically verified;
- `restored_with_platform_limits` — all possible work succeeded with explicit source/platform limitations or substitutions;
- `failed` — a required possible operation/parity check failed.

The final hosted E2E in `docs/10-testing.md` remains mandatory proof before this restore path can be considered release-complete.
