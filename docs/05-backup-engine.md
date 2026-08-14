# Backup engine

## Purpose

The backup engine is responsible for producing a self-describing, verified, resumable backup of one hosted Supabase project. It is not allowed to equate “request succeeded” with “backup succeeded”.

The engine operates over multiple independently mutable systems:

1. PostgreSQL.
2. Storage object bytes and bucket metadata.
3. Supabase Management API/control-plane state.
4. Edge Function deployment state.
5. Auth and cryptographic configuration.
6. Optional Vector/Analytics storage surfaces.

There is no cross-service transaction spanning these systems. pgDumpster therefore uses **consistency verification**, not a fictional global snapshot.

## Command contract

```bash
pgdumpster backup \
  --project-ref abcdefghijklmnopqrst \
  --linked \
  --output ./backups \
  --consistency verified
```

`--linked` is preferred when the Supabase workspace is linked: validated CLI
versions obtain a short-lived database login, so pgDumpster does not store a
database password. `--db-url-env` remains the explicit fallback for unlinked
automation and database operations outside the linked CLI contract.

The default user-facing mode is `verified`.

### Supported consistency modes

| Mode          | Meaning                                                                              | Result rule                                                  |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `verified`    | Snapshot mutable surfaces, copy, snapshot again, retry changed surfaces until stable | Must stabilize or fail                                       |
| `best-effort` | Copy once, record drift if detected                                                  | May complete with warnings, never claim verified consistency |
| `quiesced`    | User asserts application writes are stopped; still performs validation               | Fails if observable drift occurs                             |

`verified` is the default because it gives the strongest guarantee the tool can provide without application-wide write suspension.

## Execution phases

### 1. Configuration resolution

Resolve, in order:

1. CLI arguments.
2. Explicit configuration file.
3. Environment variables.
4. Interactive prompt only when TTY is available and `--non-interactive` is false.

Never persist resolved secrets back into the config file.

### 2. Doctor/preflight

Before any payload is written:

- validate Node/runtime requirements;
- validate `supabase` CLI availability and supported version;
- validate `pg_dump`/`psql` path indirectly through the supported Supabase CLI workflow;
- validate Management API authentication;
- validate target project ref;
- validate database connectivity;
- validate Storage full-read credential;
- enumerate capabilities;
- estimate available disk where possible;
- validate output destination write access;
- validate encryption recipient if encryption is enabled;
- ensure source and target locations are not obviously the same backup path;
- retrieve no secrets merely for display.

A preflight failure exits before creating a final bundle.

### 3. Capability discovery

Build an immutable `capabilities.json` for the run.

Each registered component must be classified:

- available and configured;
- available but not configured;
- unavailable for this project/plan;
- unsupported by the active Supabase API;
- export prohibited by platform semantics.

Unknown API response shapes fail closed unless a versioned adapter explicitly handles them.

### 4. Initial inventory

Create a pre-copy inventory for mutable surfaces. At minimum:

- database transaction/snapshot markers where useful for diagnostics;
- database schema fingerprint;
- table row-count/fingerprint sample strategy;
- Storage bucket inventory;
- Storage object `(bucket, key, size, etag/version metadata when exposed, updated_at)` inventory;
- Edge Function metadata/deployment identifiers;
- relevant control-plane object digests;
- Auth configuration digest;
- API/signing-key inventory digest;
- project configuration digest.

The inventory must not serialize raw secret values into diagnostic logs. Secret-bearing payloads may be included only in encrypted/protected backup artifacts.

### 5. Database backup

Use the current Supabase-supported logical backup workflow, not a home-grown SQL dumper.

Expected logical artifacts:

```text
database/
  roles.sql
  schema.sql
  data.sql
  migration-history.*
  managed-schema-customizations.*
  metadata.json
```

Baseline commands:

```bash
supabase db dump --db-url "$DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$DB_URL" -f schema.sql
supabase db dump --db-url "$DB_URL" -f data.sql --use-copy --data-only \
  -x "storage.buckets_vectors" \
  -x "storage.vector_indexes"
```

The implementation must revalidate supported CLI flags against the pinned/tested Supabase CLI version before release.

**The three commands above are only the base logical dump. They are not the complete database backup.** Current Supabase CLI documentation states that normal `db dump` excludes `auth`, `storage`, and schemas created by extensions.

pgDumpster must therefore perform a second database coverage pass:

1. enumerate all schemas and installed extensions from PostgreSQL catalogs;
2. classify schemas as system/runtime, Supabase-managed, extension-owned, or project/user-owned;
3. compare that inventory against what the base dump actually contains;
4. export all persistent recoverable state excluded from the base dump using explicit `--schema`, direct safe `pg_dump`, SQL/COPY, or a per-extension adapter;
5. capture Auth data separately (`auth.data`);
6. capture persistent extension state (`database.extension_state`);
7. explicitly capture Cron jobs (`database.cron`), Queues/messages (`database.queues`), Database Webhook definitions (`database.webhooks`) and Vault ciphertext (`database.vault_data`) when applicable;
8. fail on an unknown persistent schema/table that cannot be proven covered or classified.

Do not treat extension-owned schema exclusion as harmless: Supabase Queues is backed by `pgmq` tables, Cron stores jobs in `cron.job`, and Vault stores encrypted records in the database. Those are recoverable project state.

Do not pass the database URL through a shell-expanded command string. Spawn subprocesses with argument arrays and `shell: false`.

Capture:

- command exit status;
- executable version;
- sanitized stderr/stdout;
- artifact size;
- SHA-256.

Never place the database password in logs.

### 6. Managed and extension schema state

After the base dump, run the schema-coverage adapter.

Minimum explicit handling:

#### Auth data

Export every applicable table in the `auth` schema, including users and hashed passwords, identities and other authentication records needed for migration.

If the Supabase CLI temp role cannot read the schema, the adapter must use a tested direct database method with the supplied database credential. It may not downgrade `auth.data` to success based on an empty/permission-denied result.

#### Cron

When `pg_cron` is enabled:

- inventory jobs;
- preserve definitions/schedules/database/username/active state and all fields required to recreate them;
- optionally archive run history as historical evidence;
- classify run history separately from required active-job restore semantics.

#### Queues

When `pgmq` is enabled:

- enumerate queue definitions;
- capture active messages;
- capture archived messages;
- capture queue type/properties and client-exposure/RLS/permissions needed for behavior;
- verify counts and payload hashes.

Queues are application state.

#### Database Webhooks

Capture webhook trigger definitions and dependencies. Webhooks are implemented through database triggers/`pg_net` integration, but remain an explicit component because the target may require the feature/extension enabled before SQL can be applied.

#### Vault data

Capture Vault's encrypted persisted rows exactly. The root encryption key is a separate component and restore prerequisite.

#### Other extensions

For every installed extension:

- identify its owned schema(s)/objects;
- determine whether it stores persistent project/user state;
- back up that state with a versioned adapter when required;
- otherwise record why it is configuration-only/ephemeral;
- fail closed on unknown persistent state.

This is `database.extension_state`. Child records should name the extension and schema(s).

### 7. Vault/pgsodium root key

If available, fetch the project root key through the Management API.

Rules:

- classify as `secret`;
- never log it;
- store only in the protected secret payload;
- checksum the encrypted/protected artifact, not a log representation;
- mark exact restore ordering requirement in the manifest.

This component is a hard requirement when the project exposes it because database values encrypted using Vault/pgsodium can depend on that key.

### 8. Control-plane backup

For every Management API adapter:

1. GET/list all paginated resources.
2. Normalize only volatile transport fields that are explicitly documented as non-restorable.
3. Preserve the original response in a versioned raw representation when safe.
4. Produce a normalized representation for comparison/restore.
5. Record API adapter version and retrieval timestamp.
6. Redact values from logs, not from the protected backup.

Use bounded concurrency. Honor rate-limit headers and `Retry-After` where provided. Back off exponentially with jitter for retryable 429/5xx responses.

Never retry:

- authentication/authorization errors without credential change;
- schema/contract violations;
- semantic 4xx failures known to be permanent.

### 9. Edge Functions

Capture both:

- Management API metadata for every deployed function;
- deployed function source/bundle using the best currently supported export mechanism.

Do not assume `supabase functions download` is a complete source-repository backup. Supabase documents that downloaded functions do not necessarily include local repository artifacts such as import maps or `deno.json`.

Therefore:

- store exactly what can be exported from the deployed project;
- inventory missing/non-exportable deployment-related artifacts;
- never claim to be a Git repository backup.

### 10. Edge secrets

Export all project Edge Function secrets exposed by the Management API into the protected secret section.

Requirements:

- preserve exact names;
- preserve values if the API exposes them;
- never print values in normal or debug logs;
- never include values in unencrypted JSON output;
- restore before deploying functions that require them.

### 11. File Storage

The Storage adapter must back up:

- every File bucket;
- full bucket configuration;
- every object byte;
- object metadata required for semantic restore.

#### Full-read credential

Do not rely on an anonymous/publishable key subject to RLS and then infer that zero visible objects means an empty bucket. Full backup requires a credential that can enumerate/read the complete project Storage surface.

Accepted implementations can use:

- an explicitly supplied elevated Storage credential; or
- a Management-API-revealed project key that is authorized for full Storage access.

The tool must test the credential before backup.

#### Object addressing

Never convert untrusted object keys directly into local paths.

Instead:

```text
storage/file/objects/sha256/ab/cd/<content-hash-or-object-id>
storage/file/index.ndjson
```

Each index row records:

```json
{
  "bucket": "documents",
  "key": "customers/../literal-name.pdf",
  "payload": "objects/sha256/ab/cd/...",
  "size": 12345,
  "sha256": "...",
  "contentType": "application/pdf",
  "cacheControl": "3600",
  "metadata": {}
}
```

This avoids path traversal, Windows reserved-name bugs, case-folding collisions and filesystem encoding mismatches.

#### Streaming

Object content must stream from source to destination while hashing. Never buffer arbitrarily large objects in RAM.

Use:

- bounded object concurrency;
- configurable max concurrency;
- per-object retry;
- checkpoint after durable object commit;
- temp file/object + atomic finalize where possible.

### 12. Vector Storage

Vector Storage is capability-detected and isolated behind its own adapter because the product/API surface can evolve independently.

The adapter must:

- enumerate vector buckets/indexes;
- capture configuration;
- export all vector data if a complete documented/exportable path exists;
- verify record/object counts and checksums where possible;
- otherwise classify the missing data surface as `not_exportable`.

It may not silently substitute metadata-only backup for data backup.

### 13. Analytics Storage / Iceberg

Analytics Storage is also isolated behind a capability adapter.

The implementation must determine at runtime/release validation whether Supabase exposes:

- catalogs/namespaces/tables;
- table metadata;
- snapshots/manifests;
- underlying data files or a complete logical export path.

If metadata is exportable but the complete data plane is not, report:

```text
storage.analytics_catalog = backed_up
storage.analytics_data    = not_exportable
```

That produces `complete_with_platform_limits`, not `complete`.

### 14. Post-copy inventory and drift detection

After copying, re-enumerate mutable surfaces using the same canonicalization rules.

Compare initial and final inventories.

If no drift: continue.

If drift exists in `verified` mode:

1. identify the smallest affected component/object set;
2. recopy it;
3. re-inventory that component;
4. repeat up to the configured retry bound;
5. if it does not stabilize, fail the backup with `SOURCE_DID_NOT_STABILIZE`.

For Storage, an object changing during a download must be detected using the strongest metadata available plus byte checksum. If reliable source metadata is unavailable, repeat inventory and compare size/hash-derived evidence.

Because Supabase Storage does not provide S3 object versioning semantics, pgDumpster cannot reconstruct an already-overwritten historical object that changed before it was captured. This limitation belongs in the consistency report.

### 15. Integrity generation

For every payload artifact:

- size in bytes;
- SHA-256;
- logical component;
- sensitivity;
- adapter/version.

Generate:

```text
integrity/checksums.json
integrity/report.json
coverage.json
manifest.json
```

The final manifest is written last.

### 16. Finalization

A bundle becomes valid only after:

1. all required adapters reach a terminal status;
2. coverage registry is complete;
3. integrity hashes are finalized;
4. consistency result is finalized;
5. manifest validates against schema;
6. coverage validates against schema;
7. optional archive/encryption succeeds;
8. output is atomically renamed from temporary to final name where filesystem permits.

A partially written working directory is not a completed backup.

## Resume/checkpointing

Working state:

```text
.work/
  run.json
  checkpoint.json
  locks/
  partial/
```

Checkpoint rules:

- write atomically;
- fsync where practical;
- contain IDs/statuses, never raw credentials;
- bind to source project ref and backup run ID;
- refuse resume if immutable configuration changed incompatibly;
- revalidate already-completed payload checksum before trusting it.

`pgdumpster backup --resume <run-id-or-path>` continues a compatible interrupted run.

## Exit codes

Recommended stable contract:

| Code | Meaning                              |
| ---: | ------------------------------------ |
|    0 | Complete according to selected mode  |
|    2 | Invalid CLI/configuration            |
|    3 | Authentication/authorization failure |
|    4 | Preflight/dependency failure         |
|    5 | Backup component failure             |
|    6 | Consistency verification failure     |
|    7 | Integrity verification failure       |
|    8 | Destination/I/O failure              |
|    9 | Unsupported platform/API contract    |
|   10 | User-aborted operation               |

Machine-readable error output must also include the structured error code defined in `docs/19-error-model.md`.
