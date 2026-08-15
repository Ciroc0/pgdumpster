# pgDumpster

pgDumpster is a source-available backup, verification, inspection, and restore tool for **hosted Supabase Platform projects**. The repository, package, and CLI name are `pgdumpster`; the project domain is `pgdumpster.com`.

Its product promise is strict:

> Capture every project-scoped state surface that Supabase exposes and makes exportable, copy every recoverable data object, verify the result, and explicitly inventory anything that Supabase itself does not allow to be exported or recreated exactly.

A successful run must never silently omit a registered component.

## Current development status

pgDumpster is **not release-complete yet**. The repository contains a substantial working implementation, but several explicit release gates remain.

Current branch snapshot as of 2026-08-15:

- strict TypeScript ESM build and CLI are implemented;
- the 55-component coverage registry is enforced during backup finalization;
- hosted-project capture adapters exist for database state, Auth, API keys, Edge, Vault, File Storage, specialized Storage and the documented Management API/control-plane surfaces;
- secure bundle generation, SHA-256 integrity, offline inspect/coverage/verify, deterministic `.tar.zst`, checkpointing and resume are implemented;
- restore planning, checkpoints, database/control-plane/publication/Vault handlers and semantic verification primitives are implemented;
- the user-facing restore command currently exposes a verified **dry run only**; `--apply` is deliberately blocked until the complete executor/parity path is wired through the CLI and live-tested;
- backup consistency supports `verified`, `best-effort` and `quiesced`; omitted consistency defaults to `verified`;
- all 10 product backup steps participate in the consistency contract with source snapshots, drift handling and step-owned partial cleanup;
- best-effort reports `drift_detected` when observable drift occurs and preserves that evidence through resume;
- hard-interruption resume cleanup is step-scoped and symlink-safe;
- standard `age` encryption is implemented for local backup publication;
- encrypted backups are published as `.tar.zst.age`; successful publication removes the plaintext archive and working bundle;
- encrypted `.tar.zst.age` inputs are supported by inspect/coverage/verify and restore dry-run when config supplies `encryption.identityFile`;
- plaintext secret-bearing backups still require explicit `--allow-plaintext-secrets` when `age` is not configured;
- S3-compatible publication is still deliberately blocked;
- latest local validation: **92 test files / 541 tests, PASS**;
- current global coverage is **94.45% statements / 90.51% branches / 91.89% functions / 95.64% lines**, with all independent 90% thresholds passing;
- earlier GitHub CI quality/test/integration/security/OS-matrix evidence passed, but the account's current Actions quota is exhausted, so newly pushed workflow results are not presently a meaningful branch-quality signal;
- CodeQL analysis has previously run to SARIF generation, but result publication/status is blocked by repository code-scanning configuration/access;
- the mandatory hosted source → encrypted backup → offline verify → fresh-target restore → semantic-parity E2E has **not** passed yet.

The authoritative implementation ledger is [PLANS.md](PLANS.md). A concise current snapshot is maintained in [docs/23-current-status.md](docs/23-current-status.md). The numbered product documents describe the required end state unless they explicitly label a section as current implementation status.

## Why this exists

A Supabase database backup is not a complete project backup. Project state also exists in Storage object bytes, Auth configuration, API keys, JWT signing-key metadata, Edge Functions and secrets, Realtime/PostgREST/Storage service configuration, networking/domain configuration, Vault key material and other platform settings.

pgDumpster is designed to unify those surfaces into one deterministic, coverage-accounted backup bundle.

The current database backend uses the Supabase CLI and a reachable Docker-compatible daemon. A linked Supabase workspace is the preferred backup source because the CLI can obtain a short-lived database login; an explicit database URL remains available for unlinked automation. Docker is not bundled with pgDumpster.

## Target capability contract

The binding target includes:

- full logical PostgreSQL state plus explicitly captured state omitted by the normal Supabase dump path;
- Auth data/config, SSO/TPA metadata and signing-key limitations;
- Cron, Queues, Database Webhooks, Vault ciphertext and Vault root-key handling;
- File Storage buckets, metadata and streamed object bytes;
- Vector and Analytics/Iceberg capability adapters with explicit platform limits;
- Edge Function deployed representation and secret inventory;
- modern/legacy API-key handling and protected target rotation mapping;
- Realtime, PostgREST, Storage, database/pooler/SSL, networking/domain, backup schedule, log-drain and project configuration;
- deterministic integrity manifests and complete coverage reporting;
- cross-service verified/best-effort/quiesced consistency semantics;
- resumable backup and restore;
- local and S3-compatible destinations;
- optional standard `age` encryption;
- integrity-first restore followed by semantic parity verification.

A target capability is not considered delivered merely because it appears in this list. Current implementation state is recorded in `PLANS.md` and `docs/23-current-status.md`.

## Encryption

For local encrypted publication, configure `age` in the YAML config with a recipient. pgDumpster creates the deterministic `.tar.zst` transport form internally, encrypts it to `.tar.zst.age`, and removes the normal plaintext archive/workspace after successful publication. `--archive` is not required separately for encrypted output.

Reading an encrypted bundle requires an `encryption.identityFile` reference in config. The identity file path may be relative to the config file. Private identity material is not accepted as a normal CLI flag or printed in output.

`doctor` checks whether `age` tooling is available. A missing executable during encryption/decryption is also mapped to the dependency error domain. A hard process termination can still leave the protected resumable workspace/checkpoint; normal encryption cleanup and crash recovery are separate concerns.

When encryption is not configured, any backup that may contain secrets requires explicit `--allow-plaintext-secrets`.

## Consistency semantics

`verified` is the default backup mode. pgDumpster takes the strongest stable source fingerprints available to each product surface, copies the step, compares post-copy state and retries a drifting step only after its provisional output has been safely removed. Drift that is detected directly during copy is promoted into the same policy.

`quiesced` uses the same observation layer but fails immediately when observable source state changes. It is intended for runs where application writes have deliberately been stopped.

`best-effort` performs a valid copy without verified retry semantics. When pre/post evidence shows source drift, the final manifest reports `drift_detected` rather than falsely claiming verification.

These are application-level cross-service consistency guarantees. Supabase does not expose one atomic transaction spanning PostgreSQL, Storage, Management APIs, Edge and every managed service, so pgDumpster does not claim one.

## “Full backup” semantics

A result is:

- `complete`: every applicable exportable component was backed up and verified according to the active consistency contract;
- `complete_with_platform_limits`: every exportable component succeeded, but the platform prevents one or more values from being exported or recreated exactly;
- `failed`: one or more applicable exportable components failed.

Every registered component has exactly one terminal status:

- `backed_up`
- `not_configured`
- `not_applicable`
- `not_exportable`
- `failed`

No registered component can disappear from the report.

## Scope boundary

pgDumpster backs up **one hosted Supabase project ref**. Organization membership, billing history, account identity, external DNS, SMTP-provider resources, OAuth-provider-side resources, source Git repositories and other third-party systems are outside the project backup boundary.

Branch topology/configuration is inventoried, but each branch is a separate environment and its data must be backed up independently when needed.

## Documentation order

Binding authority is defined in `AGENTS.md`. In particular, product requirements, coverage requirements and acceptance criteria outrank lower-priority implementation documents.

The numbered documentation set is:

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
24. `docs/23-current-status.md` — non-binding current implementation/evidence snapshot

Agent rules: `AGENTS.md`. Implementation ledger: `PLANS.md`.

## Trademark

pgDumpster is an independent third-party project and is not affiliated with, endorsed by, sponsored by, or maintained by Supabase. “Supabase” and related marks belong to their respective owners.

## License

This project is source-available under the [PolyForm Shield License 1.0.0](LICENSE).

Internal and non-competing use is permitted under the license. Using this software to provide a competing hosted, managed, white-label, or commercial backup product or service requires a separate commercial license.

See [LICENSING.md](LICENSING.md) for details.
