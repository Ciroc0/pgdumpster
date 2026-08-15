# Troubleshooting

## `doctor` fails Management API authentication

Symptoms:

```text
AUTH_MANAGEMENT_API_FAILED
```

Check:

- token is current;
- token belongs to an account with access to the project;
- required scopes/permissions exist;
- project ref is correct;
- system clock/TLS interception is not breaking HTTPS.

Do not paste the token into a public issue.

## Database connection fails

Check the project-provided connection string and the supported Supabase CLI connectivity mode.

Common causes:

- wrong password;
- wrong host/port;
- IPv4/IPv6/network limitation;
- project paused/unavailable;
- pooler/direct connection mismatch;
- TLS/network restriction.

Run:

```bash
pgdumpster doctor --project-ref <ref>
```

Attach only sanitized diagnostics to an issue.

## Storage reports incomplete access

pgDumpster must reject credentials that cannot prove complete object access.

An anonymous/publishable key may see only objects allowed by RLS.

Provide an elevated credential supported by the tool or let the authenticated Management API adapter obtain a suitable key when the current API allows it.

## Backup stops with `SOURCE_DID_NOT_STABILIZE`

The source changed repeatedly during a `verified` backup.

Options:

1. reduce write traffic and retry;
2. use `quiesced` mode after intentionally stopping application writes;
3. use `best-effort` only when you accept a non-verified cross-service point in time.

Do not treat best-effort as identical to verified consistency.

## 429 / rate limit

The client should retry valid 429 responses using server guidance.

If failures persist:

- reduce API/storage concurrency;
- confirm no other automation is hammering the same API;
- retry later.

Do not solve this by removing backoff or spawning unlimited parallel requests.

## Backup is `complete_with_platform_limits`

Run:

```bash
pgdumpster coverage <bundle>
```

This state means all exportable applicable components succeeded, but the platform prevented exact export/recreation of at least one component.

Typical examples can include non-exportable private signing material or externally owned resources. Read `manual-actions.json`/coverage entries for the exact run; do not assume a generic limitation.

## Edge Function restore works but local source repo differs

Expected possibility.

pgDumpster captures the deployed project state. A deployed Function export is not necessarily a byte-for-byte backup of the original Git/source directory, and current tooling may not expose local-only files.

Use Git for source-repository recovery. pgDumpster is for deployed Supabase project recovery.

## Custom LOGIN role cannot authenticate after restore

Logical role dumps do not necessarily recreate custom role passwords.

The restore report should list affected roles. Rotate/set passwords manually and update consumers.

## API key changed on target

Some Supabase key APIs generate a new target secret rather than importing an arbitrary old secret.

Use the protected rotation map produced by restore to update applications/services.

Never put that map into a public issue or CI artifact.

## Existing sessions/tokens fail after restore

If exact signing-key private material was not exportable by the source platform, exact JWT continuity cannot be guaranteed.

Review the signing-key coverage entry and restore report. Users/services may need token/session refresh depending on the affected signing configuration.

## Vault-encrypted data cannot decrypt

This is critical.

Check:

- backup contains `database.vault_root_key = backed_up`;
- target root key was applied before database restore;
- root-key fingerprint in restore report matches expected backup fingerprint;
- no secret was logged.

Do not rotate/randomly replace the root key while debugging. Preserve the failed target for forensic comparison.

## Object checksum mismatch

`verify` or restore must stop.

Possible causes:

- corrupted local storage;
- incomplete remote upload;
- source object changed during best-effort copy;
- destination corruption;
- manual bundle modification.

Do not bypass checksum verification to complete restore.

## Windows path errors

Storage object keys are supposed to be stored by opaque payload path, so reserved filenames/path traversal should not map directly to disk.

If a key still causes a Windows-only error, report:

- pgDumpster version;
- Windows version;
- sanitized logical key representation if non-sensitive;
- stack/error code.

Do not attach the object content if it is sensitive.

## `age` is unavailable

Run `pgdumpster doctor` and inspect the `encryption.age` check.

If `age` is not installed or cannot be started, encrypted backup/input cannot run. A direct encrypted operation reports the dependency failure rather than silently falling back to plaintext.

Do not work around this by adding `--allow-plaintext-secrets` unless you deliberately intend to create a plaintext secret-bearing backup.

## `age` decryption fails

Check:

- the input really is a `.tar.zst.age` backup;
- config uses `encryption.mode: age`;
- config provides the correct `encryption.identityFile` path;
- the identity/private key matches the recipient used for backup;
- backup was not truncated or modified;
- file permissions allow pgDumpster/`age` to read the identity file.

A relative `identityFile` path is resolved relative to the config file, not the current shell directory.

pgDumpster cannot recover a lost encryption private key. Never paste the identity contents into an issue or command-line argument.

## Plaintext staging remains after an interrupted encrypted backup

Normal successful encrypted publication removes the plaintext `.tar.zst` and directory workspace. Normal encryption failure also attempts cleanup.

A hard process termination can occur before final encryption/cleanup and may leave the protected workspace/checkpoint so the run can be inspected or resumed. Treat that working directory as secret-bearing data:

- keep it on trusted local storage;
- resume or securely remove it when no longer needed;
- do not upload it as a CI artifact;
- do not assume an in-progress encrypted backup is encrypted-at-rest internally.

## S3 upload never finalizes

S3 publication writes a completion marker last. A remote backup is valid only when that marker and its independently verified referenced object are present.

Do not treat a manually copied partial remote object as a completed pgDumpster backup.

## Restore refuses existing target state

Default conflict policy is intentionally `fail`.

Use a fresh target, or use `--conflict replace` only for components whose adapters explicitly support safe replacement.

There is no global safe “merge everything” behavior.

## Billable resources skipped

Expected unless:

```bash
--allow-billable-resources
```

is explicitly supplied.

Review the plan before enabling it.

## How to file a useful issue

Include:

- exact pgDumpster version;
- OS;
- Node version;
- Supabase CLI version;
- command name (not secrets);
- structured error code;
- sanitized log excerpt;
- whether problem reproduces on a test project.

Never include:

- PAT;
- DB URL/password;
- API/service-role keys;
- Vault root key;
- Edge secrets;
- S3 credentials;
- age identity/private key material;
- private backup contents.
