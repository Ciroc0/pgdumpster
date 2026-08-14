# User guide and setup

## Development-status warning

pgDumpster is not production-ready yet. This guide distinguishes **commands that work in the current development build** from target release workflows that are still blocked.

For exact current status, read `docs/23-current-status.md` and `PLANS.md`.

## Scope

pgDumpster targets one **hosted Supabase Platform project** at a time and accounts for every component in the canonical coverage registry. Platform state that cannot be exported is reported explicitly rather than silently ignored.

## Prerequisites for the current build

- supported Node.js (`>=22.15.0 <23` or `>=24 <25`);
- pnpm through the repository's `packageManager` pin;
- Supabase CLI in the validated 2.x range (`>=2.111.0 <3.0.0` policy; repository dev dependency pinned);
- reachable Docker-compatible daemon for the current Supabase CLI database workflow;
- Supabase Management API access token;
- linked Supabase workspace **or** an explicit database URL for backup;
- privileged Storage credential or a Management-API-revealed key that the backup can prove suitable;
- local disk capacity for the bundle.

`age` may be detected by `doctor`, but the current backup encryption path is not wired. S3 publication is also not wired.

## Source development install

```bash
git clone <repository>
cd pgdumpster
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

The package remains private/development-versioned. Do not document a fictitious public registry install command before release packaging is finalized.

## Credentials

Common environment variables:

```dotenv
PGDUMPSTER_PROJECT_REF=abcdefghijklmnopqrst
PGDUMPSTER_ACCESS_TOKEN=...
PGDUMPSTER_DB_URL=postgresql://...
PGDUMPSTER_STORAGE_KEY=...
PGDUMPSTER_TARGET_PROJECT_REF=zyxwvutsrqponmlkjihg
PGDUMPSTER_TARGET_DB_URL=postgresql://...
```

Do not commit credential files or paste secret values into logs/issues.

### Linked database mode

For backup, a linked workspace is preferred when available:

```bash
supabase link --project-ref "$PGDUMPSTER_PROJECT_REF"
```

Then use `--linked`. The alternative is `--db-url-env PGDUMPSTER_DB_URL`.

### Current `doctor` behavior

`doctor` presently proves database and Storage access from `PGDUMPSTER_DB_URL` and `PGDUMPSTER_STORAGE_KEY`; linked backup mode does not remove those current doctor checks.

```bash
pgdumpster doctor --project-ref "$PGDUMPSTER_PROJECT_REF"
```

## Create a backup with the current build

Until encrypted publication and verified cross-service consistency are implemented, a development backup must be explicit about both limitations.

Linked example:

```bash
pgdumpster backup \
  --project-ref "$PGDUMPSTER_PROJECT_REF" \
  --linked \
  --output ./backups \
  --consistency best-effort \
  --allow-plaintext-secrets \
  --archive
```

Direct database URL example:

```bash
pgdumpster backup \
  --project-ref "$PGDUMPSTER_PROJECT_REF" \
  --db-url-env PGDUMPSTER_DB_URL \
  --output ./backups \
  --consistency best-effort \
  --allow-plaintext-secrets
```

A plaintext development bundle can contain database/Auth data, API/project keys, Edge secret material and Vault key material. Treat it as a production secret.

### Not currently available

The following target workflows intentionally fail closed in the current CLI:

- `--consistency verified`;
- `--consistency quiesced`;
- config `encryption.mode: age`;
- config `destination.type: s3`.

Do not work around those guards by relabeling a best-effort/plaintext/local backup.

## Inspect, coverage and verify

```bash
pgdumpster inspect ./backups/<bundle>
pgdumpster coverage ./backups/<bundle>
pgdumpster verify ./backups/<bundle>
```

The same commands accept the deterministic `.tar.zst` archive form where applicable.

## Resume an interrupted backup

The backup command accepts:

```bash
pgdumpster backup ... --resume <workspace-or-checkpoint-path>
```

Resume is bound to the original run/project/configuration and revalidates completed artifact integrity before trusting checkpoint state.

## Restore: current dry-run path

Set target credentials through environment variables:

```bash
PGDUMPSTER_TARGET_PROJECT_REF=zyxwvutsrqponmlkjihg
PGDUMPSTER_TARGET_DB_URL='postgresql://...'
```

Generate the integrity-first plan:

```bash
pgdumpster restore ./backups/<bundle> \
  --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

The repository contains restore executor/handler primitives, but the CLI does **not** currently perform target mutation. `--apply` fails closed until the complete apply/parity workflow is wired and live-tested.

## Target release workflow (not yet available end-to-end)

The final supported recovery procedure is:

1. run `doctor`;
2. create an encrypted `verified` backup;
3. offline `verify`;
4. inspect complete terminal coverage;
5. dry-run restore to a fresh target;
6. apply restore;
7. perform required protected key substitutions;
8. run semantic parity and application smoke checks.

That procedure is the mandatory hosted E2E release gate. It must not be represented as complete until it passes on the dedicated test projects.

## Scheduling and retention

pgDumpster performs one run and exits. Scheduling/retention belongs to a trusted external scheduler/storage policy. Do not schedule the current development build as though the pending encryption/verified-consistency release gates had already passed.

## Updating the development checkout

Before relying on a newer commit:

1. read `CHANGELOG.md` and `docs/23-current-status.md`;
2. install with the frozen lockfile;
3. run `pnpm check` and `pnpm test:coverage`;
4. inspect GitHub CI status;
5. keep previous recovery artifacts until a real restore drill proves the new build.
