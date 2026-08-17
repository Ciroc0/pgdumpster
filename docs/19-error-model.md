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

## Documented public codes

The CLI emits a stable `code`, `category`, `message` and `retryable` shape when `--json` is used. The codebase also contains adapter-specific diagnostic codes; they are deliberately not an exhaustive compatibility list. Automation should handle the documented category and the codes below, and must not depend on undocumented adapter-internal codes.

### Config

- `CONFIG_INVALID`
- `CONFIG_MISSING_REQUIRED`
- `PROJECT_REF_INVALID`
- `PLAINTEXT_SECRETS_NOT_ALLOWED`

### Authentication/authorization

- `AUTH_MANAGEMENT_API_FAILED`
- `RESTORE_TARGET_STORAGE_KEY_UNAVAILABLE`

### Dependencies

- `DEPENDENCY_NOT_FOUND`

### Platform/API

- `PLATFORM_API_RATE_LIMITED`
- `PLATFORM_API_CONTRACT_CHANGED`
- `PLATFORM_FEATURE_UNAVAILABLE`

### Database

- `DATABASE_DUMP_FAILED`
- `DATABASE_RESTORE_FAILED`

### Storage

- `STORAGE_INVENTORY_FAILED`
- `STORAGE_OBJECT_DOWNLOAD_FAILED`
- `STORAGE_OBJECT_CHANGED_DURING_COPY`

### Consistency

- `SOURCE_DID_NOT_STABILIZE`
- `QUIESCED_SOURCE_CHANGED`

### Integrity/archive

- `BUNDLE_INCOMPLETE`

### Encryption

- `ENCRYPTION_FAILED`
- `ENCRYPTION_IDENTITY_MISSING`

### Destination

- `S3_REMOTE_INTEGRITY_FAILED`

### Restore

- `RESTORE_SOURCE_TARGET_SAME`
- `RESTORE_PLAN_BLOCKED`
- `RESTORE_ADAPTER_MISSING`
- `RESTORE_ARTIFACT_INVALID`
- `RESTORE_TARGET_CONFLICT`
- `RESTORE_PARITY_FAILED`

### Security

- `SECURITY_PATH_REJECTED`

### Control

- `OPERATION_CANCELLED`
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
