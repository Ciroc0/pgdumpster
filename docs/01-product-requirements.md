# 01 — Product requirements

Normative language: **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are intentional.

## Functional requirements

### FR-001 — Capability discovery

Before writing backup data, the tool MUST discover:

- source project identity and health;
- Management API permissions/capabilities for every registered component;
- database connectivity and server version;
- available Supabase CLI/native Postgres toolchain;
- available Storage types/features;
- configured Auth/SSO/TPA/signing-key state;
- configured Edge Functions/secrets;
- project/platform configuration surfaces in the coverage registry.

Plan/permission-specific 403/404 responses MUST be classified, never silently skipped.

### FR-002 — Database backup

The tool MUST use Supabase's documented logical backup workflow as a **base**, producing at minimum:

- `roles.sql`
- `schema.sql`
- `data.sql`

The base dump is not sufficient for this product. Current Supabase CLI documentation states that normal `db dump` excludes the `auth` and `storage` schemas and schemas created by extensions.

pgDumpster MUST additionally:

- enumerate every non-system database schema;
- enumerate every installed extension and its owned schema/objects;
- prove whether each persistent schema/table/object is present in the base dump;
- preserve `supabase_migrations` schema/data and migration history separately;
- preserve project customizations to `auth` and `storage`;
- export Auth database state separately, including users and hashed passwords;
- preserve installed extension definitions and all persistent user/project extension state that is required for recovery;
- explicitly preserve Supabase Cron/`pg_cron` job state when configured;
- explicitly preserve Supabase Queues/`pgmq` queue definitions, active messages, archived messages, and behavior-critical permissions when configured;
- explicitly preserve Database Webhook definitions/dependencies when configured;
- explicitly preserve encrypted Vault database rows when configured;
- preserve publications/replication configuration needed for Realtime;
- preserve user schemas/functions/triggers/views/materialized views/policies/grants/sequences/types/constraints/indexes;
- classify any discovered persistent state that cannot be exported as `not_exportable`;
- mark backup `failed` if an exportable persistent schema/object is discovered but not captured.

The implementation MUST NOT assume extension-owned schemas are disposable simply because the Supabase CLI excludes them.

The Vector Storage tables specifically excluded by Supabase's documented data dump MUST be covered by the dedicated Vector Storage adapter rather than blindly restored as File Storage metadata.

Custom LOGIN role passwords MUST be reported as non-exportable/requiring rotation when the source contract does not expose them.

### FR-003 — Vault/pgsodium

The project root encryption key MUST be captured through the supported Management API when available and stored as sensitive material.

For manual logical restore, restore MUST apply it to the target **before** restoring encrypted Vault/column data. Never log it.

### FR-004 — Auth

Capture:

- Auth service configuration;
- email/SMS/template/provider settings the current read API exposes;
- SSO provider configuration;
- third-party auth (TPA) integrations;
- signing-key metadata;
- legacy signing-key state while legacy endpoints exist;
- Auth users, identities, hashed passwords, MFA/session tables and other database-resident Auth state through database backup.

A secret-looking value returned masked/redacted by Supabase MUST NOT count as successfully backed-up secret material.

Modern signing-key private/shared secret material that Supabase does not return MUST be `not_exportable`.

### FR-005 — API keys

Call the modern project API-key endpoint with `reveal=true` where permitted and securely capture returned key values/metadata.

Restore MUST distinguish:

- config/metadata that can be recreated;
- opaque key values Supabase reveals but whose create endpoint generates a new value and cannot import the old value.

Where exact recreation is impossible, restore MUST create an equivalent replacement where safe/authorized and emit a protected credential-rotation mapping/report. Full key values never go to normal stdout/logs.

Legacy API-key enabled state MUST be inventoried while the endpoint exists. Documented removable-endpoint 404 is `not_applicable`, not a generic fatal error.

### FR-006 — Edge Functions

Capture every deployed function:

- slug/name;
- status/version;
- `verify_jwt`;
- entrypoint path;
- import-map metadata/path;
- deployment hash/returned metadata;
- complete downloadable source/body/bundle exposed by the current Management API.

Do not assume `supabase functions download` is complete: Supabase documents that CLI download does not include import maps or `deno.json`. Prefer/test Management API body/bundle. If deployed source cannot be reconstructed exactly, classify the missing part explicitly.

### FR-007 — Edge Function secrets

Capture all secrets returned by `GET /v1/projects/{ref}/secrets`, including values, and restore them through the supported bulk-create path. Treat as SECRET.

### FR-008 — File Storage

Capture:

- Storage service config;
- all file buckets and settings;
- every object path and byte;
- content type/cache control/available metadata;
- size and SHA-256;
- zero-byte objects and unusual valid keys.

Large downloads MUST stream. Never buffer arbitrary object size in memory.

Restore MUST recreate bucket config and upload bytes with explicit overwrite semantics and metadata preservation.

### FR-009 — Vector Storage

When available, capture all vector buckets, indexes and vectors using complete pagination. Preserve index dimension, distance metric, data type, vector key/data and metadata needed for semantic reconstruction.

Because this is an evolving surface, the adapter MUST be isolated, runtime-validated, capability-detected and contract-tested.

### FR-010 — Analytics/Iceberg Storage

When Analytics buckets are available, enumerate buckets, namespaces, tables/catalog metadata and every table-data surface the current supported API makes exportable.

If the active API exposes catalog metadata but not portable table data/object files, the unavailable portion MUST be `not_exportable`. Catalog metadata alone MUST NOT be called a complete Analytics backup.

### FR-011 — Platform/service configuration

Coverage MUST include at minimum:

- project readable metadata;
- Auth;
- Realtime;
- PostgREST;
- Storage service;
- Postgres configuration;
- Supavisor/pooler;
- PgBouncer if applicable;
- SSL enforcement;
- backup schedule;
- network restrictions;
- custom hostname;
- vanity subdomain;
- private-link associations where readable;
- disk/autoscale/compute/add-on metadata relevant to reconstruction;
- read-replica topology;
- log-drain config;
- JIT access config;
- branch topology/config metadata;
- readonly state as diagnostic state.

Historical logs, metrics, network bans and backup-history payloads are not required recoverable state. They MAY be diagnostic only.

### FR-012 — Destinations

Production release MUST support:

1. local filesystem bundle;
2. S3-compatible destination.

Destination credentials are separate from source Supabase credentials.

### FR-013 — Resume

Interrupted backup/restore MUST be resumable. Work is checkpointed atomically. Resume revalidates source/target identity, bundle version and completed checksums.

### FR-014 — Integrity

Every payload artifact MUST have SHA-256. Bundle includes:

- `manifest.json`;
- `coverage.json`;
- checksum index;
- component summaries;
- source/tool version metadata.

`verify` MUST detect missing, modified, truncated, path-conflicting and critical extra files.

### FR-015 — Consistency

Postgres + Storage + platform APIs are not one transaction.

Implement:

1. mutable pre-inventory/config digests;
2. backup;
3. post-inventory/config digests;
4. comparison;
5. dependency-aware retry of changed components;
6. bounded attempts;
7. explicit final consistency status.

Modes:

- `verified`: retry drift; fail if stability cannot be established.
- `best-effort`: allow completion only with explicit drift warning/report.
- `quiesced`: user asserts writes are externally stopped; still verify and fail if drift observed.

Never claim impossible cross-service point-in-time atomicity.

### FR-016 — Inspect

`inspect` shows bundle version, source, timestamps, coverage, size/counts, consistency, platform limits and integrity without source credentials.

Sensitive values stay redacted.

### FR-017 — Restore

Restore MUST:

- verify bundle before mutation;
- create dry-run plan;
- preflight target compatibility/permissions;
- prevent accidental source==target;
- sequence dependencies;
- distinguish exact, semantic and replacement restore;
- support resume;
- verify post-restore semantic parity;
- emit unresolved/manual actions.

### FR-018 — Machine-readable output

Major commands MUST support stable `--json`. Human progress goes to stderr and is disabled when non-TTY/JSON mode requires clean output.

### FR-019 — Plaintext/encryption safety

Full bundles contain high-value secrets.

Encrypted transport/storage using a standard format such as `age` MUST be supported. Plaintext sensitive bundles MAY be supported but noninteractive creation requires explicit acknowledgement such as `--allow-plaintext-secrets`.

Use restrictive local permissions and clean temporary files.

### FR-020 — Packing

Canonical working form is a directory bundle. `--archive` MUST produce a deterministic Zstandard-compressed tar archive named `pgdumpster-<UTC>.tar.zst`; encryption MAY wrap it as `.tar.zst.age`. Verify/restore supports both the canonical directory and documented packed/encrypted forms.

## Non-functional requirements

### NFR-001 — Portability

Linux, macOS and Windows are first-class.

### NFR-002 — Resource use

- stream large payloads;
- memory bounded independent of total backup size;
- bounded configurable concurrency;
- backpressure;
- NDJSON/sharded indexes rather than million-entry arrays.

### NFR-003 — Reliability

- idempotent retries;
- exponential backoff+jitter;
- honor `Retry-After`/Supabase reset headers;
- permanent vs transient classification;
- atomic manifest/checkpoint writes;
- SIGINT/SIGTERM cancellation.

### NFR-004 — Security

`docs/09-security-threat-model.md` is binding. Secret leakage is a release blocker.

### NFR-005 — Observability

Structured logs to stderr; stdout reserved for requested machine output/result. Redact before serialization.

### NFR-006 — Compatibility

Bundle format version independent of app version. Readers reject unsupported major versions safely.

### NFR-007 — Maintainability

Every external Supabase surface sits behind an adapter with capability probe, backup, restore-plan, restore, compare and contract tests.

### NFR-008 — Documentation

README, setup, CLI help and examples MUST match real shipped behavior.
