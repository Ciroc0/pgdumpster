# 04 — Backup bundle format

## Canonical directory

```text
pgdumpster-<UTC>/
├── manifest.json
├── coverage.json
├── checksums.sha256
├── source/
│   ├── project.json
│   ├── capabilities.json
│   └── toolchain.json
├── database/
│   ├── roles.sql
│   ├── schema.sql
│   ├── data.sql
│   ├── migration-history-schema.sql
│   ├── migration-history-data.sql
│   ├── auth-storage-customizations.sql
│   ├── publications.json
│   ├── extensions.json
│   └── metadata.json
├── secrets/
│   ├── vault-root-key.json
│   ├── edge-function-secrets.json
│   └── api-keys.json
├── auth/
│   ├── config.json
│   ├── sso-providers.json
│   ├── tpa-integrations.json
│   └── signing-keys.json
├── edge-functions/
│   ├── index.json
│   └── functions/<opaque-safe-id>/
├── storage/
│   ├── service-config.json
│   ├── file-buckets.json
│   ├── file-objects.ndjson
│   ├── files/
│   ├── vectors/
│   └── analytics/
├── platform/
│   ├── realtime.json
│   ├── postgrest.json
│   ├── postgres.json
│   ├── pooler.json
│   ├── ssl.json
│   ├── backup-schedule.json
│   ├── network.json
│   ├── domains.json
│   ├── addons.json
│   ├── replicas.json
│   ├── log-drains.json
│   ├── jit-access.json
│   └── branches.json
└── reports/
    ├── backup-summary.json
    ├── consistency.json
    └── manual-actions.json
```

`manifest.json` and `coverage.json` are canonical indexes; subfiles may evolve by format version.

## Object path safety

Never map Supabase object keys directly to filesystem paths.

Required:

- no `../` traversal;
- no absolute paths;
- no Windows device-name collision;
- no case-folding collision;
- reversible representation;
- original key retained only as metadata.

Recommended: payload path based on opaque ID/content hash, e.g.

```json
{
  "bucketId": "private-docs",
  "objectKey": "customers/42/contract.pdf",
  "payloadPath": "storage/files/sha256/aa/bb/<digest-or-opaque-id>",
  "size": 188421,
  "sha256": "...",
  "contentType": "application/pdf",
  "cacheControl": "3600",
  "sourceMetadata": {}
}
```

## Manifest minimum

```json
{
  "formatVersion": "1.0.0",
  "tool": { "name": "pgdumpster", "version": "..." },
  "operation": { "id": "...", "startedAt": "...", "completedAt": "..." },
  "source": { "projectRef": "...", "projectName": "...", "region": "..." },
  "result": { "status": "complete", "consistency": "verified" },
  "coverageFile": "coverage.json",
  "checksumFile": "checksums.sha256",
  "components": [],
  "statistics": { "files": 0, "bytes": 0 }
}
```

Validate with `schemas/manifest.schema.json`.

## Coverage entry minimum

```json
{
  "id": "auth.signing_keys",
  "status": "not_exportable",
  "reasonCode": "SUPABASE_PRIVATE_KEY_NOT_EXPOSED",
  "message": "Private signing material is not returned by the source API.",
  "sensitivity": "secret",
  "artifacts": [],
  "sourceContract": {
    "kind": "management-api",
    "path": "/v1/projects/{ref}/config/auth/signing-keys"
  }
}
```

## Checksums

Deterministic line format:

```text
<lowercase sha256><two spaces><bundle-relative path>
```

Checksum file does not list itself. Manifest stores checksum-file digest.

Large bundles may shard checksum indexes, but root references must be deterministic.

## Sensitive payloads

Always sensitive:

- DB data and roles;
- Vault root key;
- Auth secret-bearing config;
- Edge secrets;
- API key values;
- Storage object bytes/metadata;
- sensitive network/log-drain config.

A metadata `sensitive` flag is not access control. Protect the bundle.

## Packing

Optional deterministic packed form:

```text
pgdumpster-2026-08-13T203000.000Z.tar.zst
```

Requirements:

- sorted paths;
- deterministic Zstandard compression settings;
- no host absolute paths;
- no unsafe symlinks/hardlinks;
- no checkpoints/temp files;
- safe metadata.

## Encryption

Preferred interoperable wrapper:

```text
pgdumpster-2026-08-13T203000.000Z.tar.zst.age
```

Use standard `age` via maintained implementation or safe external process. No custom crypto.

Do not pass encryption passphrases as visible CLI positional arguments.

## Versioning

`formatVersion`:

- patch: non-breaking clarification/additive metadata;
- minor: additive/read-compatible format behavior;
- major: incompatible semantics/structure.

Reject unsupported major safely.

## Finalization

A bundle is complete only when final `manifest.json` exists and validates. Interrupted partial state must not be accepted as a valid backup.
