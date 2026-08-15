# CLI and UX specification

## Status semantics

This document separates the **currently implemented CLI** from the **binding target UX**. Options listed only under target behavior are not available merely because they are specified here.

Current implementation snapshot: **2026-08-15**.

## Binary

```text
pgdumpster
```

## Currently implemented global options

```text
--config <path>
--json
--version
--help
```

The parser rejects duplicate `--json` / `--config` declarations and missing config paths.

Target global UX still includes additional non-interactive/logging/terminal options such as `--quiet`, `--verbose`, `--no-color`, `--non-interactive` and `--log-file`; those are not current CLI claims.

Secrets must not be accepted through flags when that would predictably expose them in process listings. Database URLs and other credentials are passed through environment-variable names or environment configuration. `age` private-key material is referenced through an identity-file path in config rather than passed as a secret CLI value.

## Commands

### `doctor`

Current form:

```bash
pgdumpster doctor [--project-ref <ref>] [--json]
```

It checks runtime, Supabase CLI, Docker reachability, Management API/project health, database identity access, privileged Storage access, local destination capacity and `age` tool availability.

The `age` check runs `age --version`. Missing or unusable `age` is reported separately from source/destination failures. The encryption/decryption runtime path also maps a missing executable into the dependency error domain.

### `backup`

Current required source contract:

```bash
pgdumpster backup \
  --project-ref <ref> \
  (--linked | --db-url-env <environment-variable>) \
  [options]
```

Implemented options:

```text
--linked
--db-url-env <name>
--project-ref <ref>
--output <path>
--consistency verified|best-effort|quiesced
--max-storage-concurrency <n>
--max-api-concurrency <n>
--allow-plaintext-secrets
--archive
--resume <path>
```

Current consistency behavior:

- omitted `--consistency` defaults to `verified`;
- `verified` requires the concrete consistency/partial-cleanup contract for every product step and performs bounded selective retry after observable drift;
- `quiesced` uses the same source-observation layer but fails when observable state changes;
- `best-effort` does not claim verification and reports `drift_detected` if a completed copy observed source drift;
- drift evidence is preserved through checkpoint/resume;
- source-specific copy-time drift, including Storage/Edge/specialized-storage signals, participates in the same consistency policy;
- interrupted non-completed steps are cleaned before resume using step-owned, symlink-safe cleanup scopes.

The consistency guarantee is application-level stabilization over the source evidence available to pgDumpster. It is not a claim that the platform exposes one atomic cross-service snapshot transaction.

Current encryption/publication behavior:

- without `age`, secret-bearing output requires explicit `--allow-plaintext-secrets`;
- config `encryption.mode: age` requires `encryption.recipient`;
- encrypted backup does not require `--allow-plaintext-secrets`;
- encrypted backup automatically creates the deterministic `.tar.zst` transport form and wraps it as `.tar.zst.age`; `--archive` is not required separately;
- successful encrypted publication removes the normal plaintext archive and directory workspace;
- an encryption failure attempts to remove the plaintext archive/workspace before returning the error;
- a hard process termination can still leave the protected resumable workspace/checkpoint, which is handled by the backup resume model rather than being falsely described as crash-proof zero-plaintext staging.

Other important current gates:

- config destination `s3` fails closed because S3 publication is not wired yet;
- plaintext `--archive` packs the finalized directory as deterministic `.tar.zst`.

### `inspect`

```bash
pgdumpster inspect <bundle-directory|archive.tar.zst|archive.tar.zst.age> [--json]
```

Reads a verified bundle and summarizes metadata without printing protected values. Encrypted input requires config with `encryption.mode: age` and `encryption.identityFile`.

### `coverage`

```bash
pgdumpster coverage <bundle-directory|archive.tar.zst|archive.tar.zst.age> [--json]
```

Prints/evaluates every registered component outcome. Encrypted input uses the same identity-file requirement as `inspect`.

### `verify`

```bash
pgdumpster verify <bundle-directory|archive.tar.zst|archive.tar.zst.age> [--json]
```

Performs offline bundle/schema/integrity verification and archive safety checks. `.tar.zst.age` is decrypted into a restricted temporary workspace, verified as the normal deterministic archive form, and cleaned afterward.

### `restore`

Current syntax:

```bash
pgdumpster restore <bundle-directory|archive.tar.zst|archive.tar.zst.age> \
  --target-project-ref <ref> \
  --target-db-url-env PGDUMPSTER_TARGET_DB_URL \
  --dry-run
```

Implemented restore options:

```text
--target-project-ref <ref>
--target-db-url-env <name>
--dry-run | --apply
--conflict fail|replace
--allow-billable-resources
```

Current behavior:

- bundle integrity is verified before plan generation;
- encrypted input is supported for dry-run when `encryption.identityFile` is configured;
- source==target is rejected by the restore planning contract;
- deterministic restore plan generation exists;
- core restore executor/checkpoint/handlers exist in the repository;
- CLI `--apply` is deliberately blocked with `RESTORE_APPLY_NOT_IMPLEMENTED` until full target preflight, executor wiring, substitution output and semantic parity are complete and live-tested.

Target restore UX also requires safe resume/protected substitution output and final parity reporting.

## Credential environment variables

Current/common names:

```dotenv
PGDUMPSTER_ACCESS_TOKEN=
PGDUMPSTER_PROJECT_REF=
PGDUMPSTER_DB_URL=
PGDUMPSTER_STORAGE_KEY=
PGDUMPSTER_TARGET_PROJECT_REF=
PGDUMPSTER_TARGET_DB_URL=
```

Future S3 publication may additionally use standard AWS/provider credential mechanisms. Do not infer that S3 is usable from the presence of AWS SDK dependencies.

## Configuration file

The current config schema supports backup concurrency/consistency settings plus local/S3 destination and none/age encryption shapes.

Current runtime truth:

- `destination.type: local` is implemented;
- `destination.type: s3` is schema-valid but runtime-blocked until S3 publication is implemented;
- `encryption.mode: none` is implemented with explicit plaintext-secret opt-in;
- `encryption.mode: age` is implemented for local encrypted publication;
- `encryption.recipient` is required for encrypted backup;
- `encryption.identityFile` is used to open `.tar.zst.age` input and is resolved relative to the config file when relative.

The config contains options/references, not raw secret values.

## Exit codes

Current structured domain-error mapping includes:

```text
2  configuration / usage
3  authentication / authorization
4  dependency / preflight
5  source component failures (network, rate limit, database, storage, edge, control plane)
6  consistency verification / stabilization failure
7  other backup/restore/runtime failure, including encryption-domain failures
8  destination / I/O failure
9  platform contract drift
10 cancellation
```

Machine consumers should rely on the documented category/structured error contract rather than parsing human stderr text.

## JSON output

`--json` provides stable machine-readable final/report output for implemented commands. The target long-running event-stream UX described by the product requirements remains subject to final CLI acceptance testing.

## Redaction

The output/error layer uses the central redactor. Bearer tokens, database credentials, project secret/service-role keys, Edge secret values, Vault root-key material, `age` identity contents and other registered secret values must not appear in ordinary stdout/stderr/error serialization.

## Non-interactive target behavior

The final CLI contract requires deterministic no-prompt operation for CI/non-interactive use and explicit `--apply` for mutation. `--non-interactive` itself is a target option and is not currently part of the implemented global parser.

## Accessibility and terminal compatibility

Target requirements remain:

- no information encoded only by color;
- `NO_COLOR` compatibility;
- sensible ASCII fallback;
- no cursor animation in non-TTY mode;
- Windows and POSIX terminal coverage.

## Versioning

Command/flag removal, exit-code meaning changes, machine JSON schema changes and bundle-format incompatibility are breaking interfaces and require explicit versioning/release notes.
