# Restore engine

## Principle

A backup is not considered professionally useful until its restore path has been implemented and tested.

Restore targets a **different hosted Supabase project** by default. Restoring into the source project is refused unless a future explicitly designed in-place recovery mode can prove safety.

## Commands

Dry run:

```bash
pgdumpster restore ./pgdumpster-<UTC>.tar.zst \
  --target-project-ref targetref \
  --target-db-url "$TARGET_DB_URL" \
  --dry-run
```

Apply:

```bash
pgdumpster restore ./pgdumpster-<UTC>.tar.zst \
  --target-project-ref targetref \
  --target-db-url "$TARGET_DB_URL" \
  --apply
```

The CLI must not infer `--apply` from an interactive confirmation. Destructive mutation requires an explicit flag.

## Preconditions

Before mutation:

1. verify bundle integrity;
2. verify manifest/coverage schema;
3. decrypt sensitive payload in-memory/temporary protected workspace;
4. run `doctor` against target;
5. ensure source project ref != target project ref;
6. identify incompatible target state;
7. calculate exact restore plan;
8. show non-restorable/manual actions;
9. detect billable operations;
10. write a dry-run report.

Default conflict policy is `fail`.

## Restore plan

The plan is deterministic and represented as machine-readable JSON.

Each action includes:

```json
{
  "id": "storage.bucket.create:avatars",
  "component": "storage.file_buckets",
  "operation": "create",
  "risk": "mutation",
  "billable": false,
  "dependsOn": [],
  "status": "planned"
}
```

The executor is a dependency graph, not a pile of sequential shell commands.

## Required restore ordering

### Phase 1 — target discovery and compatibility

- project metadata;
- target region/Postgres compatibility;
- target extension availability;
- target API capabilities;
- target plan limitations;
- restore credential permissions.

Do not mutate on incompatible prerequisites.

### Phase 2 — prerequisite extensions and service/database state

Inventory the source extension set and enable compatible required target extensions/features before dependent SQL is applied.

At minimum, plan explicit prerequisites for:

- Auth-managed schema behavior;
- Database Webhooks / `pg_net` as required;
- `pg_cron`;
- `pgmq`;
- Vault/pgsodium or its current platform successor;
- any other installed extension with backed-up persistent state.

Do not copy an extension-owned schema blindly before the extension exists. Do not enable expensive/billable resources automatically.

### Phase 3 — Vault/pgsodium root key

If the backup contains a Vault/pgsodium root key, apply it **before restoring database state whose encrypted values depend on it**.

Rules:

- no logging;
- no stdout;
- no debug serialization;
- target confirmation through a non-secret fingerprint only.

A missing required root key is a hard restore blocker unless the user explicitly elects a documented partial restore mode; full restore remains incomplete.

### Phase 4 — database roles

Restore `roles.sql`.

Known limitation: custom LOGIN role passwords are not reliably represented by the normal dump workflow. Emit a required manual/rotation action for any such role rather than fabricating a password.

### Phase 5 — database schema

Restore schema using `psql`/Supabase-supported workflow with strict failure behavior:

- `ON_ERROR_STOP=1`;
- single transaction where compatible;
- capture sanitized errors;
- do not continue after schema failure.

### Phase 6 — database user data

Restore normal user/application data with the documented trigger/replication handling needed for logical migration.

The implementation must test whether current target-managed Supabase schemas need exclusions/special handling. It may not bulldoze platform-managed state blindly.

### Phase 7 — Auth and persistent extension data

Restore dedicated database components using adapter-specific semantics:

- `auth.data` including users/hashed passwords and required Auth records;
- `database.vault_data` after the source Vault root key is in place;
- `database.cron` jobs after `pg_cron` exists;
- `database.queues` queues/messages/archive/permissions after `pgmq` exists;
- `database.webhooks` after required webhook/`pg_net` support exists;
- `database.extension_state` for every other installed extension whose persistent state was captured.

Do not restore historical/ephemeral extension runtime tables as if they were required application state unless the adapter explicitly defines that behavior.

### Phase 8 — migration history and managed-schema customizations

Restore:

- Supabase migration history where appropriate;
- project-specific changes made to managed `auth` / `storage` schemas;
- custom functions/triggers/policies not recreated by the standard dump path.

The backup engine must have distinguished user customizations from platform-owned objects so restore can apply only safe deltas.

### Phase 9 — Realtime publication state

Recreate/activate the publication/table state required for Realtime after database restore.

Verify expected publications and replicated tables.

### Phase 10 — Storage service and File buckets

Restore Storage configuration and create/update File buckets.

Conflict policy:

- `fail` by default if a semantically incompatible bucket already exists;
- `replace` only when adapter explicitly implements safe replacement;
- never silently change public/private status, limits or MIME restrictions.

### Phase 11 — File Storage objects

Upload every object by its original logical `(bucket,key)`.

Restore metadata including content type/cache control where supported.

Rules:

- streaming upload;
- bounded concurrency;
- safe retry;
- source backup checksum verified before upload;
- destination verification after upload;
- deterministic conflict behavior.

After upload, enumerate target and compare:

- object count;
- keys;
- sizes;
- checksums or strongest available verification;
- relevant metadata.

### Phase 12 — Vector/Analytics

Restore only if the corresponding adapter has a documented, complete restore implementation for the active API.

A source `not_exportable` component stays an explicit platform limitation. It can never be transformed into a green restore result.

### Phase 13 — Edge Function secrets

Restore secrets before functions.

Never print values.

### Phase 14 — Edge Functions

Deploy all captured deployable function artifacts and configuration.

Verify target function inventory and configuration.

Any source-side artifact known not to be exportable from deployed functions remains an action item in the restore report.

### Phase 15 — Auth configuration

Apply:

- Auth service configuration;
- URLs/redirect configuration;
- supported provider configuration;
- SSO;
- third-party auth integrations.

External provider-side objects are not created by pgDumpster. Required DNS/provider console actions are included in `manual-actions.json`.

### Phase 16 — signing keys

Restore/recreate signing-key state only to the extent allowed by current Supabase APIs.

If source private signing material is not exportable:

- preserve public/administrative metadata in backup;
- create/reconfigure target signing state only through documented mechanisms;
- classify exact cryptographic continuity as impossible;
- warn that existing tokens/session continuity may be affected;
- never claim exact restore.

### Phase 17 — API keys

Source modern API key values may be captured for evidentiary/inventory purposes where `reveal=true` permits it, but the target API may generate new key values instead of accepting arbitrary imported values.

Restore behavior:

1. recreate equivalent key definitions;
2. capture newly generated target secrets securely;
3. generate a protected rotation mapping:
   - source key identifier/fingerprint;
   - target key identifier;
   - target secret only in protected output;
4. include consumer-rotation tasks in manual actions;
5. never emit key material to ordinary stdout.

Exact key equality is not a restore success condition where the platform API cannot import the old secret.

### Phase 18 — Realtime/PostgREST/Storage config

Apply service-level configuration after database content is established.

Verify normalized semantic equivalence.

### Phase 19 — networking, domains, private connectivity

Apply late because incorrect restrictions can lock the restore process out.

Custom domain workflow must surface DNS prerequisites. pgDumpster cannot create records at an external DNS provider unless that separate provider were explicitly integrated, which is outside this product scope.

### Phase 20 — billable resources

Resources such as replicas, private networking or compute/add-ons that can incur additional charges require:

```bash
--allow-billable-resources
```

Without that flag:

- plan them;
- mark `blocked_by_policy`;
- print the exact omitted actions;
- do not create them.

### Phase 21 — semantic parity verification

The restore is successful only after a post-restore audit.

Compare source-backup intent with target:

- database schema fingerprints;
- critical row counts/invariants;
- Storage bucket/object parity;
- Edge Function inventory;
- secret-name inventory without revealing values;
- Auth normalized config;
- Realtime/PostgREST/Storage normalized config;
- project/network config;
- restore substitutions such as regenerated API keys;
- expected platform limits/manual actions.

Produce:

```text
restore/
  plan.json
  result.json
  parity-report.json
  manual-actions.json
  rotation-map.age   # or equivalently protected output
```

## Conflict policies

Supported top-level values:

- `fail` — default and safest.
- `replace` — only supported for adapters with explicit, tested replacement semantics.

Do not implement a vague global “merge” policy. Merge semantics differ too much between Postgres, object stores and control-plane configuration.

## Rollback

pgDumpster must not pretend it can atomically roll back a multi-service restore.

Instead:

- mutate a fresh target by default;
- record every applied action;
- stop on first hard failure;
- expose a deterministic cleanup/action log;
- never automatically delete an existing target project.

## Idempotency

Every restore adapter should be idempotent where practical:

- compare before create/update;
- tolerate exact existing state;
- fail on incompatible state;
- never duplicate secrets/functions/resources merely because a retry occurred.

A resumed restore revalidates already applied actions before continuing.

## Restore acceptance

A restore run can be:

- `restored`: every exportable/restorable component semantically verified.
- `restored_with_platform_limits`: all possible restore work succeeded, with documented source platform limitations/substitutions.
- `failed`: any required possible operation or parity check failed.

A backup marked `failed` cannot be restored without an explicit forensic/partial mode that is outside the standard success path.
