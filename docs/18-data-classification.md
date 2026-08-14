# Data classification and handling

## Classes

### Public

Safe for public repository/release notes.

Examples:

- tool version;
- bundle schema version;
- generic error code.

### Internal

Operational metadata that is not a credential but may reveal architecture.

Examples:

- project ref;
- region;
- bucket names;
- function names;
- table/schema names;
- service configuration;
- network configuration.

Default handling: do not publish without operator choice.

### Sensitive

Metadata/configuration that can materially aid attack or expose user information.

Examples:

- Auth provider configuration;
- object metadata;
- user identifiers;
- custom domains;
- SSO metadata;
- database schema/data samples.

Default handling: protect within backup, redact from generic diagnostics where unnecessary.

### Secret

Credential, cryptographic material or protected content.

Examples:

- database data in general;
- Auth hashes/session tokens;
- Storage object bytes;
- Management API bearer token;
- database password;
- service-role/secret keys;
- Vault root key;
- Edge Function secret values;
- OAuth client secrets;
- S3 secret key;
- private signing material;
- target-generated replacement API keys.

Default handling:

- encryption/protected bundle;
- never ordinary stdout/stderr/log;
- minimal memory lifetime;
- no telemetry;
- restrictive permissions.

## Field-level metadata

Adapters should annotate payload fields/types with sensitivity.

Example type concept:

```ts
type Sensitivity = "public" | "internal" | "sensitive" | "secret";

interface ProtectedValue<T> {
  value: T;
  sensitivity: Sensitivity;
  logPolicy: "redact";
}
```

Do not rely only on regex redaction. Known secret values should be registered with the redactor as soon as they enter the process.

## Backup layout separation

Prefer separating secret payloads from non-secret summary data:

```text
manifest.json                  # no raw secrets
coverage.json                  # no raw secrets
metadata/...                   # normalized non-secret/sensitive metadata
protected/...                  # secret-bearing payloads
payload/...                    # DB/object bytes
```

If the entire bundle is encrypted, internal organization still follows classification to prevent leaks through inspect/log tooling.

## Manifest policy

Manifest may contain:

- hashes;
- sizes;
- component IDs;
- timestamps;
- source project ref;
- adapter versions;
- non-secret fingerprints.

Manifest must not contain:

- raw PAT;
- DB password/credential URL;
- raw Vault key;
- raw Edge secrets;
- raw API key secrets;
- raw S3 secret.

## Fingerprints

When an operator needs to compare a secret without revealing it, use a one-way cryptographic fingerprint with domain separation.

Example conceptual:

```text
SHA256("pgdumpster:fingerprint:v1:" || secret)
```

Do not use a short/plain hash as an authentication mechanism. Fingerprinting is for equality diagnostics only.

## Logs

Default logs may include internal identifiers necessary for operation but should allow `--quiet`/redaction.

Logs must never include class `secret`.

Error serializers are part of logging and follow the same rule.

## CI artifacts

Never upload:

- decrypted backup;
- real target rotation map;
- production fixture data;
- credential-bearing `.env`;
- raw HTTP trace from secret endpoints.

Hosted E2E uses disposable test data and still treats credentials as secrets.

## Support bundles

If a future `diagnostics` command exists, it must:

- be allowlist-based;
- exclude secret payloads entirely;
- redact project identifiers optionally;
- show exactly what will be included before export.

No “zip the whole work directory” support bundle.

## Disposal

Temporary protected material is removed best-effort after completion.

Documentation must not promise cryptographic secure erase on general SSD/cloud/filesystem storage.

Operators are responsible for retention/deletion on final destinations.
