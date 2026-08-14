# CLI and UX specification

## Binary

```text
pgdumpster
```

The CLI is designed for humans and automation. Human output is concise; machine output is stable JSON.

## Global options

```text
--config <path>
--json
--quiet
--verbose
--no-color
--non-interactive
--log-file <path>
--version
--help
```

Secrets must never be accepted via flags if doing so predictably exposes them in process listings. Prefer environment variables, stdin/secret file descriptors or OS secret stores.

## Commands

### `doctor`

Validate the environment and source/target credentials.

```bash
pgdumpster doctor --project-ref <ref>
```

Checks:

- runtime;
- Supabase CLI;
- Management API auth;
- database connection;
- Storage access;
- capability inventory;
- destination;
- encryption tooling/config.

No mutation.

### `backup`

```bash
pgdumpster backup \
  --project-ref <ref> \
  --output ./backups \
  --consistency verified
```

Important options:

```text
--db-url-env <name>
--linked
--output <path>
--destination local|s3
--consistency verified|best-effort|quiesced
--max-storage-concurrency <n>
--max-api-concurrency <n>
--max-consistency-retries <n>
--encrypt-to <age-recipient>
--allow-plaintext-secrets
--archive
--resume <path-or-run-id>
```

If secret-bearing data would be written unencrypted, require `--allow-plaintext-secrets`. Do not quietly create a plaintext archive containing JWT/API keys, Edge secrets and Vault material.

### `inspect`

Reads metadata without exposing secret values.

```bash
pgdumpster inspect ./pgdumpster-<UTC>
pgdumpster inspect ./pgdumpster-<UTC>.tar.zst --json
```

Displays:

- backup ID;
- source ref;
- timestamps;
- tool/Supabase CLI versions;
- component coverage;
- consistency mode/result;
- object counts/bytes;
- integrity summary;
- platform limitations;
- encryption state.

### `verify`

```bash
pgdumpster verify ./pgdumpster-<UTC>.tar.zst
```

Verifies:

- schema validity;
- checksums;
- archive safety;
- bundle completeness;
- coverage registry completeness;
- encryption/decryption capability if key available;
- cross-file references.

It does not contact Supabase unless `--online` is explicitly requested.

### `coverage`

```bash
pgdumpster coverage ./pgdumpster-<UTC>.tar.zst
```

Prints every registered component and status. This is useful when evaluating “full backup” claims.

### `restore`

Dry run:

```bash
pgdumpster restore ./pgdumpster-<UTC>.tar.zst \
  --target-project-ref <ref> \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

Apply:

```bash
pgdumpster restore ./pgdumpster-<UTC>.tar.zst \
  --target-project-ref <ref> \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --apply
```

Options:

```text
--conflict fail|replace
--allow-billable-resources
--resume <path-or-run-id>
--secret-output <protected-path>
```

### `unpack` / `pack`

Optional operational commands for deterministic bundle handling. They must never bypass integrity verification by default.

## Credential environment variables

Recommended names:

```dotenv
PGDUMPSTER_ACCESS_TOKEN=
PGDUMPSTER_PROJECT_REF=
PGDUMPSTER_DB_URL=
PGDUMPSTER_STORAGE_KEY=
PGDUMPSTER_TARGET_PROJECT_REF=
PGDUMPSTER_TARGET_DB_URL=
PGDUMPSTER_TARGET_STORAGE_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
PGDUMPSTER_S3_ENDPOINT=
PGDUMPSTER_S3_BUCKET=
```

Do not use a generic `.env` automatically from arbitrary current directories unless the behavior is explicit and documented. Accidental credential loading is a security problem.

## Configuration file

Example:

```yaml
projectRef: abcdefghijklmnopqrst

backup:
  output: ./backups
  consistency: verified
  maxStorageConcurrency: 8
  maxApiConcurrency: 3
  maxConsistencyRetries: 3

encryption:
  mode: age
  recipient: age1...

destination:
  type: local
```

The config contains references/options, not secret values.

## Human output

Example:

```text
pgDumpster 1.x

Source       abcdefghijklmnopqrst
Mode         verified
Destination  ./backups

Preflight
  ✓ Management API
  ✓ Database
  ✓ Storage
  ✓ Supabase CLI

Backup
  ✓ Database
  ✓ Vault root key
  ✓ Auth
  ✓ Edge Functions        8
  ✓ Edge secrets          13
  ✓ File Storage          12,438 objects / 42.8 GB
  ✓ Realtime/PostgREST
  ! Signing private key   not exportable by platform

Consistency
  ✓ Verified after 1 pass

Integrity
  ✓ 12,517 payloads verified

Result
  COMPLETE WITH PLATFORM LIMITS
```

No secret values appear.

## JSON output

`--json` writes newline-delimited event objects during long-running operations and one final result object.

Event shape:

```json
{
  "schemaVersion": 1,
  "time": "2026-08-13T20:30:00.000Z",
  "runId": "...",
  "type": "component.progress",
  "component": "storage.file_objects",
  "data": {
    "completed": 1200,
    "total": 12438,
    "bytes": 928374982
  }
}
```

Final object must include:

- run/result status;
- output bundle path/URI;
- coverage result;
- consistency result;
- warnings/errors;
- manual-action count.

JSON mode sends machine events to stdout and logs/progress diagnostics to stderr.

## Redaction

The output layer owns a central redactor.

Redact:

- bearer/PAT tokens;
- DB credentials;
- service-role/secret keys;
- Edge secret values;
- JWT/private key material;
- Vault root key;
- S3 secrets;
- OAuth client secrets.

Redaction runs before logger transports and before error serialization.

## Progress

For unknown totals, show indeterminate progress. Never invent percentage completion.

For Storage, once inventory is complete, object count and byte total can drive progress.

## Non-interactive behavior

When `CI=true` or `--non-interactive`:

- never prompt;
- missing required input is an error;
- destructive restore still requires `--apply`;
- plaintext sensitive backup still requires explicit policy;
- stable exit codes are mandatory.

## Accessibility/terminal compatibility

- no information encoded only by color;
- support `NO_COLOR`;
- Unicode symbols may fall back to ASCII;
- width-aware output;
- no cursor animation in non-TTY;
- Windows PowerShell/cmd and POSIX terminals covered by tests.

## Versioning

CLI behavior that scripts depend upon is versioned semantically.

Breaking changes include:

- command/flag removal;
- exit-code meaning changes;
- machine JSON schema changes;
- bundle format incompatibility.

Bundle format has an independent schema version recorded in the manifest.
