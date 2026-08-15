# Compatibility policy

## Purpose

Supabase, Node.js, PostgreSQL tooling and operating systems evolve. pgDumpster documents separately what is **supported by policy**, what has been **exercised by CI**, and what still requires full hosted E2E evidence.

Status snapshot: **2026-08-15**.

## Runtime matrix

- **Node.js**: supported policy is `>=22.15.0 <23` or `>=24 <25`. Earlier GitHub CI checkpoints exercised Node 22 and 24 successfully. The account's current Actions quota is exhausted, so newly pushed commits may be blocked before meaningful execution until reset.
- **pnpm**: the repository `packageManager` pin is authoritative. Frozen-lockfile installs are part of the CI contract and were exercised on the earlier validated CI checkpoint.
- **Supabase CLI**: supported policy is `>=2.111.0 <3.0.0`; the development dependency is pinned to `2.111.0`. Fixture/CLI behavior is validated and dedicated live observations also exist for newer 2.x behavior. Full hosted recovery E2E is still pending.
- **Hosted Supabase**: compatibility is based on dated official Management API/CLI/product contracts. Endpoint-specific fixture/live observations exist; full source-to-target parity is still pending.
- **PostgreSQL**: the target is a Supabase-managed PostgreSQL version compatible with captured logical state. Database backup/restore primitives are tested; the dedicated hosted projects are PostgreSQL 17 generation. Full source-to-target parity is still pending.
- **Ubuntu**: first-class. Earlier GitHub-hosted CI exercised Node 22 and 24 successfully.
- **macOS**: first-class. Earlier GitHub-hosted CI exercised Node 22 and 24 successfully.
- **Windows**: first-class. Earlier GitHub-hosted CI exercised Node 22 and 24; development also exercises Windows/Docker Desktop.
- **`age`**: standard age format is the target. Tooling can be detected by `doctor`, but the CLI encryption path is not implemented yet.
- **S3-compatible destination**: this remains a target requirement. AWS SDK dependencies/interface groundwork exists, but publication/recovery is not implemented yet.

The latest local full gate after the consistency/resume hardening slice is `pnpm check` with **85 test files / 500 tests passing**. That local result does not replace cross-platform CI evidence, and the earlier OS matrix does not replace the platform-independent hosted Supabase recovery E2E.

## Management API contracts

The repository stores dated contract snapshots and runtime validators for the Management API surfaces used by adapters. Additive unknown fields are tolerated where the contract permits them; missing/changed fields required for correct semantics fail closed.

Each release must record the contract validation date/revision and re-run drift checks for changed dependencies.

## Live-validation language

Use these terms precisely:

- **fixture-tested**: behavior is covered by deterministic local fixtures/mocks;
- **live-observed**: a specific endpoint/CLI behavior was observed against a dedicated hosted test project;
- **live-E2E validated**: the complete source → encrypted verified backup → offline verify → fresh-target restore → semantic parity procedure passed.

The repository currently has fixture-tested and selected live-observed surfaces. It must **not** describe the overall product as live-E2E validated yet.

## Bundle compatibility

The writer emits the current bundle schema only. Readers reject unsupported security-sensitive schema changes rather than guessing.

Current format contract is `1.0.0` in the manifest/coverage schema family used by the implementation.

## Source-to-target compatibility

The restore planner/executor must account for:

- target PostgreSQL compatibility;
- extension availability;
- service/API capabilities;
- Storage product support;
- plan/region constraints;
- platform-generated substitutions such as replacement API keys;
- known non-exportable state.

Exact restore must never be claimed when the platform prevents exact export/import.

## Self-hosted Supabase

Full-project mode is scoped to **hosted Supabase Platform** because the hosted Management API/control-plane does not have a one-to-one self-hosted equivalent.

Do not advertise self-hosted full-project compatibility.

## Supabase branches

A branch/environment with independent data is a separate backup source. Parent branch metadata may inventory topology, but one project backup does not imply child branch data was captured.

## Storage feature compatibility

File, Vector and Analytics Storage are separate coverage surfaces. Metadata-only coverage can never be promoted to complete data backup.

## Backup consistency compatibility

`verified`, `best-effort` and `quiesced` are implemented over the source evidence exposed by the supported hosted-platform interfaces. The contract is application-level cross-service stabilization, not a platform-wide atomic transaction primitive.

Adapters fail closed on source-contract shapes or cleanup conditions that would make the requested consistency guarantee unsafe.

## Encryption and S3

Standard `age` and S3-compatible publication remain binding release requirements, but their current CLI paths are deliberately blocked until implementation/test evidence exists. Documentation and release notes must not imply they are usable before those gates pass.

## Deprecation

When Supabase deprecates an endpoint:

1. add/validate the replacement adapter;
2. support overlap when practical;
3. capability-detect old/new;
4. preserve bundle semantics;
5. remove the old path only with explicit compatibility notes.
