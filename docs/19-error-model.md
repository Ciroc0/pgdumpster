# Error model

## Goals

Errors must be:

- stable enough for automation;
- precise enough for support;
- safe to print;
- associated with component/run context;
- actionable without secret disclosure.

## Structure

```json
{
  "schemaVersion": 1,
  "code": "SOURCE_DID_NOT_STABILIZE",
  "category": "consistency",
  "message": "Source changed during verified backup and did not stabilize.",
  "component": "storage.file_objects",
  "retryable": false,
  "runId": "...",
  "details": {
    "attempts": 3
  }
}
```

`details` must be sanitized.

## Categories

```text
config
auth
dependency
network
rate_limit
platform_contract
database
storage
edge
control_plane
consistency
integrity
archive
encryption
destination
restore_conflict
restore_policy
security
io
cancelled
internal
```

## Canonical codes

### Config

- `CONFIG_INVALID`
- `CONFIG_MISSING_REQUIRED`
- `PROJECT_REF_INVALID`
- `PLAINTEXT_SECRETS_NOT_ALLOWED`

### Authentication/authorization

- `AUTH_MANAGEMENT_API_FAILED`
- `AUTH_DATABASE_FAILED`
- `AUTH_STORAGE_FULL_ACCESS_NOT_PROVEN`
- `AUTH_TARGET_FAILED`

### Dependencies

- `SUPABASE_CLI_NOT_FOUND`
- `SUPABASE_CLI_UNSUPPORTED`
- `DEPENDENCY_NOT_FOUND`
- `RUNTIME_UNSUPPORTED`

### Platform/API

- `PLATFORM_API_RATE_LIMITED`
- `PLATFORM_API_CONTRACT_CHANGED`
- `PLATFORM_FEATURE_UNAVAILABLE`
- `PLATFORM_VALUE_NOT_EXPORTABLE`

### Database

- `DATABASE_DUMP_FAILED`
- `DATABASE_RESTORE_FAILED`
- `DATABASE_CUSTOMIZATION_EXPORT_FAILED`
- `DATABASE_PARITY_FAILED`

### Storage

- `STORAGE_INVENTORY_FAILED`
- `STORAGE_OBJECT_DOWNLOAD_FAILED`
- `STORAGE_OBJECT_UPLOAD_FAILED`
- `STORAGE_OBJECT_CHANGED_DURING_COPY`
- `STORAGE_PARITY_FAILED`

### Consistency

- `SOURCE_DID_NOT_STABILIZE`
- `QUIESCED_SOURCE_CHANGED`
- `CONSISTENCY_INVENTORY_FAILED`

### Integrity/archive

- `CHECKSUM_MISMATCH`
- `MANIFEST_INVALID`
- `COVERAGE_INVALID`
- `BUNDLE_INCOMPLETE`
- `ARCHIVE_UNSAFE_PATH`
- `ARCHIVE_RESOURCE_LIMIT`
- `ARCHIVE_CORRUPT`

### Encryption

- `ENCRYPTION_FAILED`
- `DECRYPTION_FAILED`
- `ENCRYPTION_IDENTITY_MISSING`

### Destination

- `DESTINATION_WRITE_FAILED`
- `DESTINATION_OUT_OF_SPACE`
- `S3_MULTIPART_FAILED`
- `DESTINATION_FINALIZE_FAILED`

### Restore

- `RESTORE_SOURCE_EQUALS_TARGET`
- `RESTORE_CONFLICT`
- `RESTORE_TARGET_INCOMPATIBLE`
- `RESTORE_BILLABLE_ACTION_BLOCKED`
- `RESTORE_PLAN_FAILED`
- `RESTORE_ACTION_FAILED`
- `RESTORE_PARITY_FAILED`

### Security

- `SECURITY_SECRET_LEAK_GUARD`
- `SECURITY_PATH_REJECTED`
- `SECURITY_TLS_REQUIRED`

### Control

- `RUN_CANCELLED`
- `RESUME_STATE_INVALID`
- `RESUME_CONFIG_MISMATCH`
- `INTERNAL_INVARIANT_VIOLATION`

## Retryability

Retryability is set by the adapter/error context, not solely code category.

Examples:

- a 429 is retryable within bounded policy;
- invalid PAT is not;
- connection reset may be;
- checksum mismatch is not “retry until green” unless the operation intentionally recopies and re-verifies from source.

## Causal errors

Internally preserve exception causes for diagnostics, but public serializers sanitize them.

Never output raw HTTP request headers, full credential URLs or response bodies from secret-bearing endpoints.

## User messages

Bad:

```text
Request failed: 401
```

Better:

```text
Management API authentication failed for project abc...xyz.
Check PGDUMPSTER_ACCESS_TOKEN and project access.
Error: AUTH_MANAGEMENT_API_FAILED
```

Still no token value.

## Exit-code mapping

See `docs/05-backup-engine.md`.

Many structured codes map to one stable process exit class. Automation should prefer structured JSON error code when `--json` is enabled.

## Unknown errors

Unexpected errors become:

```text
INTERNAL_INVARIANT_VIOLATION
```

with:

- correlation/run ID;
- sanitized message;
- optional local stack only in debug logs after redaction.

The tool must not convert an unknown adapter exception into `not_configured` or success.
