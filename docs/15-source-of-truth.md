# Source of truth and platform revalidation

Last research baseline: **2026-08-13**.

Supabase is an evolving managed platform. This file records the official sources the implementation must re-check before release and whenever an adapter contract changes.

## Source priority

Use, in order:

1. official Supabase API/OpenAPI schema;
2. official Supabase CLI source/docs;
3. official Supabase product documentation;
4. observed behavior from dedicated test projects.

Do not use third-party blog posts as authoritative API contracts.

## Official references

### Database backup / restore

- `https://supabase.com/docs/guides/platform/backups`
- `https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore`

Baseline facts to revalidate:

- logical backup uses supported Supabase CLI `db dump` flows as a base;
- current CLI docs state normal `db dump` excludes `auth`, `storage`, and schemas created by extensions, so full project backup requires dedicated excluded-schema/extension-state adapters;
- database backup does not contain actual Storage object bytes;
- roles/schema/data are distinct dump concerns;
- migration history and custom managed-schema changes require explicit handling;
- restore has ordering/special handling requirements.

### Database modules and excluded extension schemas

- `https://supabase.com/docs/guides/cron`
- `https://supabase.com/docs/guides/queues`
- `https://supabase.com/docs/guides/database/webhooks`
- `https://supabase.com/docs/guides/database/vault`
- current Supabase CLI `db dump` reference.

Baseline:

- Supabase Cron is backed by `pg_cron`, with jobs stored in the `cron` schema;
- Supabase Queues is backed by `pgmq`, with queue/message tables in extension-owned schemas;
- Database Webhooks are database triggers using `pg_net`;
- Vault persists encrypted data in the database and depends on the project encryption root key;
- extension-created schemas are not safely assumed to be in the normal CLI dump.

The implementation must enumerate installed extensions/schemas and prove coverage rather than maintaining only a hard-coded list.

### Management API

- `https://supabase.com/docs/reference/api/introduction`
- current Management API OpenAPI/reference linked from official docs.

Baseline surfaces observed in the current API include project, Auth, database, Edge Functions, secrets, API keys, Realtime, PostgREST, Storage, networking and related control-plane operations.

Do not hard-code the currently documented default API rate limit as a permanent product truth. Honor actual response headers and update the compatibility notes.

### Vault / pgsodium

Use the current Management API `pgsodium` project endpoints.

Baseline fact:

- project root key can be retrieved as sensitive material and can be applied to a target in a manual migration scenario.

This is why it is a first-class secret component.

### Edge Function secrets

Use current Management API project secrets endpoint.

Baseline fact:

- current response can expose secret `name` and `value` to sufficiently privileged callers.

Treat values as secret and never log.

### API keys

Use current Management API project API key endpoints.

Baseline facts:

- current key listing supports revealing secret material when authorized;
- key creation can generate a new secret from key definition rather than importing an arbitrary old opaque secret;
- restore therefore may require replacement-key generation and rotation mapping;
- legacy key endpoints/capabilities may change and must be capability-detected.

### JWT signing keys

Use current project signing-key endpoints.

Baseline:

- read/inventory exposes administrative/public key representation;
- do not assume source private signing material is extractable;
- if exact private material is not returned by the current API, classify exact cryptographic continuity as `not_exportable`.

### File Storage

- `https://supabase.com/docs/guides/storage`
- `https://supabase.com/docs/guides/storage/management/download-objects`
- current S3 compatibility docs.

Baseline:

- File Storage bytes are separate from database metadata;
- bucket/object APIs/S3-compatible access can be used for object transfer;
- S3 object versioning is not supported in the same way as a versioned S3 bucket, so overwritten/deleted historical versions cannot be assumed recoverable;
- restore should preserve content type/cache control/relevant metadata where supported.

### Storage types

Current Supabase Storage product documentation distinguishes File Storage, Analytics Storage and Vector Storage.

Because Vector/Analytics evolve independently, adapters must be capability-detected and contract-tested.

### Auth user state

Use current Auth/database migration documentation.

Baseline:

- Auth table state is database state and hashed-password/user records can participate in database migration;
- service-side Auth configuration is not equivalent to DB state and must be captured separately.

### Edge Function download

Use current CLI/reference docs.

Baseline:

- deployed functions can be enumerated/downloaded;
- CLI download is not a substitute for source-repository backup and may omit local files such as import maps/`deno.json`.

## Release revalidation checklist

Before each release:

- [ ] fetch/review current Management API reference/OpenAPI.
- [ ] compare all used endpoints and response schemas.
- [ ] run contract tests against live test project.
- [ ] verify `supabase db dump` command flags with supported CLI version.
- [ ] verify restore procedure against current official migration docs.
- [ ] verify File Storage enumeration/download/upload semantics.
- [ ] verify current Storage types/features.
- [ ] verify secret/API-key/signing-key exposure semantics.
- [ ] verify Vault root-key endpoint semantics.
- [ ] update `docs/17-compatibility.md`.
- [ ] update coverage registry when Supabase adds/removes a project state surface.

## Change policy

If Supabase adds a new project-scoped restorable state surface, a future pgDumpster release must not continue returning `complete` while ignoring it.

Procedure:

1. add registry component;
2. implement capability discovery;
3. implement backup/restore or `not_exportable`;
4. add contract/live tests;
5. update bundle schema if necessary;
6. document compatibility change.

“Full backup” is an actively maintained invariant.
