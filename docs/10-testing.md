# Test strategy

## Quality rule

The product is not done when unit tests are green. A release requires proof that a real hosted Supabase project can be backed up, destroyed/recreated as a separate target, restored, and semantically verified.

## Test pyramid

### Unit tests

Cover pure logic:

- config precedence;
- project-ref validation;
- redaction;
- URL sanitization;
- hash/address mapping;
- manifest generation;
- coverage status calculation;
- consistency comparison;
- retry classification/backoff;
- error mapping;
- restore dependency graph;
- conflict rules;
- path containment;
- archive limits;
- API response normalization;
- secret classification.

Target: high meaningful coverage, with critical security modules at or near exhaustive branch coverage. Do not optimize for a vanity percentage.

### Contract/fixture tests

For every Management API adapter:

- versioned success fixture;
- empty/not-configured fixture;
- pagination;
- 401/403;
- 404 feature unavailable;
- 429 with retry headers;
- 5xx;
- malformed/unexpected response;
- newly added unknown field;
- missing previously required field.

Unknown breaking shapes must fail closed rather than silently dropping data.

Fixtures must contain fake/canary secrets and tests must assert those secrets never reach logs.

### Subprocess tests

Test wrappers around:

- `supabase db dump`;
- `psql`;
- optional `age`.

Validate:

- argument arrays;
- `shell:false`;
- exit-code propagation;
- timeout/cancel;
- sanitized stdout/stderr;
- paths with spaces;
- Windows quoting behavior;
- no credential leakage.

### Local integration tests

Use Supabase local development where it accurately represents database/storage/auth behavior.

Seed:

- tables, views, indexes, functions, triggers;
- RLS policies;
- enums/types;
- extensions;
- Auth users where supported;
- Storage buckets and unusual keys;
- large object;
- empty object;
- Unicode;
- duplicate-looking case names;
- custom managed-schema changes if safe;
- Realtime publications.

Perform backup/verify/restore-equivalent tests that local mode can support.

Local tests cannot substitute for hosted Management API testing.

### Management API simulator

Build a deterministic test server or transport mock that represents every used endpoint.

Support fault injection:

- latency;
- connection reset;
- 429;
- changing pagination;
- eventually consistent resource;
- mutation between pre/post inventory;
- secret values;
- stale ETags if applicable.

### Storage stress tests

At minimum:

- tens of thousands of objects;
- multi-gigabyte stream fixture without buffering it in memory;
- 0-byte objects;
- keys containing `..`, slashes, backslashes, control-like Unicode, spaces, trailing dots, reserved Windows names;
- interrupted download;
- changed object during backup;
- delete during backup;
- upload conflict during restore;
- checksum mismatch;
- throttling.

Assert bounded memory usage.

### Consistency tests

Scenarios:

1. no writes → verified in one pass;
2. one object changes → recopy and stabilize;
3. DB/control config changes once → recopy affected component;
4. continuous write churn → bounded retries then `SOURCE_DID_NOT_STABILIZE`;
5. best-effort with drift → explicit warning/non-verified consistency;
6. quiesced mode with observed change → fail.

### Resume tests

Kill the process at deterministic fault points:

- halfway through DB/control-plane phase;
- halfway through Storage object;
- after object durable commit before checkpoint;
- after checkpoint before manifest;
- during remote multipart upload;
- during restore.

Resume must:

- not duplicate/corrupt payload;
- re-check completed checksums;
- preserve run identity;
- reject incompatible configuration changes.

### Corruption tests

Modify:

- one byte in database dump;
- one Storage payload;
- index line;
- manifest;
- coverage file;
- encrypted blob/trailer;
- archive path table.

`verify` must fail and `restore` must refuse before mutation.

### Secret leakage tests

Seed values such as:

```text
CANARY_PGDUMPSTER_SECRET_9b92...
```

Capture:

- stdout;
- stderr;
- log files;
- thrown error serialization;
- JSON event output;
- test snapshots.

Fail if canary occurs anywhere except intentionally encrypted/protected test payload.

### Archive security tests

Adversarial entries:

- `../../etc/passwd`;
- absolute path;
- Windows drive path;
- UNC path;
- symlink escape;
- hardlink escape;
- duplicate normalized paths;
- high compression ratio;
- excessive entry count;
- very deep nesting.

No entry may escape extraction root.

## Live hosted Supabase E2E

This is a **release blocker**.

Maintain dedicated disposable source and target projects.

Seed the source with representative data:

### Database

- multiple schemas;
- tables/data;
- FK/unique/check constraints;
- views/materialized views;
- functions/triggers;
- RLS;
- custom roles/grants;
- extensions;
- migration history;
- Realtime-enabled table.

### Auth

- users;
- configured redirect/site URLs;
- providers that can be safely represented in test;
- MFA/settings where feasible;
- signing-key state inventory.

### Database modules / extension state

- enabled non-default extension;
- Cron job via `pg_cron`;
- Queue via `pgmq` with active and archived messages;
- Database Webhook trigger;
- schema/object created by a test extension where practical;
- assertion that the base Supabase CLI dump alone would not be enough and the dedicated adapter captures the excluded state.

### Vault

- encrypted secret/data fixture whose correct decryption after restore proves root-key continuity.

The protected root-key action can be live-verified, but a normal logical
database restore cannot insert captured ciphertext rows into `vault.secrets` on
the target. Treat target decryption of copied Vault ciphertext as a
Supabase physical restore/clone or explicit recreate-with-ID-mapping procedure,
not as an automatic pgDumpster logical-restore assertion. The E2E must report
this as a manual/platform limit rather than fabricating an exact success.

### File Storage

- public/private buckets;
- MIME restrictions;
- file size restrictions;
- thousands of objects;
- large streamed object;
- Unicode/special keys;
- metadata/cache control/content type.

### Edge

- multiple functions;
- function requiring secret;
- configured verify-JWT behavior;
- secret values.

### Control plane

- non-default PostgREST/Realtime/Storage settings where safe;
- network/domain settings only when the test environment can safely exercise them;
- API key definitions.

## Hosted E2E procedure

The managed `auth`/`storage` customization adapter runs the Supabase CLI's
Docker-backed shadow-database diff with `--use-pg-delta`. The legacy diff
engine is not an acceptable fallback for this gate: the current Supabase CLI
documentation records known failures for publications, Storage buckets and
`security_invoker` views, which are independently covered by pgDumpster's
dedicated adapters. The hardened hosted-E2E runner must provide a working
Docker daemon and must not leave a prior shadow container bound to the CLI
project port before it starts.

1. Reset source/target fixture state.
2. Seed source.
3. Run `doctor`.
4. Create encrypted `verified` backup.
5. Run offline `verify`.
6. Inspect coverage; assert every registry component is terminal.
7. Dry-run restore.
8. Apply restore to fresh target.
9. Apply required generated-key substitutions according to tested workflow.
10. Run parity verifier.
11. Execute application-level smoke queries:
    - database reads;
    - Auth-relevant validation, including password sign-in for a disposable source Auth user after target restore;
    - Vault encrypted data read;
    - Storage download and metadata;
    - Edge Function call through the restored CLI-source-tree fixture;
    - Realtime where feasible.
12. Assert no secret canary leaked to CI logs.
13. Delete/reset test data according to test account policy.

For configured components whose source values are only exposed as digests or
whose target cannot accept the captured ciphertext/private material, the E2E
must record the specific manual action and continue to verify all executable
actions. It must not silently skip the component or claim exact fidelity.

If live credentials/projects are unavailable, the release gate is **not passed**. Codex/CI must report the goal incomplete rather than replacing this test with mocks.

## Cross-platform matrix

Required CI/runtime coverage:

- Ubuntu latest supported;
- macOS latest supported runner;
- Windows latest supported runner;
- supported Node LTS versions;
- paths containing spaces/non-ASCII.

Hosted E2E can run on one hardened Linux environment if service semantics are platform-independent, while CLI/subprocess/filesystem behavior remains matrix-tested.

## Performance gates

Establish regression fixtures for:

- 10k small objects;
- 100k object inventory via mocked transport;
- large object stream;
- large database dump fixture;
- S3 upload.

Measure:

- peak RSS;
- throughput;
- requests/sec;
- retry count;
- checkpoint overhead.

No arbitrary object size may cause equivalent-size RAM allocation.

### Current performance evidence

The required deterministic fixtures exist: 10,000 small objects, 100,000-object inventory, 32 MiB streamed object download and a 64 MiB streamed database dump. S3 evidence is also complete: two scoped Cloudflare R2 128 MiB encrypted multipart publications used 5 MiB parts and concurrency 4, measured 15.06 MiB/s and 13.61 MiB/s, and the latter observed 34 requests, zero retries, 154,140,672-byte peak RSS and persisted checkpoint state. Both independently verified the remote object and removed the object/marker afterwards. Comparative provider fault/load measurements remain optional confidence work; they are not a release blocker.

## Release test gates

A release is blocked by:

- any failing test;
- typecheck/lint/build failure;
- security scan with unreviewed high/critical finding;
- bundle schema validation failure;
- secret leakage;
- Windows/Linux/macOS regression;
- live E2E failure;
- parity mismatch;
- incomplete coverage registry;
- stale documented API contract not revalidated for changed dependencies.

## Test evidence

Release workflow stores:

- test summary;
- compatibility versions;
- live E2E sanitized result;
- generated SBOM;
- package provenance where supported.

Never store test secrets or production data as CI artifacts.
