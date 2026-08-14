# 03 — Architecture

## Baseline

- TypeScript strict
- ESM
- Node.js CLI
- pinned package manager/runtime policy
- runtime schema validation
- modular library + thin CLI

Choose maintained dependencies at implementation time and lock them. Avoid a huge CLI framework without need.

## Layout

```text
src/
  cli/
    commands/
    output/
  core/
    backup/
    restore/
    inspect/
    verify/
    consistency/
    coverage/
    manifest/
    checkpoint/
    errors/
  adapters/
    management-api/
    database/
    auth/
    edge-functions/
    storage-files/
    storage-vectors/
    storage-analytics/
    platform/
  destinations/
    local/
    s3/
  archive/
  security/
  schemas/
  utils/
tests/
  unit/
  contract/
  integration/
  e2e/
```

Command handlers validate input and invoke use cases. No service-specific backup logic in CLI handlers.

## Adapter contract

Conceptually:

```ts
interface BackupAdapter {
  id: ComponentId;
  probe(ctx: ProbeContext): Promise<CapabilityResult>;
  inventory?(ctx: BackupContext): Promise<InventoryDigest>;
  backup(ctx: BackupContext): Promise<ComponentBackupResult>;
  planRestore(ctx: RestorePlanContext): Promise<ComponentRestorePlan>;
  restore(
    ctx: RestoreContext,
    plan: ComponentRestorePlan,
  ): Promise<ComponentRestoreResult>;
  compare(ctx: CompareContext): Promise<ComponentParityResult>;
}
```

Exceptions are caught/classified by orchestration and still produce coverage.

## Management API client

One centralized client owns:

- `https://api.supabase.com`;
- Bearer auth;
- runtime response validation;
- request timeout/cancellation;
- rate-limit budgeting;
- `X-RateLimit-*` and 429 handling;
- bounded exponential backoff+jitter;
- safe errors;
- optional raw response capture where useful.

Do not scatter `fetch()` across the codebase.

Supabase currently documents 120 requests/minute per user per project/organization as standard, with exceptions. Pace proactively.

## Database adapter

Two execution backends may exist:

### Vendor-compatibility backend

Safely invoke current Supabase CLI dump behavior. This follows the documented migration path but can require Supabase CLI/Docker.

### Native Postgres backend

Use compatible native `pg_dump`/`psql` only if contract tests prove equivalent coverage. Verify source/server/tool major versions.

Never silently switch to a weaker backend.

The database subsystem is split into:

1. **base logical dump** — normal user/project schemas through the documented Supabase-compatible flow;
2. **schema coverage scanner** — enumerates every non-system schema and extension ownership;
3. **managed-schema adapter** — Auth/Storage customizations and dedicated Auth data handling;
4. **extension-state adapters** — persistent state excluded by the normal dump;
5. **database parity scanner** — proves no recoverable persistent schema vanished between discovery and the bundle.

Required explicit extension-state adapters include, when configured:

- `pg_cron` / Supabase Cron;
- `pgmq` / Supabase Queues;
- Database Webhooks / `pg_net` prerequisites;
- Vault encrypted database rows;
- generic unknown-extension fallback that fails closed when persistent state cannot be classified.

Artifacts include:

- roles;
- base schema;
- base data;
- Auth data;
- migration history;
- managed-schema customization artifact;
- extension inventory;
- per-extension state artifacts;
- Cron/Queues/Webhooks/Vault data artifacts;
- publication/normalized metadata;
- schema-coverage report.

## Storage File adapter

Privileged object inventory must be complete.

Resolve elevated data-plane credentials from:

1. explicitly supplied server-side secret/service key; or
2. Management API project keys with `reveal=true`, choosing an appropriate elevated key.

Never use anon/publishable access and assume RLS exposed everything.

Object bytes stream via a streaming-capable supported Storage path. Avoid whole-object Blob buffering for arbitrary sizes.

Object index uses NDJSON for scalability.

## Vector adapter

Separate module because API is evolving. Complete cursor/page traversal mandatory. Unknown/additive fields tolerated and raw-safe metadata preserved.

## Analytics adapter

Subcomponents:

- bucket config
- namespaces
- tables/catalog
- table data/underlying data files

It must prove table data is exported. Metadata-only capture sets `storage.analytics_data=not_exportable` when no data path exists.

## Edge adapter

Primary contract: Management API list/get/get-body or body/bundle retrieval.

CLI function download is fallback/reference only because Supabase documents missing import maps/`deno.json`.

A live/contract test deploys dependency-configured functions and proves what can be recovered.

## Destination abstraction

Conceptual:

```ts
interface Destination {
  put(path: string, body: ReadableStream, meta?: object): Promise<WriteResult>;
  get(path: string): Promise<ReadableStream>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<Stat>;
  list(prefix: string): AsyncIterable<Entry>;
}
```

Local and S3 share bundle semantics. S3 cannot rely on POSIX rename; use immutable checkpoint generations and a final pointer/manifest.

## Checkpoints

Contain:

- operation ID;
- hashed source/target identity;
- format/tool version;
- completed adapters;
- completed object opaque IDs + digest/size;
- consistency pass;
- safe error/retry state.

Never raw PAT/DB password/service keys.

## Manifest

`manifest.json` is finalized last, only after:

- all components classified;
- checksum index closed;
- consistency evaluated;
- coverage registry validated;
- artifact references verified.

During work use partial/checkpoint files that cannot be mistaken for a completed bundle.

## Forward compatibility

External response handling:

- runtime-validate fields used by behavior;
- permit unknown additive fields;
- preserve safe raw forms when useful;
- record source contract/tool timestamp/version;
- unknown enum => explicit unknown, never wrong coercion.

## Restore dependency graph

```text
preflight
 -> prerequisites/extensions/webhooks
 -> Vault root key
 -> DB roles/base schema/base data
 -> Auth + persistent extension state (Vault/Cron/Queues/Webhooks/other)
 -> migrations/customizations
 -> publications
 -> Storage service/buckets
 -> file objects
 -> vectors/analytics
 -> Edge secrets/functions
 -> Auth config/SSO/TPA/signing state
 -> API-key replacement/legacy state
 -> Realtime/PostgREST
 -> domains/network/private-link/billable topology
 -> semantic verification
 -> credential/manual-action report
```

The actual DAG belongs in code and tests.

## Invariants

1. Coverage cannot be bypassed.
2. Secret redaction is centralized.
3. Every mutation has dry-run representation.
4. Destructive/billable operations need explicit policy.
5. Large payloads stream.
6. Retries are bounded.
7. Resume state is verified before reuse.
8. External JSON is untrusted until validated.
