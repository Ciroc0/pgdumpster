# 02 — Coverage matrix

This matrix is normative. `spec/coverage-registry.yaml` is the canonical machine-oriented top-level component list.

## Status vocabulary

| Status           | Meaning                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `backed_up`      | Applicable state captured and verified.                                                                                  |
| `not_configured` | Feature exists but no source config/data is present.                                                                     |
| `not_applicable` | Feature is unavailable/irrelevant for this project/plan/API generation.                                                  |
| `not_exportable` | Source existence/config is known, but Supabase does not expose enough material for complete capture or exact recreation. |
| `failed`         | Applicable/exportable state should have been captured but the operation failed.                                          |

403/404/masking/alpha absence/API removal are **reason codes**, not alternate success statuses.

## Database

| ID                                     | Surface                                                                                    | Source                                           | Restore                                                                                                                | Fidelity / rule                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.roles`                       | custom roles/grants                                                                        | Supabase-supported role dump                     | SQL                                                                                                                    | High; custom LOGIN passwords require rotation                                                                                                                                                |
| `database.schema`                      | user schemas/functions/views/triggers/RLS/types/indexes                                    | Supabase-supported logical dump                  | SQL                                                                                                                    | Logical exactness                                                                                                                                                                            |
| `database.data`                        | user-table data                                                                            | logical dump                                     | SQL/COPY                                                                                                               | Data exactness                                                                                                                                                                               |
| `database.migrations`                  | `supabase_migrations` history                                                              | explicit schema/data export                      | SQL                                                                                                                    | Explicit; default dump is not enough                                                                                                                                                         |
| `database.auth_storage_customizations` | project customizations to managed `auth`/`storage` schemas                                 | catalog/diff + explicit SQL                      | SQL                                                                                                                    | Must be separated from platform-owned objects                                                                                                                                                |
| `database.extensions`                  | installed extension names/versions/schema ownership                                        | catalog                                          | enable compatible extension                                                                                            | Restore prerequisite                                                                                                                                                                         |
| `database.extension_state`             | persistent project/user state inside extension-owned schemas excluded from normal CLI dump | dynamic schema inventory + per-extension adapter | per-extension                                                                                                          | No extension schema containing recoverable state may disappear                                                                                                                               |
| `database.cron`                        | Supabase Cron / `pg_cron` jobs and required config                                         | `cron` schema/catalog                            | enable extension then recreate                                                                                         | Jobs are recoverable state; run history may be archived separately                                                                                                                           |
| `database.queues`                      | Supabase Queues / `pgmq` queues, messages, archive and permissions                         | `pgmq`/`pgmq_public`                             | enable extension then restore                                                                                          | Application data, not optional telemetry                                                                                                                                                     |
| `database.webhooks`                    | Database Webhook triggers/config                                                           | catalog + trigger/function definition            | enable prerequisites then SQL                                                                                          | Supabase requires webhook prerequisites before restore                                                                                                                                       |
| `database.vault_data`                  | encrypted Vault records                                                                    | Vault/extension schema                           | SQL after root-key prerequisite where privileged import exists; otherwise manual physical restore or mapped recreation | Preserve ciphertext exactly in the archive; current hosted logical `postgres` cannot identically insert `vault.secrets`, so report `non-identically-restorable` rather than claiming success |
| `database.publications`                | Realtime publications/table membership                                                     | catalog                                          | SQL/platform                                                                                                           | Explicit because normal diff can miss publications                                                                                                                                           |
| `database.postgres_config`             | Postgres config                                                                            | Management API                                   | Management API                                                                                                         | Writable semantic fields                                                                                                                                                                     |
| `database.pooler`                      | Supavisor/pooler config                                                                    | Management API                                   | Management API                                                                                                         | Capability dependent                                                                                                                                                                         |
| `database.pgbouncer`                   | PgBouncer config if exposed                                                                | Management API                                   | Management API                                                                                                         | Capability dependent                                                                                                                                                                         |
| `database.ssl`                         | SSL enforcement                                                                            | Management API                                   | Management API                                                                                                         | Apply late                                                                                                                                                                                   |
| `database.backup_schedule`             | backup/PITR schedule/config                                                                | Management API                                   | Management API                                                                                                         | Plan dependent                                                                                                                                                                               |
| `database.vault_root_key`              | pgsodium/Vault root encryption key                                                         | Management API                                   | Management API                                                                                                         | Exact SECRET; apply before Vault-dependent DB state                                                                                                                                          |

### Critical database rule

The current Supabase CLI documentation states that normal `supabase db dump` excludes `auth`, `storage`, and schemas created by extensions. Therefore the base three-file dump **cannot be the only database mechanism**.

pgDumpster must:

1. use the Supabase-supported dump flow for normal logical roles/schema/data;
2. enumerate all non-system schemas and installed extensions;
3. determine which persistent project/user state is excluded from the base dump;
4. use explicit schema exports, SQL/COPY, or a tested per-extension adapter;
5. verify that every persistent schema/table is either captured, platform-owned/non-restorable, ephemeral, or explicitly `not_exportable`;
6. fail rather than silently omit an unknown persistent schema.

## Auth and keys

| ID                        | Surface                                                                               | Source                                | Restore                      | Fidelity / rule                                            |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `auth.data`               | all Auth tables incl. users, identities, hashed passwords, sessions/MFA as applicable | dedicated `auth` schema export        | dedicated restore            | Data exact; signing continuity separate                    |
| `auth.config`             | Auth service config                                                                   | Management API                        | Management API               | Field-by-field; masked values are not backed up            |
| `auth.sso`                | SSO providers                                                                         | Management API                        | Management API               | Semantic                                                   |
| `auth.tpa`                | third-party auth integrations                                                         | Management API                        | Management API               | Semantic                                                   |
| `auth.signing_keys`       | signing metadata/public JWK and any exportable material                               | Management API                        | create/update where possible | Private source material may be non-exportable              |
| `auth.legacy_signing_key` | legacy signing state                                                                  | legacy/current capability endpoint    | supported path               | Capability-detect; endpoint may disappear                  |
| `api.modern_keys`         | project API keys                                                                      | Management API with authorized reveal | replacement create           | Back up source exact; target may generate different secret |
| `api.legacy_keys_state`   | legacy key enabled/config state                                                       | Management API if present             | supported legacy path        | Capability-detect                                          |

## Edge

| ID               | Surface                                               | Source                                              | Restore       | Fidelity / rule                                               |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| `edge.functions` | deployed function metadata/config and CLI source tree | Management API + CLI `functions download --use-api` | deploy        | Source tree is deployable; not a full original Git repository |
| `edge.secrets`   | function secrets                                      | Management API                                      | create/update | Exact SECRET where source API exposes values                  |

## Storage

| ID                          | Surface                       | Source                                | Restore                        | Fidelity / rule                                                                    |
| --------------------------- | ----------------------------- | ------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `storage.service_config`    | Storage service config        | Management API                        | Management API                 | Semantic                                                                           |
| `storage.file_buckets`      | File bucket config            | Storage/Management API                | Storage API                    | Semantic                                                                           |
| `storage.file_objects`      | actual object bytes           | Storage data plane/S3-compatible path | streaming upload               | Byte-exact SHA-256                                                                 |
| `storage.file_metadata`     | object metadata               | Storage API/read-only DB metadata     | upload + compare               | Semantic; platform IDs may change                                                  |
| `storage.vector_buckets`    | Vector buckets                | current Vector API/SDK                | current API                    | Capability detected                                                                |
| `storage.vector_indexes`    | Vector index schema           | current Vector API/SDK                | current API                    | dimensions/distance/type                                                           |
| `storage.vectors`           | vectors + metadata            | paginated current API                 | batched put                    | All records must be enumerated                                                     |
| `storage.analytics_catalog` | Analytics/Iceberg catalog     | current Analytics API/catalog         | manual until data plane exists | Captured metadata is not semantically restorable without its referenced table data |
| `storage.analytics_data`    | actual Analytics/Iceberg data | complete current export path          | complete current restore path  | Metadata-only is never called full data backup                                     |

## Service/control plane

| ID                         | Surface                                  | Source         | Restore                 | Fidelity / rule                                            |
| -------------------------- | ---------------------------------------- | -------------- | ----------------------- | ---------------------------------------------------------- |
| `realtime.config`          | Realtime config                          | Management API | Management API          | Semantic                                                   |
| `rest.postgrest_config`    | PostgREST/Data API config                | Management API | Management API          | Semantic                                                   |
| `domains.custom_hostname`  | custom hostname                          | Management API | initialize/update       | External DNS remains manual                                |
| `domains.vanity_subdomain` | vanity subdomain                         | Management API | activation API          | Conflicts possible                                         |
| `network.restrictions`     | network restrictions                     | Management API | Management API          | Apply late                                                 |
| `network.private_link`     | PrivateLink associations                 | Management API | Management API          | Billable/infra opt-in                                      |
| `project.metadata`         | project identity/region/version metadata | Management API | reference/compare       | Target identity differs                                    |
| `project.disk_autoscale`   | disk/autoscale                           | Management API | platform API            | Billable impact                                            |
| `project.addons`           | compute/addons                           | Management API | platform API            | Explicit billable opt-in                                   |
| `project.read_replicas`    | replica topology                         | Management API | platform API            | Explicit billable opt-in                                   |
| `project.log_drains`       | log-drain configuration                  | Management API | create/update           | Secret-bearing endpoints/config possible                   |
| `project.jit_access`       | JIT/temporary access configuration       | Management API | config where meaningful | Active ephemeral grants are not application recovery state |
| `project.branches`         | branch topology/config                   | Management API | branch API/manual       | Child branch data requires separate backup                 |
| `diagnostics.readonly`     | source read-only state                   | Management API | normally not restored   | Diagnostic                                                 |
| `diagnostics.health`       | service health                           | Management API | N/A                     | Diagnostic                                                 |

## External dependencies

| ID                        | Surface                                               | Rule                                                                                       |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `external.dns`            | DNS records required for custom domain/provider flows | `not_configured` when unused; otherwise manual/non-exportable unless explicitly observable |
| `external.smtp_provider`  | resources owned by SMTP provider                      | capture Supabase-side config; external account resource remains manual                     |
| `external.oauth_provider` | OAuth-provider-side app/client configuration          | capture Supabase-side config; external provider resource remains manual                    |

## Explicit platform limitations

### Current signing keys

If the current Supabase API returns only public/administrative information, unavailable private/shared signing material is `not_exportable`. Do not claim existing-token signing continuity.

### Modern API keys

If source values can be revealed but target creation generates new opaque values, back up source values securely and generate a protected target rotation mapping.

### Custom LOGIN role passwords

Logical role migration does not reliably preserve custom LOGIN passwords. Preserve role definitions and emit a required credential reset/reprovision action.

### Cross-service atomicity

No single transaction spans Postgres, Storage bytes, Edge deployments and Management API configuration. pgDumpster provides observed consistency via pre/post inventories and bounded stabilization, not fictitious atomicity.

### Deleted/overwritten File Storage versions

Do not assume S3 object-version history exists. Already-lost historical object versions cannot be reconstructed by a backup started later.
