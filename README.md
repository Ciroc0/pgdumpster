# pgDumpster

pgDumpster is a source-available backup, verification, inspection, and restore tool for **hosted Supabase Platform projects**. The repository, package, and CLI name are `pgdumpster`; the project domain is `pgdumpster.com`.

Its product promise is strict:

> Capture every project-scoped state surface that Supabase exposes and makes exportable, copy every recoverable data object, verify the result, and explicitly inventory anything that Supabase itself does not allow to be exported or recreated exactly.

A successful run must never silently omit a component.

## Why this exists

A Supabase database backup is not a complete project backup. Supabase documents that database backups do not contain the actual Storage objects; they contain only Storage metadata. Project state also exists outside Postgres: Auth configuration, API keys, JWT signing-key metadata, Edge Functions and secrets, Realtime/PostgREST/Storage service configuration, networking/domain configuration, Vault's root encryption key, and other platform settings.

pgDumpster unifies those surfaces into one deterministic backup bundle.

The current vendor-compatible database backend uses the Supabase CLI and a reachable Docker-compatible daemon. A linked Supabase workspace is the preferred backup source because the CLI can obtain a short-lived database login without storing a static database password; an explicit database URL remains available for unlinked automation and restore. Docker is not bundled with pgDumpster; Docker Desktop is a separately licensed third-party option on Windows. A raw host `pg_dump` is not treated as equivalent without explicit contract and semantic-parity proof.

> **Development status:** pgDumpster is under active implementation and is not production-ready. The capabilities below describe the binding target specification, not a claim that every adapter and restore path is complete. Current implemented slices and unfulfilled gates are tracked in [PLANS.md](PLANS.md); in particular, live managed-Supabase backup-to-restore parity has not yet passed.

## Core capabilities

- Full logical PostgreSQL backup using a Supabase-compatible dump strategy.
- Migration history and custom changes to managed `auth` / `storage` schemas.
- Dedicated capture of persistent state excluded by the normal Supabase CLI dump, including Auth and installed extension schemas.
- Explicit Cron (`pg_cron`), Queues (`pgmq`), Database Webhooks, Vault data and generic extension-state coverage.
- Auth database state plus service configuration, SSO and third-party auth integrations.
- Vault/pgsodium root encryption key backup and restore.
- File Storage bucket configuration, every object byte, metadata, and SHA-256 checksums.
- Vector Storage backup when available.
- Analytics/Iceberg capability discovery and complete export where the active API exposes data; otherwise explicit `not_exportable`.
- Edge Function metadata and deployed source/bundle capture.
- Edge Function secrets.
- Modern API key capture with `reveal=true`; replacement-key/rotation handling on restore where exact import is impossible.
- JWT signing-key inventory with explicit non-exportable private-material reporting.
- Realtime, PostgREST, Storage, database/pooler/SSL, network, domain, backup schedule, log-drain and applicable project configuration.
- Integrity manifest and coverage report.
- Cross-service consistency/drift detection.
- Resume after interruption.
- `doctor`, `backup`, `inspect`, `verify`, and `restore`.
- Human-readable CLI plus stable machine-readable JSON.
- Local bundle plus S3-compatible destination.
- Optional standard `age` encryption.

## “Full backup” semantics

A result is:

- `complete`: every applicable exportable component was backed up and verified.
- `complete_with_platform_limits`: every exportable component succeeded, but Supabase intentionally prevents one or more values from being exported or recreated exactly.
- `failed`: one or more applicable exportable components failed.

Every registered component has exactly one status:

- `backed_up`
- `not_configured`
- `not_applicable`
- `not_exportable`
- `failed`

No component can disappear from the report.

## Scope boundary

pgDumpster backs up **one hosted Supabase project ref**. Organization membership, billing history, account identity, external DNS, SMTP-provider resources, OAuth-provider-side resources, source Git repositories, and other third-party systems are outside the project backup boundary.

Branch topology/configuration is inventoried, but each branch is a separate environment and its own data must be backed up as its own project when needed.

Historical logs/metrics and historical Supabase-managed backup artifacts are operational telemetry, not restorable application state; their configuration (for example log drains and backup schedule) is captured.

## Documentation order

1. `docs/00-overview.md`
2. `docs/01-product-requirements.md`
3. `docs/02-coverage-matrix.md`
4. `docs/03-architecture.md`
5. `docs/04-backup-format.md`
6. `docs/05-backup-engine.md`
7. `docs/06-restore-engine.md`
8. `docs/07-cli-and-ux.md`
9. `docs/08-setup-user-guide.md`
10. `docs/09-security-threat-model.md`
11. `docs/10-testing.md`
12. `docs/11-operations-reliability.md`
13. `docs/12-release-open-source.md`
14. `docs/13-acceptance-criteria.md`
15. `docs/14-implementation-plan.md`
16. `docs/15-source-of-truth.md`
17. `docs/16-troubleshooting.md`
18. `docs/17-compatibility.md`
19. `docs/18-data-classification.md`
20. `docs/19-error-model.md`
21. `docs/20-target-repository-structure.md`
22. `docs/21-maintainer-runbook.md`
23. `docs/22-ci-release-workflows.md`

Agent rules: `AGENTS.md`. Paste-ready Codex goal: `CODEX_GOAL.md`.

## Trademark

pgDumpster is an independent third-party project and is not affiliated with, endorsed by, sponsored by, or maintained by Supabase. “Supabase” and related marks belong to their respective owners.

## License

This project is source-available under the
[PolyForm Shield License 1.0.0](LICENSE).

Internal and non-competing use is permitted under the license.

Using this software to provide a competing hosted, managed,
white-label, or commercial backup product or service requires
a separate commercial license.

See [LICENSING.md](LICENSING.md) for details.
