# AGENTS.md

This repository is specification-driven.

## Source-of-truth order

1. `docs/01-product-requirements.md`
2. `docs/02-coverage-matrix.md`
3. `docs/13-acceptance-criteria.md`
4. `docs/03-architecture.md` through `docs/12-release-open-source.md`
5. `spec/coverage-registry.yaml`
6. `schemas/*.schema.json`
7. `README.md`

If documents conflict, resolve the conflict explicitly in `PLANS.md` and update the lower-priority document. Do not silently choose.

## Required workflow

- Read all relevant docs before coding.
- Revalidate unstable Supabase APIs against current official Supabase docs/OpenAPI before implementing adapters.
- Keep `PLANS.md` current with progress, decisions, validation and known platform limits.
- Implement in small vertical slices with tests.
- Run relevant validation after every meaningful change.
- Fix failures before moving on.
- Never declare completion with TODO production paths, placeholder adapters, mocked “real” success, disabled checks, skipped required tests, or undocumented coverage gaps.
- Finish with a self-review and security review.

## Engineering constraints

- TypeScript, strict mode, ESM.
- Explicit Node version support, CI-tested.
- Linux, macOS and Windows are first-class.
- No secrets in logs, errors, snapshots, fixtures, telemetry or Git.
- Never shell-concatenate user-controlled values. Spawn child processes with argument arrays and `shell: false`.
- Use bounded concurrency, cancellation, backoff, resumable checkpoints, atomic writes and SHA-256.
- Runtime-validate every external JSON contract.
- Preserve unknown Supabase response fields safely where useful, but keep normalized state versioned.
- Every adapter outcome must produce a coverage entry.
- Restore is plan-first, integrity-first and safety-first.
- Destructive/billable actions require explicit opt-in.
- Source and target refs must differ by default.
- Archive extraction must prevent path traversal/symlink escapes.
- If Supabase behavior is unclear, verify current official docs/OpenAPI and add a contract test. Never invent behavior.

## Definition of done

All criteria in `docs/13-acceptance-criteria.md` are satisfied; all required CI jobs pass; live managed-Supabase source→backup→deep-verify→clean-target-restore E2E has passed; semantic parity is verified for every applicable exportable component; and all remaining platform limits are explicitly classified rather than hidden.
