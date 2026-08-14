# Compatibility policy

## Purpose

Supabase, Node.js, PostgreSQL tooling and operating systems evolve. pgDumpster publishes what it has actually tested.

The implementation must replace placeholders below with concrete tested ranges before first release.

## Runtime matrix

| Component         | Supported                                   | Tested                          | Notes                             |
| ----------------- | ------------------------------------------- | ------------------------------- | --------------------------------- |
| Node.js           | `>=22.15.0 <23` or `>=24 <25`               | `24.16.0` locally               | Full CI matrix remains a gate     |
| Supabase CLI      | `>=2.111.0 <3.0.0`                          | `2.111.0` live managed E2E      | Pinned/validated dump behavior    |
| Hosted Supabase   | Current pinned Platform API contracts       | `2026-08-14` live validation    | Contract drift checked            |
| PostgreSQL target | Supabase-managed PostgreSQL 17 at this gate | `17.6` source and target        | Cross-version rules remain a gate |
| Linux             | Intended first-class support                | `TBD CI runner`                 | Required before release           |
| macOS             | Intended first-class support                | `TBD CI runner`                 | Required before release           |
| Windows           | First-class support                         | Windows 11 / Docker Desktop E2E | Hosted CI remains a release gate  |

A release must not ship with `TBD` in this matrix.

## Management API contract

Each release records:

```text
Management API validation date:
OpenAPI/reference revision if identifiable:
Live project test date:
```

Adapters are tolerant of additive unknown fields but fail on missing/changed fields that are required for correct backup semantics.

## Bundle compatibility

Manifest contains:

```json
{
  "format": "pgdumpster",
  "formatVersion": "1.0.0"
}
```

Policy:

- current reader supports the current format major/version contract;
- previous supported schemas are explicitly documented;
- writer emits current schema only;
- unsupported newer schema fails with clear message;
- no best-effort reinterpretation of unknown security-sensitive fields.

## Source-to-target compatibility

Restore planner checks:

- target Postgres compatibility;
- extension availability;
- service/API feature availability;
- Storage type support;
- plan/region constraints;
- known unsupported cross-version transitions.

When exact restore is impossible:

- fail if required exportable state cannot be applied;
- classify platform-generated substitutions explicitly where expected;
- never silently omit.

## Self-hosted Supabase

Full project backup mode is scoped to **hosted Supabase Platform** because Management API/control-plane configuration has no one-to-one self-hosted equivalent.

Do not advertise self-hosted full-project compatibility.

A future separate data-only/self-hosted mode would need its own explicit product contract and is not part of the current acceptance criteria.

## Supabase branches

A branch/environment with independent data is treated as its own backup source. Parent branch metadata can inventory topology, but one backup does not imply all branch databases/data were captured.

## Storage feature compatibility

Adapters are separated by Storage product type:

- File;
- Vector;
- Analytics.

A release may support a feature as `not_applicable` or `not_exportable` when the active platform cannot expose a complete data path. That limitation must be visible in coverage and release notes.

## Encryption compatibility

Use the standard `age` format/tooling rather than a project-specific cipher.

Document the tested `age` implementation/version when release packaging is finalized.

## S3 compatibility

Test at least:

- AWS S3 or a standards-compatible reference;
- one non-AWS S3-compatible target if practical.

Document endpoint quirks; do not hard-code AWS-only assumptions into the destination interface.

## Deprecation

When Supabase deprecates an endpoint:

1. add replacement adapter;
2. support overlap when practical;
3. capability-detect old/new;
4. preserve bundle semantics;
5. remove old path only in a release whose compatibility notes make the break clear.

Legacy Supabase key endpoints must be treated this way rather than assumed permanent.
