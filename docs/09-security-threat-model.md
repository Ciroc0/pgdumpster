# Security and threat model

## Security objective

pgDumpster handles a concentration of the most sensitive data in a Supabase deployment. Its security bar must be higher than a normal developer utility.

Primary goals:

- prevent credential disclosure;
- prevent backup exfiltration;
- prevent archive/path attacks;
- prevent command injection;
- prevent accidental destructive restore;
- maintain integrity and provenance;
- minimize privileges and secret lifetime.

## Assets

Highest-value assets:

1. database contents;
2. Auth user data/password hashes/session state;
3. File Storage object contents;
4. Vault/pgsodium root key;
5. Edge Function secrets;
6. API keys;
7. signing-key material/metadata;
8. database credentials;
9. Management API token;
10. S3 destination credentials.

## Trust boundaries

```text
User shell
  |
  v
pgDumpster process
  |------> Supabase Management API
  |------> PostgreSQL / Supabase CLI
  |------> Storage/S3 API
  |------> local filesystem
  |------> destination S3
  `------> age encryption boundary
```

Every boundary can fail independently.

## Threats and controls

### Secret leakage to logs

Threat:
HTTP clients, subprocess stderr, exception objects and verbose logging can accidentally serialize credentials.

Controls:

- central redaction layer;
- secret-aware value wrappers;
- URL sanitizer removing credentials/query secrets;
- logger tests with seeded canary secrets;
- no raw request/response logging for secret-bearing endpoints;
- no environment dump;
- no debug dump of process spawn arguments containing secret values;
- CI test fails if known canary secret appears anywhere in captured logs.

### Process-list leakage

Threat:
Secrets passed as CLI arguments are visible to other processes/users.

Controls:

- secret env vars or protected files/stdin;
- never pass DB password as a separate command-line argument;
- use supported connection mechanisms carefully;
- document OS-specific residual risks.

### Shell injection

Threat:
Project refs, paths, object keys or URLs could be interpreted by a shell.

Controls:

- `spawn`/equivalent argument arrays;
- `shell: false`;
- never concatenate shell command strings;
- validate project refs and adapter arguments.

### Filesystem path traversal

Threat:
Storage keys such as `../../x`, absolute paths, Windows device names or Unicode collisions escape extraction root.

Controls:

- opaque/hash-addressed local payload paths;
- logical keys stored only in index;
- canonical containment check;
- refuse symlink/hardlink extraction outside root;
- archive safety scanner;
- cross-platform adversarial tests.

### Archive bombs

Threat:
Malicious/corrupt backup archive expands disproportionately.

Controls:

- limit entry count;
- limit expanded bytes;
- detect duplicate/conflicting paths;
- forbid dangerous special files;
- stream extraction;
- configurable safety ceilings with explicit override.

### Backup tampering

Controls:

- SHA-256 every payload;
- manifest references checksums;
- verification before restore;
- optional future signature support can be added without weakening checksum semantics;
- remote object ETag alone is not accepted as universal content checksum.

### Plaintext secret storage

Policy:
Sensitive full backup output is encrypted by default policy.

Controls:

- `age` encryption using standard, audited format/tooling;
- explicit `--allow-plaintext-secrets` escape hatch;
- secure file permissions;
- warn when destination semantics cannot protect permissions;
- do not invent custom cryptography.

### Memory exposure

Controls:

- stream large content;
- keep secrets in memory for the shortest feasible time;
- do not cache secrets globally;
- zeroization is best-effort in managed runtimes and must not be advertised as a hard guarantee;
- avoid crash dumps containing request payloads.

### SSRF / destination abuse

Threat:
Arbitrary S3 endpoint or URLs can target internal services.

CLI users intentionally control endpoints, so local-user trust exists, but automation can ingest config.

Controls:

- never derive arbitrary destination URL from untrusted backup contents;
- restore source bundle cannot redirect network clients;
- clearly classify endpoint configuration as trusted operator input.

### Malicious backup bundle

Treat imported bundles as untrusted even if they claim to be produced by pgDumpster.

Before restore:

- schema validate;
- integrity validate;
- safe archive extraction;
- reject unknown executable hooks;
- no commands/scripts from a backup are executed merely because they exist;
- SQL restore files are inherently active database content and therefore require explicit restore apply;
- Edge Function source is deployed only during explicit restore.

### Destructive restore

Controls:

- dry-run plan;
- `--apply` mandatory;
- source==target refusal;
- conflict `fail` default;
- fresh target recommendation;
- billable mutations gated separately;
- no project deletion feature in normal restore.

### Dependency/supply-chain compromise

Controls:

- lockfile committed;
- minimal dependency surface;
- provenance/SBOM on releases;
- dependency review;
- CodeQL/static analysis;
- signed/provenance-capable CI releases where platform supports it;
- renovate/dependabot with review, not blind automerge;
- pin GitHub Actions by immutable commit SHA for release-critical workflows.

## Privilege model

`doctor` reports the privileges/capabilities actually available.

Minimum privilege is preferred, but a “full backup” necessarily requires broad read access. The tool must never silently downgrade to a restricted credential and call the result full.

Restore privileges should be scoped to the target project and only for the duration of restore.

## Secret classification

See `docs/18-data-classification.md`.

The following are always class `secret`:

- PAT/OAuth bearer token;
- database password/URL containing password;
- service-role/secret project keys;
- Vault root key;
- Edge Function secret values;
- OAuth client secrets;
- target-generated API key secrets;
- S3 secret credentials;
- private signing key material if ever exposed.

## Network security

- HTTPS only for Supabase/control-plane APIs.
- TLS certificate validation cannot be disabled by a normal convenience flag.
- S3 endpoints must use TLS by default; explicit insecure development endpoints are isolated behind a dangerous-development option and blocked in release mode unless deliberately implemented.
- Never follow arbitrary cross-origin redirects with Authorization headers.

## Telemetry

Default: **none**.

pgDumpster does not transmit analytics, filenames, project refs, error traces or usage telemetry to the project maintainers by default.

If telemetry is ever added:

- opt-in only;
- separate threat/privacy review;
- no secret/content collection;
- documented payload schema.

## Vulnerability handling

See `SECURITY.md`.

Security reports involving secret leakage, command/path injection, unauthorized data access, cryptographic handling or destructive restore safety are release-blocking.
