# Implementation plan

This is an execution order, not a staged product roadmap. The target remains the complete product defined in the acceptance criteria.

## Rule for every implementation slice

For each slice:

1. implement the smallest coherent subsystem;
2. add tests in the same change;
3. update docs/fixtures;
4. run relevant checks;
5. stop and fix failures before moving on.

Do not accumulate known-red test debt.

## Milestone 0 — repository foundation

Deliver:

- `package.json`;
- TypeScript strict config;
- ESM build;
- package manager lock;
- formatter/linter;
- test runner;
- CLI entry point;
- CI matrix;
- coverage registry loader;
- structured logger/redactor;
- error model.

Validation:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

## Milestone 1 — domain model and bundle core

Implement:

- manifest types/schemas;
- coverage types/schemas;
- component registry;
- bundle writer/reader;
- checksum engine;
- safe path abstraction;
- deterministic serialization;
- `inspect`;
- `coverage`;
- `verify`.

Tests include corrupt/malicious bundle fixtures before network adapters exist.

## Milestone 2 — configuration and doctor

Implement:

- config precedence;
- environment secret resolution;
- Management API auth client;
- database/Supabase CLI preflight;
- Storage credential validation;
- capability discovery;
- dependency/version reporting.

No backup yet until doctor can prove prerequisites.

## Milestone 3 — Management API adapter framework

Implement:

- typed transport;
- pagination;
- retry/rate-limit;
- contract normalization;
- raw+normalized protected payload;
- versioned fixtures;
- adapter registration;
- common list/get/put helpers without hiding endpoint-specific semantics.

Then implement all required control-plane/auth/API/secrets/Vault adapters from the coverage registry.

## Milestone 4 — database engine

Implement supported dump workflow:

- roles;
- schema;
- data;
- migration history;
- managed-schema customization inventory;
- extensions/publications metadata.

Add local integration fixtures and subprocess security tests.

## Milestone 5 — File Storage engine

Implement:

- bucket inventory;
- complete object inventory;
- opaque local addressing;
- streaming download;
- metadata index;
- checksums;
- bounded concurrency;
- retry;
- checkpoint/resume;
- adversarial object-key tests;
- stress/memory tests.

## Milestone 6 — Edge Functions

Implement:

- function enumeration/metadata;
- deployed export/download;
- missing-repository-artifact reporting;
- Edge secret export;
- redaction tests.

## Milestone 7 — Vector and Analytics adapters

Implement dynamic capability discovery.

Do not fake completeness. Adapter status must distinguish catalog/config from actual data.

Add fixtures for API absence/change.

## Milestone 8 — consistency coordinator

Implement:

- canonical pre/post inventory;
- drift diff;
- selective recopy;
- bounded stabilization;
- three consistency modes;
- mutation simulator tests.

Only now can `backup` reach a final complete status.

## Milestone 9 — packaging/encryption/destinations

Implement:

- finalization;
- deterministic archive;
- `age` encryption;
- plaintext policy;
- local output;
- S3-compatible remote output;
- multipart/resume;
- remote final marker.

Add corruption/encryption/interruption tests.

## Milestone 10 — restore planner

Implement a pure dry-run planner first.

Inputs:

- verified backup;
- target capability discovery;
- conflict policy;
- billable policy.

Output: deterministic action graph + manual actions + substitutions.

Unit-test ordering exhaustively.

## Milestone 11 — restore executor

Implement adapters in required dependency order:

1. preflight;
2. Vault;
3. DB roles/schema/data/customizations;
4. Realtime publications;
5. Storage buckets/objects;
6. Vector/Analytics;
7. Edge secrets/functions;
8. Auth;
9. signing/API key handling;
10. service config;
11. networking/domains/billable state;
12. parity verifier.

Add resume/idempotency after each adapter.

## Milestone 12 — semantic parity

Implement cross-project verifier independent enough to catch restore implementation bugs.

Compare normalized logical state, not volatile IDs where the platform generates replacements.

Output a machine-readable and human-readable report.

## Milestone 13 — live hosted test harness

Provision or use dedicated source/target projects.

Seed representative fixtures, execute full encrypted backup and restore, assert parity.

This must include a Vault encryption fixture and real File Storage bytes.

If any surface cannot be created in test account/plan, document the exact constraint and create the strongest dedicated test possible; do not silently skip.

## Milestone 14 — release hardening

Complete:

- threat-model review;
- secret canary scan;
- dependency/static scans;
- SBOM/provenance;
- README examples from actual commands;
- clean-machine install test;
- Windows/macOS/Linux test;
- changelog;
- package naming verification;
- final API-source revalidation.

## Milestone 15 — release candidate

Run all acceptance criteria.

No known P0/P1 bug, secret leak, false-completeness path, restore parity failure or live E2E failure is acceptable.

Tag/publish only from CI after the release gate passes.

## Anti-shortcut rules for Codex

Codex must not:

- narrow the scope to database + Storage;
- call missing components “future work”;
- disable tests to get green CI;
- substitute mocks for the required hosted E2E;
- print secrets to simplify debugging;
- treat HTTP 200 as semantic backup success;
- use an anon key and call visible Storage objects complete;
- claim exact restore for secrets/keys the platform regenerates;
- ignore Vector/Analytics because they are uncommon;
- write raw Storage keys as local filesystem paths;
- auto-enable billable resources;
- add telemetry by default;
- silently catch adapter errors and mark success.

When a current Supabase API makes a requirement impossible, Codex must:

1. prove the limitation from the current official source/API;
2. mark it `not_exportable`;
3. preserve all metadata/evidence that is exportable;
4. add the limitation to coverage and restore reports;
5. continue the rest of the complete implementation.
