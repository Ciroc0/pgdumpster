# User guide and setup

## What pgDumpster backs up

pgDumpster targets one **hosted Supabase Platform project** at a time.

It backs up every registered project-scoped surface it can export, including database state, File Storage object bytes, Auth/project configuration, Edge Functions/secrets, service configuration and cryptographic material that the platform exposes.

Anything the platform does not allow to be exported is explicitly reported.

## Prerequisites

Install:

- a supported Node.js LTS release;
- Supabase CLI `>=2.111.0 <3.0.0`; pgDumpster prefers a project-local pinned
  installation over an older global executable and `doctor` rejects versions
  outside this live-validated range;
- a reachable Docker-compatible daemon for the vendor-compatible database backend; the current Supabase CLI runs its filtered `pg_dump` inside a container;
- `age` only when using external `age` encryption mode and it is not bundled/internally implemented through a vetted library.

You also need:

- Supabase Management API authentication;
- either a linked Supabase workspace (preferred for backup) or a database
  connection string;
- a credential capable of reading all File Storage objects;
- enough local/destination capacity for the backup.

Always follow the compatibility matrix shipped with the release instead of assuming any arbitrary Supabase CLI version works.

### Database runtime choice

The production-safe default is the vendor-compatible Supabase CLI backend. It requires a Docker-compatible daemon because the CLI applies Supabase-specific schema filtering and role transformations inside its database-tools container. pgDumpster does not silently replace that workflow with raw host `pg_dump`; current Supabase documentation warns that raw dumps include platform internals and can fail during restore.

On Windows, Docker Desktop is the simplest supported daemon, but it is a separate third-party product with its own license and is not bundled with pgDumpster. Hardware virtualization must be enabled in BIOS/UEFI and Docker Desktop must be running. On Linux, Docker Engine or another daemon proven compatible with the active Supabase CLI is sufficient. Run `pgdumpster doctor` before backup; an installed client without a reachable daemon is a failure.

The architecture permits a future native PostgreSQL backend only after contract and semantic-parity tests prove it matches the current Supabase-filtered output. No release may advertise or silently select that backend before those gates pass.

## Authentication

### Management API

Use a Supabase Personal Access Token or supported OAuth token with only the scopes required by the current operation.

Recommended environment variable:

```bash
PGDUMPSTER_ACCESS_TOKEN=...
```

Do not commit it.

### Database

For the easiest backup setup, run `supabase link` in the project workspace and
use `pgdumpster backup --linked`. The validated CLI obtains a short-lived login
for `db dump` and read-only `db query`, so pgDumpster does not need a static
database password.

For unlinked automation, provide the direct/pooler database URL recommended for
the current Supabase CLI dump workflow.

```bash
PGDUMPSTER_DB_URL='postgresql://...'
```

Avoid placing the full connection string directly in shell history.

### Storage

pgDumpster needs a credential that can enumerate and download all objects. A public/anonymous key is insufficient for a full-backup guarantee when RLS can hide objects.

```bash
PGDUMPSTER_STORAGE_KEY='...'
```

If the tool can securely obtain a suitable project key through the authenticated Management API, it may do that automatically after explicit capability checks.

## Install

Published package instructions must be filled with the actual package name only after registry naming is finalized.

During source development:

```bash
git clone <repository>
cd <repository>
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm link --global
```

Do not publish documentation containing a fictitious registry package name.

## First run

Run the doctor first:

```bash
pgdumpster doctor --project-ref "$PGDUMPSTER_PROJECT_REF"
```

Expected result: every required source credential and dependency is validated before data transfer.

## Create an encrypted backup

Recommended:

```bash
pgdumpster backup \
  --project-ref "$PGDUMPSTER_PROJECT_REF" \
  --output ./backups \
  --consistency verified \
  --encrypt-to 'age1...'
```

The final result will either be:

- complete;
- complete with explicit platform limits;
- failed.

Read the coverage report before treating the artifact as your recovery point.

## Plaintext backups

A full backup can contain:

- all application data;
- user/Auth data;
- Edge Function secrets;
- project keys;
- Vault root encryption material;
- third-party credentials.

Therefore plaintext sensitive output is prohibited by default.

If you intentionally accept that risk:

```bash
pgdumpster backup ... --allow-plaintext-secrets
```

Store the resulting bundle like a production secret.

## Inspect

```bash
pgdumpster inspect ./backups/<bundle>
```

This does not print secret values.

## Verify

Immediately after backup and periodically in storage:

```bash
pgdumpster verify ./backups/<bundle>
```

Verification detects changed/corrupt/missing payloads.

## Backup to S3-compatible storage

Example config:

```yaml
destination:
  type: s3
  endpoint: https://...
  bucket: pgdumpsters
  prefix: production/
  region: auto
```

Credential values come from environment/credential provider, not the YAML file.

The implementation must support multipart/streaming behavior suitable for large backups and verify uploaded bundle integrity.

## Restore workflow

### 1. Create a fresh target project

A fresh target is strongly preferred. Multi-service restore cannot be atomically rolled back.

### 2. Configure target credentials

```bash
PGDUMPSTER_TARGET_PROJECT_REF='...'
PGDUMPSTER_TARGET_DB_URL='postgresql://...'
PGDUMPSTER_TARGET_STORAGE_KEY='...'
```

### 3. Dry run

```bash
pgdumpster restore ./backups/<bundle> \
  --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

Read:

- planned mutations;
- platform limitations;
- regenerated-key actions;
- custom domain/DNS tasks;
- potential billable resources.

### 4. Apply

```bash
pgdumpster restore ./backups/<bundle> \
  --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --apply
```

Billable infrastructure is skipped unless explicitly allowed.

### 5. Rotate consumers

Where Supabase cannot recreate the exact source secret (for example some generated API-key/signing-key states), use the protected rotation report to update applications/integrations.

### 6. Complete manual external actions

Examples:

- DNS records;
- external OAuth provider configuration;
- external SMTP provider resources;
- custom LOGIN role passwords;
- third-party webhook endpoints if external ownership is required.

### 7. Read parity report

A restore is not finished merely because data upload completed. Confirm semantic parity result.

## Scheduling

pgDumpster itself should perform one backup run and exit. Scheduling belongs to a trusted scheduler:

- systemd timer;
- cron;
- GitHub Actions only if secret/storage requirements are acceptable;
- CI/CD scheduler;
- Kubernetes CronJob;
- enterprise scheduler.

Example cron concept:

```cron
0 3 * * * /usr/local/bin/pgdumpster backup --config /etc/pgdumpster/prod.yaml --non-interactive
```

Do not place raw secrets in the crontab.

## Retention

Retention is a user policy, not a hard-coded deletion feature.

Recommended operational pattern:

- immutable/locked remote storage where available;
- multiple recovery points;
- periodic `verify`;
- periodic live restore drill.

A backup without tested restore is an unverified recovery hypothesis.

## Updates

Before upgrading pgDumpster in production:

1. read CHANGELOG;
2. confirm bundle compatibility;
3. run `doctor`;
4. test against a non-production project;
5. keep at least one backup created by the previous known-good release until restore validation passes.

## Uninstall

Removing the CLI does not delete backup bundles. Backup data should only be deleted by explicit storage/retention actions outside accidental package uninstall behavior.
