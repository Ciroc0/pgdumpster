# User guide and setup

## Release status

pgDumpster `0.1.2` is publicly available on npm. This guide describes the supported CLI workflow and its explicit platform/manual limits.

For current evidence and platform limits, read `docs/23-current-status.md`.

## Scope

pgDumpster targets one **hosted Supabase Platform project** at a time and accounts for every component in the canonical coverage registry. Platform state that cannot be exported is reported explicitly rather than silently ignored.

## Prerequisites

- supported Node.js (`>=22.15.0 <23` or `>=24 <25`);
- pnpm through the repository's `packageManager` pin;
- Supabase CLI in the validated 2.x range (`>=2.111.0 <3.0.0` policy; repository dev dependency pinned);
- reachable Docker-compatible daemon for the current Supabase CLI database workflow;
- Supabase Management API access token;
- linked Supabase workspace **or** an explicit database URL for backup;
- privileged Storage credential or a Management-API-revealed key that the backup can prove suitable;
- local disk capacity for the working bundle;
- `age` executable on `PATH` when encrypted output/input is used.

S3-compatible publication is supported when `destination.type: s3` is configured. Local fault-injection coverage and one scoped Cloudflare R2 interoperability run passed encrypted publication, completion-marker, materialization and offline verification. This is provider-specific evidence, not a claim for every S3-compatible service.

## Source development install

```bash
git clone https://github.com/Ciroc0/pgdumpster.git
cd pgdumpster
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

## Install from npm

```bash
npm install -g pgdumpster
pgdumpster --version
pgdumpster doctor --help
```

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

It also probes `age --version`. Missing `age` is reported as an encryption warning by `doctor`; attempting an encrypted operation without the executable fails through the dependency error domain.

```bash
pgdumpster doctor --project-ref "$PGDUMPSTER_PROJECT_REF"
```

## Configure standard `age` encryption

The current local encrypted-publication path uses a standard `age` recipient and an optional identity-file reference for later reads.

Example YAML:

```yaml
projectRef: abcdefghijklmnopqrst

backup:
  output: ./backups
  consistency: verified

encryption:
  mode: age
  recipient: age1replace_with_real_recipient
  identityFile: ./age-identity.txt

destination:
  type: local
```

`recipient` is required for encrypted backup. `identityFile` is required only when the same config is used to open a `.tar.zst.age` bundle. A relative identity-file path is resolved relative to the config file.

The identity file contains private key material. Keep it outside source control and restrict filesystem access. pgDumpster passes the path to `age`; it does not require the private key contents as a normal CLI argument.

## Create an encrypted backup with the current build

Encrypted backup does **not** require `--allow-plaintext-secrets`:

```bash
pgdumpster backup \
  --config ./pgdumpster.yaml \
  --project-ref "$PGDUMPSTER_PROJECT_REF" \
  --linked \
  --output ./backups
```

The final output is `.tar.zst.age`. pgDumpster creates the deterministic `.tar.zst` transport archive internally before encryption, so `--archive` is not required separately.

On normal successful encrypted publication, the plaintext archive and directory workspace are removed. Encryption failure also attempts to remove those plaintext outputs before returning the error. A hard process termination can still leave the protected working directory/checkpoint so the interrupted backup can be diagnosed/resumed; do not treat the active working directory as encrypted-at-rest staging.

Direct database URL mode works the same way:

```bash
pgdumpster backup \
  --config ./pgdumpster.yaml \
  --project-ref "$PGDUMPSTER_PROJECT_REF" \
  --db-url-env PGDUMPSTER_DB_URL \
  --output ./backups
```

## Create a plaintext development backup

When `encryption.mode` is `none` or no encryption config is supplied, a secret-bearing backup requires explicit acknowledgement:

```bash
pgdumpster backup \
  --project-ref "$PGDUMPSTER_PROJECT_REF" \
  --linked \
  --output ./backups \
  --allow-plaintext-secrets \
  --archive
```

A plaintext development bundle can contain database/Auth data, API/project keys, Edge secret material and Vault key material. Treat it as a production secret.

## Consistency modes

Omitting `--consistency` selects `verified`. Explicit alternatives are:

```bash
--consistency verified
--consistency quiesced
--consistency best-effort
```

Use `quiesced` when writes have deliberately been stopped and any observable source change should fail the run. Use `best-effort` only when you accept a non-verified cross-service point in time; if drift is observed, the final manifest reports `drift_detected`.

All 10 product backup steps participate in the consistency layer. Verified runs compare the strongest available source evidence before and after step copy, promote copy-time drift signals into the same policy, and retry only after step-owned provisional/partial output is removed safely.

Interrupted non-completed steps are cleaned before resume. Cleanup validates bundle-relative ownership and refuses symlinked parent paths. Best-effort drift evidence is persisted in the checkpoint so a resumed run cannot silently lose the fact that drift was already observed.

This is not an atomic platform-wide snapshot primitive. It is pgDumpster's application-level stabilization contract over the official source surfaces the platform exposes.

## Inspect, coverage and verify

Directory and plaintext archive forms:

```bash
pgdumpster inspect ./backups/<bundle>
pgdumpster coverage ./backups/<bundle>
pgdumpster verify ./backups/<bundle>.tar.zst
```

Encrypted archive form requires config containing `encryption.identityFile`:

```bash
pgdumpster inspect ./backups/<bundle>.tar.zst.age --config ./pgdumpster.yaml
pgdumpster coverage ./backups/<bundle>.tar.zst.age --config ./pgdumpster.yaml
pgdumpster verify ./backups/<bundle>.tar.zst.age --config ./pgdumpster.yaml
```

Encrypted input is decrypted into a restricted temporary area, then processed through the same archive extraction and bundle verification path. Temporary decrypted material is removed after the operation completes or fails normally.

## Resume an interrupted backup

The backup command accepts:

```bash
pgdumpster backup ... --resume <workspace-or-checkpoint-path>
```

Resume is bound to the original run/project/configuration and revalidates completed artifact integrity before trusting checkpoint state. Non-completed interrupted steps are cleaned within their own artifact scope before rerun.

For an encrypted backup, the working directory remains the resumable plaintext/protected workspace until final archive encryption succeeds. Keep the output volume protected accordingly.

## Restore: current dry-run path

Set target credentials through environment variables:

```bash
PGDUMPSTER_TARGET_PROJECT_REF=zyxwvutsrqponmlkjihg
PGDUMPSTER_TARGET_DB_URL='postgresql://...'
```

Generate the integrity-first plan from a directory or plaintext archive:

```bash
pgdumpster restore ./backups/<bundle> \
  --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

For encrypted input:

```bash
pgdumpster restore ./backups/<bundle>.tar.zst.age \
  --config ./pgdumpster.yaml \
  --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

The CLI performs guarded target mutation only with explicit `restore --apply` after integrity verification, executable-plan validation, credential preflight and handler-completeness checks. It writes an immutable plan/checkpoint and emits a parity report. Components that lack exact source material or a supported target write contract remain fail-closed manual/platform actions rather than simulated restore success.

## Not currently available

The following target workflows intentionally fail closed in the current CLI:

- automatic restoration of source secret/private material that the platform exposes only as a digest or does not accept on target.

Do not work around those guards by relabeling a local/dry-run workflow as the final release workflow.

## Supported recovery workflow

The final supported recovery procedure is:

1. run `doctor`;
2. create an encrypted `verified` backup;
3. run offline `verify` on the encrypted backup;
4. inspect complete terminal coverage;
5. dry-run restore to a fresh target;
6. apply restore;
7. perform required protected key substitutions;
8. run semantic parity and application smoke checks.

The complete procedure has protected hosted-E2E evidence for `v0.1.2`, including encrypted backup/input, guarded `restore --apply`, immutable checkpointed plans and semantic parity reporting. Platform values that Supabase does not expose or cannot recreate exactly remain explicit manual/platform actions; they are not silently represented as restored.

## Scheduling and retention

pgDumpster performs one run and exits. Scheduling/retention belongs to a trusted external scheduler/storage policy. Validate any scheduler integration with a recovery drill and retain platform limits in the resulting coverage/parity report.

## Updating a source checkout

Before relying on a newer commit:

1. read `CHANGELOG.md` and `docs/23-current-status.md`;
2. install with the frozen lockfile;
3. run `pnpm check` and `pnpm test:coverage`;
4. inspect the current commit's GitHub CI status;
5. keep previous recovery artifacts until a real restore drill proves the new build.
