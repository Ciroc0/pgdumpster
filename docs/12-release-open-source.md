# Release and public source repository standard

## License

Public source license: **PolyForm Shield License 1.0.0**.

The official license text is reproduced verbatim in `LICENSE`. Required notices and the protected line of business are in `NOTICE`. `LICENSING.md` explains permitted non-competing use and the separately negotiated proprietary commercial-license path without granting that alternative license in the repository.

The project is source-available, not OSI open source. Public copy and package metadata must not describe it as open source. `package.json` uses `SEE LICENSE IN LICENSE` because the license has no standard SPDX identifier.

## Repository minimum

A professional public repository must contain:

```text
README.md
LICENSE
NOTICE
LICENSING.md
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SUPPORT.md
CHANGELOG.md
AGENTS.md
PLANS.md
CODEX_GOAL.md
docs/
schemas/
spec/
examples/
.github/
```

Implementation adds source/package/test/build files.

## Naming

`pgdumpster` is the selected repository, package and CLI name.

Before first public package/repository publication:

1. check package registry availability;
2. check GitHub repository/org naming;
3. perform a basic trademark/name collision search;
4. choose final package/repo name;
5. update badges/install commands atomically.

Do not invent a package-install command until the package actually exists.

### Basic collision check

On 2026-08-16, the exact npm registry lookup returned `404 Not Found`; GitHub's public repository search returned zero `pgdumpster` matches; PyPI returned `404`; and a general web/software search produced no database-product collision. The maintainer has secured `pgdumpster.com`. This is a practical pre-publication name check, not legal trademark clearance; obtain legal advice before relying on the name in a jurisdiction where a formal trademark search is required.

## Trademark statement

The project is independent and is not affiliated with, endorsed by or sponsored by Supabase unless an actual agreement exists.

“Supabase” is used descriptively to identify compatibility.

## Semantic versioning

Use SemVer for CLI/package releases.

Bundle format is independently versioned in `manifest.schemaVersion`.

Rules:

- reader should support documented older bundle versions where feasible;
- writer emits one current canonical version;
- incompatible bundle migration requires explicit migration code/tooling;
- never silently reinterpret old fields.

## Changelog

Maintain `CHANGELOG.md` in Keep a Changelog style.

Every release includes:

- Added;
- Changed;
- Fixed;
- Security;
- Deprecated/Removed when relevant;
- compatibility changes;
- bundle schema changes;
- platform/API coverage changes.

## Release artifacts

Release should include:

- npm package or chosen distribution;
- source tag/archive;
- checksums;
- SBOM;
- provenance/attestation where supported;
- release notes;
- compatibility statement.

Binary packaging can be added only if tested cross-platform.

## CI required checks

On pull request:

1. format check;
2. lint;
3. typecheck;
4. build;
5. unit tests;
6. contract tests;
7. local integration tests;
8. security/path/archive tests;
9. dependency review/static analysis;
10. cross-platform matrix.

Live hosted E2E can run in a protected workflow when secrets are available and must be mandatory for release.

## Release workflow

Protected release flow:

1. clean main branch and release SHA contained in `origin/main`;
2. current-candidate CI and CodeQL green on that exact SHA, with CodeQL results published and findings dispositioned;
3. protected hosted E2E green on that exact SHA;
4. changelog, compatibility matrix and current official-contract review completed;
5. public non-development SemVer candidate plus configured npm trusted publisher;
6. create the matching tag, which triggers the CI release workflow rather than a maintainer-laptop build;
7. let that workflow generate SBOM/provenance, publish the package and create release notes;
8. let that workflow download and integrity-verify the published package, then fresh-install it;
9. let that workflow smoke `pgdumpster --version`, `doctor --help`, `backup --help`, `restore --help`.

If a tagged attempt fails before `npm publish`, do not move or reuse the tag.
Cut a new SemVer candidate, repeat the exact-SHA evidence gates, and tag that
new commit. A failed tag is not registry-publication evidence.

No release from uncommitted local state.

## Dependency policy

Prefer the standard library and small, mature dependencies.

For each runtime dependency ask:

- is it necessary?
- does it handle secrets?
- does it execute code?
- is it maintained?
- can a smaller dependency or built-in API replace it?

Lock exact resolved dependency graph.

## Security releases

Security fixes involving credential exposure, arbitrary filesystem write, command execution, archive escape or destructive restore bypass may require coordinated disclosure and accelerated release.

Never publish exploit details before an appropriate fix window if doing so would materially endanger users.

## Contribution policy

Issues, bug reports, feature requests, documentation corrections, and discussions are welcome. External code contributions are not accepted until the licensor publishes a Contributor License Agreement that preserves the right to offer separate proprietary commercial licenses.

Maintainer-authored changes require tests, user-facing documentation, unchanged coverage invariants, no telemetry without an explicit project decision, and security review for restore/archive/secret changes. See `CONTRIBUTING.md`.

## Governance

Initially maintainer-led.

Technical decisions with durable format/security impact should be recorded in documentation/ADRs when implementation begins.

High-impact examples:

- bundle format changes;
- encryption changes;
- status semantics;
- restore conflict semantics;
- new external destinations;
- new credential sources.

## Issue templates

Public issue forms should collect:

- pgDumpster version;
- OS/Node/Supabase CLI version;
- command mode;
- sanitized logs;
- whether backup/restore is involved;
- expected/actual behavior.

Templates explicitly prohibit posting secrets, DB URLs, PATs, project keys or sensitive backup contents.

## Documentation versioning

Docs in the repository describe the current code on that branch.

Release tags are the authoritative documentation for a released version.

Hosted docs, if added, must identify version and link source revision.

## Definition of public-ready

The repository is not public-ready until:

- no credentials/test secrets exist in git history;
- license/community/security files exist;
- install path is real and tested;
- README examples match actual CLI;
- all release gates pass;
- hosted E2E passes;
- secret leak scan passes;
- source docs list platform limitations accurately.
