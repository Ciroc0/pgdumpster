# 21 - Maintainer and release runbook

## Routine dependency/API maintenance

When Supabase or the Supabase CLI changes:

1. read current official release/API documentation;
2. regenerate/update typed contracts if used;
3. diff endpoint/field semantics;
4. run contract fixtures;
5. run live source capability scan;
6. update adapters;
7. run full test suite;
8. run hosted source→target restore E2E;
9. update compatibility/source-of-truth docs;
10. release only after parity is green.

A new Supabase product/state surface is a coverage event, not merely a documentation event.

## Adding a new coverage component

1. add the ID to `spec/coverage-registry.yaml`;
2. add it to `docs/02-coverage-matrix.md`;
3. define sensitivity;
4. define capability states;
5. implement source adapter;
6. define backup representation;
7. define restore semantics or `not_exportable`;
8. define parity;
9. add contract fixtures;
10. add live E2E fixture if practical;
11. update manifest/coverage schemas only if shape changes;
12. update acceptance criteria when the component changes the product promise.

No release can report `complete` while a newly known project-scoped state surface is simply ignored.

## Investigating a failed real backup

Start with:

```bash
pgdumpster inspect <bundle-or-workdir>
pgdumpster coverage <bundle-or-workdir>
```

Then use the structured error code/run ID and sanitized log.

Never ask a user to post a decrypted bundle or credential.

## Incident: possible secret leak

1. stop publication/release if ongoing;
2. identify exact output surface;
3. assume exposed real credentials need rotation;
4. reproduce with canary secrets;
5. patch central redaction/data flow, not only one print statement;
6. add regression test;
7. audit adjacent error/log paths;
8. follow `SECURITY.md` disclosure process;
9. release security fix;
10. document required user rotations without reproducing secrets.

## Incident: corrupt backup accepted as valid

This is critical.

1. preserve the failing fixture;
2. block releases;
3. identify missing integrity invariant;
4. make `verify` fail closed;
5. ensure `restore` verifies before mutation;
6. add corruption test;
7. review all bundle readers for equivalent bypass.

## Incident: restore partially mutates target

Because there is no cross-service rollback:

1. stop further actions;
2. retain action log;
3. do not auto-delete target;
4. report exact applied/pending actions;
5. fix idempotency/ordering issue;
6. resume only after planner revalidation or use a new fresh target;
7. add failure-injection test at that boundary.

## Live E2E project hygiene

Use dedicated test projects only.

Rules:

- no production/customer data;
- credentials stored only in protected CI secret store;
- canary secret values;
- deterministic seed;
- reset/recreate state between runs;
- target must never be a production ref;
- billable resources excluded unless dedicated test budget/policy explicitly permits them;
- logs/artifacts sanitized.

## Release candidate checklist

Run:

```text
format check
lint
strict typecheck
build
unit
contract
local integration
fault injection
stress
archive security
secret leakage
OS matrix
live hosted E2E
semantic parity
package install smoke test
```

Then:

- inspect changelog;
- inspect compatibility matrix;
- revalidate current Supabase contracts;
- scan repository/history for credentials;
- generate SBOM/provenance;
- publish from protected CI.

## Post-release smoke

From the published artifact on a clean environment:

```bash
pgdumpster --version
pgdumpster doctor --help
pgdumpster backup --help
pgdumpster verify --help
pgdumpster restore --help
```

Run a small test-project encrypted backup and verify it.

## Deprecating behavior

Deprecations affecting recovery semantics need:

- changelog entry;
- warning period where practical;
- migration instructions;
- bundle compatibility analysis;
- tests reading old artifacts where support is promised.

Do not silently change `complete` semantics in a patch release.

## Platform limitation review

At every release, review all `not_exportable` reasons.

If Supabase has since added an export/import path, implement it. “Platform limitation” must not become permanent technical debt through inertia.

## Backward recovery principle

Keep one or more historical test bundles created by released versions with fake data. New readers should verify/read supported historical formats according to the compatibility policy.

Never put live secrets into compatibility fixtures.
