# 00 - Product overview

> **Reader guide:** Start with the repository [README](../README.md) and the [user guide](08-setup-user-guide.md) to operate pgDumpster. This document defines the product boundary; it is not a substitute for the current CLI reference.

## Problem

Supabase project state is distributed across Postgres, Storage and multiple hosted control-plane APIs. A PostgreSQL backup alone is not a project backup. Supabase explicitly documents that database backups do not contain actual Storage object bytes.

The product must orchestrate independent backup mechanisms without pretending they are one transaction.

## Product statement

pgDumpster:

1. discovers source project capabilities;
2. captures every exportable project-scoped recoverable state surface;
3. copies all recoverable data bytes;
4. produces a versioned self-describing bundle;
5. detects omissions and cross-service drift;
6. verifies cryptographic integrity;
7. inspects/restores the bundle;
8. explicitly reports platform-imposed limits.

## “Full” means

Complete coverage of **exportable project-scoped recoverable state**.

It does not mean bypassing Supabase security boundaries. If Supabase returns only public metadata for a signing key and withholds the private material, the manifest records `not_exportable`, why, impact and required post-restore action.

## Personas

- developer protecting production;
- small company without a dedicated DBA;
- consultant migrating/auditing Supabase;
- operations engineer running scheduled off-platform backups.

## UX principles

- safe defaults;
- one normal backup command;
- explicit machine-readable completeness;
- no hidden best-effort omission;
- no secret leakage;
- deterministic restore planning;
- human and JSON output;
- interruption/resume;
- official contracts over reverse engineering.

## Canonical flow

```bash
# Source environment credentials must be set first; see docs/08-setup-user-guide.md.
pgdumpster doctor --project-ref "$PGDUMPSTER_PROJECT_REF"
pgdumpster backup --project-ref "$PGDUMPSTER_PROJECT_REF" --linked --output ./backups
# Explicit fallback for an unlinked workspace:
pgdumpster backup --project-ref "$PGDUMPSTER_PROJECT_REF" --db-url-env PGDUMPSTER_DB_URL --output ./backups
pgdumpster verify ./backups/<bundle>
pgdumpster inspect ./backups/<bundle>
```

Restore:

```bash
pgdumpster restore ./backups/<bundle> --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" --target-db-url-env PGDUMPSTER_TARGET_DB_URL --dry-run
pgdumpster restore ./backups/<bundle> --target-project-ref "$PGDUMPSTER_TARGET_PROJECT_REF" --target-db-url-env PGDUMPSTER_TARGET_DB_URL --apply
```

## Non-goals

- whole organization/account backup;
- billing/invoice/org membership backup;
- cloning external DNS/SMTP/GitHub/OAuth-provider resources;
- historical log/metrics archival;
- recovering Storage versions deleted before backup;
- self-hosted Docker-volume/filesystem snapshots;
- claiming completeness when the platform withholds data.

## Hosted vs self-hosted

The production contract targets **hosted Supabase Platform projects**. Self-hosted deployments do not expose the same hosted Management API. The CLI must reject a misleading “full project” self-hosted mode rather than returning an incomplete backup with a green status.
