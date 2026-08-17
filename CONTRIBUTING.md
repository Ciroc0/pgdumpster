# Contributing

Issues, bug reports, feature requests, documentation corrections, and discussions are welcome when they preserve pgDumpster's central invariant: a “complete” result may not silently omit project state.

## Code contributions

External code contributions are not currently accepted.

A Contributor License Agreement will be introduced before external code contributions are accepted. Do not open a code pull request until the maintainer publishes that agreement and explicitly enables code contributions.

## Before coding

Read:

1. `docs/01-product-requirements.md`
2. `docs/02-coverage-matrix.md`
3. `docs/09-security-threat-model.md`
4. `docs/10-testing.md`
5. `docs/13-acceptance-criteria.md`
6. `docs/23-current-status.md`

## Development setup

The repository provides the following development verification commands:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

If the implementation chooses a different package manager, update all repository docs consistently before merging. Do not leave contradictory setup instructions.

## Maintainer pull requests

A PR must:

- describe the behavior change;
- include tests;
- update docs for user-visible behavior;
- include coverage-registry changes for new Supabase state surfaces;
- explain security implications for secret/archive/restore changes;
- keep all required checks green.

## Non-negotiable review points

Changes may not:

- hide a failed adapter behind success;
- remove a coverage component without justification;
- weaken checksum/integrity verification;
- print secret values;
- concatenate shell commands with untrusted input;
- write Storage logical keys directly as filesystem paths;
- make destructive restore implicit;
- auto-enable billable target resources;
- add telemetry by default;
- substitute mocked E2E for required hosted release validation.

## Tests

Run the implementation-defined full verification command before submitting.

At minimum the repository must expose scripts for:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Use the specialized test commands described in `docs/10-testing.md` as they are implemented.

## Commit scope

Prefer small, coherent commits with tests and docs in the same change.

Do not commit:

- `.env`;
- access tokens;
- database URLs;
- backup bundles;
- live test credentials;
- decrypted secret output;
- customer data.

## API changes

When Supabase changes an API:

1. link the official source in the PR;
2. update adapter/fixture;
3. update coverage semantics if necessary;
4. run hosted contract/E2E validation;
5. update compatibility docs.

## Code style

Follow the formatter/linter checked into the repository. Avoid clever abstraction that obscures backup semantics or error handling.

## License

Repository use is governed by the PolyForm Shield License 1.0.0. Nothing submitted through an issue, discussion, or documentation correction grants a separate commercial license.
