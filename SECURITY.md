# Security Policy

pgDumpster handles database contents, authentication state, object storage, cryptographic keys and infrastructure credentials. Security reports are taken seriously.

## Supported versions

Until the first public release, only the current development branch is supported.

After release, this table must list actively supported major/minor versions.

## Reporting a vulnerability

Do **not** open a public GitHub issue for vulnerabilities that could expose secrets/data, enable arbitrary filesystem access/command execution, bypass restore safety, or corrupt recovery data.

Use GitHub Private Vulnerability Reporting if enabled for the repository. If that is not available, the maintainer must publish a dedicated private security contact before public release.

Before first public release, replace this paragraph with the actual verified private reporting channel. Do not publish a fake email address.

Include:

- affected pgDumpster version/commit;
- operating system/runtime;
- reproduction steps;
- security impact;
- sanitized evidence.

Never include real production credentials or customer data.

## High-impact classes

Examples:

- PAT/database/API/Edge/Vault/S3 secret leakage;
- command injection;
- path traversal/archive escape;
- malicious backup causing arbitrary file write;
- restore applying without explicit authorization;
- source/target protection bypass;
- checksum/integrity bypass;
- unsafe cryptographic handling;
- unauthorized network destination caused by backup contents.

## Disclosure

The maintainer will validate, fix, test and coordinate disclosure based on impact. Security-sensitive details may be withheld until a fix is available.

## Security design

See:

- `docs/09-security-threat-model.md`
- `docs/18-data-classification.md`
- `docs/19-error-model.md`
