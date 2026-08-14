# Operations and reliability

## Reliability objective

pgDumpster is recovery infrastructure. It must prefer a loud failure over a false-success backup.

Primary operational properties:

- deterministic output;
- bounded retries;
- resumability;
- safe cancellation;
- immutable completed bundles;
- stable exit/error contracts;
- no hidden network telemetry;
- observable progress without exposing secrets.

## Run lifecycle

```text
created
  -> preflight
  -> inventory_pre
  -> copying
  -> inventory_post
  -> consistency_repair
  -> integrity
  -> packaging
  -> completed
```

Any phase may transition to `failed` or `cancelled`. Only `completed` produces a final valid bundle.

## Run IDs

Use collision-resistant UUIDs. A run ID:

- is not a secret;
- identifies checkpoint/log/result records;
- does not replace bundle content hash;
- is immutable through resume.

## Temporary workspace

Use a dedicated working directory with restrictive permissions.

Example:

```text
<output>/.pgdumpster-work/<run-id>/
```

Rules:

- never use predictable global temp filenames;
- prevent accidental reuse across projects;
- remove decrypted temporary material on normal completion;
- best-effort cleanup on failure;
- clearly report residual sensitive temp path if cleanup fails.

Do not promise secure deletion on SSDs/filesystems where the OS/storage stack cannot guarantee it.

## Locking

Prevent two processes from finalizing the same run/output.

Lock metadata:

```json
{
  "runId": "...",
  "pid": 1234,
  "hostname": "...",
  "startedAt": "..."
}
```

Stale lock recovery must verify process/age conditions rather than deleting locks blindly.

## Cancellation

Handle SIGINT/SIGTERM where supported.

On cancellation:

1. stop scheduling new work;
2. allow bounded cleanup of active streams;
3. persist checkpoint;
4. abort remote multipart uploads when safe;
5. emit `cancelled`;
6. return stable non-zero exit code.

A second interrupt may force exit.

## Retries

Use operation-specific retry policy.

Retry candidates:

- 429;
- transient 5xx;
- network reset/timeouts;
- temporary Storage object read failure;
- retry-safe target upload.

Do not retry:

- 400 semantic validation error;
- 401/403 auth without refreshed credential;
- checksum mismatch by simply accepting next result;
- restore conflict under `fail`;
- unsupported contract shape.

Backoff:

```text
delay = min(maxDelay, base * 2^attempt) + jitter
```

Respect server-supplied rate-limit/retry guidance when stronger.

## Timeouts

Every network request and subprocess has:

- connect/request timeout where applicable;
- total operation timeout where meaningful;
- abort signal propagation.

Large object transfers cannot use a simplistic short total timeout; use progress/idle timeout semantics.

## Rate limiting

Management API concurrency is deliberately low and configurable because control-plane calls are not the throughput bottleneck.

Supabase CLI linked SQL queries use a separate process-wide lane with
concurrency 1. Each CLI invocation creates a short-lived login role; live
overlapping calls blocked each other. Storage byte downloads and independent
Management API reads retain their own bounded concurrency limits.

Record rate-limit metadata diagnostically without treating numeric defaults as permanent. Runtime behavior honors response headers/current API behavior.

Storage transfer concurrency is independent from Management API concurrency.

## Checkpoint durability

Checkpoint write pattern:

1. serialize to new temp file;
2. flush/fsync where practical;
3. atomic rename;
4. optionally fsync parent directory on POSIX where implemented.

Remote checkpoints use an equivalent generation/version pattern if S3 destination supports it.

## Remote destination reliability

For S3-compatible destination:

- use multipart upload for large objects/archive;
- retry individual parts safely;
- retain local/in-memory content hashes independent of ETag;
- finalize only after all parts and checksum metadata are complete;
- upload final manifest/complete marker last;
- incomplete remote prefix is not a valid backup.

Recommended remote layout:

```text
s3://bucket/prefix/<backup-id>/
  bundle...
  manifest...
  COMPLETE
```

`COMPLETE` contains the final manifest hash and is written last.

## Logging

Levels:

- `error`
- `warn`
- `info`
- `debug`
- `trace` only if implemented safely

Default is `info`.

Every log event includes:

- timestamp;
- run ID;
- component;
- event code;
- message;
- sanitized structured fields.

Secret redaction is mandatory at the logger boundary.

## Metrics

CLI may compute local metrics:

- duration;
- bytes copied;
- objects copied;
- retries;
- requests;
- throughput;
- consistency recopy count.

They are emitted locally only. No default telemetry.

## Crash recovery

On startup/resume:

- validate checkpoint schema;
- confirm run/project identity;
- confirm bundle/workspace path;
- validate hashes for completed payload;
- inspect interrupted remote multipart state;
- re-run capability/preflight checks;
- continue from safest valid boundary.

Never trust an interrupted “completed” component without checksum verification.

## Disk exhaustion

Before backup:

- estimate database/Storage size where possible;
- report when estimation is unavailable;
- check free space for local destination.

During backup:

- detect ENOSPC;
- checkpoint;
- stop cleanly;
- do not finalize bundle.

Streaming to remote storage should minimize local staging but must retain enough state for integrity/resume.

## Source mutation

See `docs/05-backup-engine.md`.

Reliability rule: if verified consistency cannot be proven, the result is not upgraded to `complete`.

## Compatibility drift

Supabase is a managed platform that evolves.

Each release records:

- tested Supabase CLI range;
- tested Node range;
- Management API contract validation date;
- bundle schema version;
- known platform limits.

On unknown response shape:

- preserve sanitized diagnostics;
- fail affected component;
- instruct upgrade/report issue;
- never silently discard unknown required state.

## Disaster-recovery drill

Maintainers should run scheduled live restore drills using dedicated test projects. Operators using pgDumpster for critical systems should independently test their own backups against a clean target.

Successful creation is not equivalent to recoverability.

## Retention/deletion

pgDumpster does not automatically prune backups in the core backup command.

Reason:

- retention is policy-specific;
- accidental deletion is high impact;
- object-lock/immutable destination support should remain under storage policy.

A future explicit retention command must be separately safety-reviewed.
