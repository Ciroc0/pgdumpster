# Compatibility policy

## Purpose

Supabase, Node.js, PostgreSQL tooling and operating systems evolve. pgDumpster documents separately what is **supported by policy**, what has been **exercised by CI/local gates**, and what still requires full hosted E2E evidence.

Status snapshot: **2026-08-16**.

## Runtime matrix

- **Node.js**: supported policy is `>=22.15.0 <23` or `>=24 <25`. Earlier GitHub CI checkpoints exercised Node 22 and 24 successfully. The account's current Actions quota is exhausted, so newly pushed commits may be blocked before meaningful execution until reset.
- **pnpm**: the repository `packageManager` pin is authoritative. Frozen-lockfile installs are part of the CI contract and were exercised on the earlier validated CI checkpoint.
- **Supabase CLI**: supported policy is `>=2.111.0 <3.0.0`; the development dependency is pinned to `2.111.0`. Fixture/CLI behavior is validated and dedicated live observations also exist for newer 2.x behavior. A disposable hosted recovery has passed with explicit platform limits; a protected release-candidate workflow run remains required.
- **Hosted Supabase**: compatibility is based on dated official Management API/CLI/product contracts. A disposable source-to-clean-target encrypted backup/restore and applicable database/File Storage parity observation passed with explicit platform limits; this does not certify an eventual release candidate.
- **PostgreSQL**: the target is a Supabase-managed PostgreSQL version compatible with captured logical state. Database backup/restore primitives are tested; the dedicated hosted projects are PostgreSQL 17 generation, and the applicable fixture parity checks passed after restore.
- **Ubuntu**: first-class. Earlier GitHub-hosted CI exercised Node 22 and 24 successfully.
- **macOS**: first-class. Earlier GitHub-hosted CI exercised Node 22 and 24 successfully.
- **Windows**: first-class. Earlier GitHub-hosted CI exercised Node 22 and 24; development also exercises Windows/Docker Desktop. The standard `age` publication path was specifically exercised locally on Windows, including the writable-descriptor durability path required before `fsync`.
- **`age`**: standard `age` recipient encryption/decryption is implemented for local archive publication/input. Tooling is detected by `doctor`; runtime operations also fail through the dependency error domain when the executable cannot be started.
- **S3-compatible destination**: publication/recovery is locally implemented and fault-injection tested. Scoped Cloudflare R2 interoperability passed encrypted publication, completion-marker, materialization and offline verification. AWS and MinIO have not been exercised.

The latest complete local gate after the hosted-E2E harness slice is `pnpm check` plus `pnpm test:coverage` with **116 test files / 726 tests passing** and **94.61% statements / 90.04% branches / 92.55% functions / 95.65% lines**. That local result does not replace current-candidate cross-platform CI evidence, and the earlier OS matrix plus disposable hosted observation do not replace a protected release-candidate E2E.

## Management API contracts

The repository stores dated contract snapshots and runtime validators for the Management API surfaces used by adapters. Additive unknown fields are tolerated where the contract permits them; missing/changed fields required for correct semantics fail closed.

Each release must record the contract validation date/revision and re-run drift checks for changed dependencies.

## Live-validation language

Use these terms precisely:

- **fixture-tested**: behavior is covered by deterministic local fixtures/mocks;
- **live-observed**: a specific endpoint/CLI behavior was observed against a dedicated hosted test project;
- **live-E2E validated**: the complete source → encrypted verified backup → offline verify → fresh-target restore → semantic parity procedure passed.

The repository has fixture-tested surfaces, selected live observations and a disposable source-to-clean-target recovery observation. It must **not** describe the overall product or a release candidate as live-E2E validated until the protected release procedure succeeds.

## Bundle compatibility

The writer emits the current bundle schema only. Readers reject unsupported security-sensitive schema changes rather than guessing.

Current format contract is `1.0.0` in the manifest/coverage schema family used by the implementation.

The current reader accepts:

- canonical directory bundle;
- deterministic `.tar.zst` archive;
- `.tar.zst.age` wrapper when an identity-file reference is configured.

Encryption does not change the internal bundle schema/version; it wraps the deterministic packed form.

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

Standard local `age` publication/input is implemented. Current behavior requires a recipient for encrypted backup and an identity-file path reference for encrypted input. Private identity contents are not normal CLI arguments.

S3-compatible publication is implemented with streaming/multipart publication, completion semantics, remote integrity verification and interruption-recovery coverage. Cloudflare R2 is the exercised provider; a release candidate still requires its protected E2E and release workflow gates.

## Deprecation

When Supabase deprecates an endpoint:

1. add/validate the replacement adapter;
2. support overlap when practical;
3. capability-detect old/new;
4. preserve bundle semantics;
5. remove the old path only with explicit compatibility notes.
