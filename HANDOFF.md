# Codex handoff

This directory is intended to be placed at the root of a new repository before Codex starts implementation.

## Use

1. Put the complete contents of this directory in the repository root.
2. Open Codex at the repository root.
3. Ensure Codex can read `AGENTS.md`.
4. Give Codex the exact contents of `CODEX_GOAL.txt` as the `/goal`.
5. Let Codex update `PLANS.md` before implementation.
6. Do not accept “done” until `docs/13-acceptance-criteria.md` and the live hosted Supabase E2E gate are satisfied.

## Authority

Binding order is defined in `AGENTS.md`.

The machine-oriented component list is `spec/coverage-registry.yaml`.

The Codex goal is intentionally short; the repository documentation contains the detailed requirements.

## Important release boundary

Codex can implement and locally test nearly everything without production credentials. However, the finished product is not release-complete until the dedicated hosted Supabase source→backup→verify→fresh-target-restore→parity test has passed.

If live test credentials are not available, Codex must leave that release gate visibly unfulfilled rather than declaring the product finished.

## Naming

The canonical brand is `pgDumpster`; repository, package, and CLI are `pgdumpster`; the domain is `pgdumpster.com`. Registry availability and the published install path must still be verified before README contains an install command.
