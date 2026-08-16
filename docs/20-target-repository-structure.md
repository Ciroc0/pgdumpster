# 20 - Target repository structure

Codex should converge on a repository close to this shape. Exact filenames may change when an implementation concern justifies it, but the separation of responsibilities is binding.

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── codeql.yml
│   │   ├── live-e2e.yml
│   │   └── release.yml
│   ├── dependabot.yml
│   └── PULL_REQUEST_TEMPLATE.md
├── docs/
├── examples/
├── schemas/
├── spec/
│   └── coverage-registry.yaml
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── doctor.ts
│   │   │   ├── backup.ts
│   │   │   ├── inspect.ts
│   │   │   ├── verify.ts
│   │   │   ├── coverage.ts
│   │   │   └── restore.ts
│   │   ├── output/
│   │   └── main.ts
│   ├── core/
│   │   ├── backup/
│   │   ├── restore/
│   │   ├── parity/
│   │   ├── consistency/
│   │   ├── coverage/
│   │   ├── manifest/
│   │   ├── checkpoint/
│   │   ├── config/
│   │   ├── errors/
│   │   └── capabilities/
│   ├── adapters/
│   │   ├── management-api/
│   │   ├── database/
│   │   │   ├── base-dump/
│   │   │   ├── schema-coverage/
│   │   │   ├── auth-data/
│   │   │   ├── migrations/
│   │   │   ├── managed-customizations/
│   │   │   ├── cron/
│   │   │   ├── queues/
│   │   │   ├── webhooks/
│   │   │   ├── vault/
│   │   │   └── extension-state/
│   │   ├── auth/
│   │   ├── api-keys/
│   │   ├── edge-functions/
│   │   ├── storage-files/
│   │   ├── storage-vectors/
│   │   ├── storage-analytics/
│   │   ├── realtime/
│   │   ├── postgrest/
│   │   ├── domains/
│   │   ├── network/
│   │   └── project/
│   ├── destinations/
│   │   ├── local/
│   │   └── s3/
│   ├── archive/
│   ├── crypto/
│   ├── security/
│   ├── transport/
│   └── utils/
├── tests/
│   ├── unit/
│   ├── contract/
│   │   └── fixtures/
│   ├── integration/
│   │   ├── local-supabase/
│   │   └── management-api-simulator/
│   ├── stress/
│   ├── security/
│   └── e2e/
│       └── hosted/
├── AGENTS.md
├── PLANS.md
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── NOTICE
├── LICENSING.md
├── README.md
├── SECURITY.md
├── SUPPORT.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── ...
```

## Module boundaries

### CLI

The CLI parses arguments and renders output. It must not contain direct Supabase API calls or database backup logic.

### Core orchestration

Core owns:

- use-case state machines;
- coverage invariant;
- consistency coordinator;
- checkpoint/resume;
- restore DAG;
- parity;
- final result semantics.

Core depends on adapter interfaces, not endpoint implementation details.

### Adapters

One adapter family per independently evolving Supabase surface.

Every adapter implements:

- capability probe;
- inventory/fingerprint where mutable;
- backup;
- restore planning;
- restore execution where possible;
- parity comparison;
- contract tests;
- sensitivity classification.

### Database adapter split

Database is intentionally not one `database.ts` file. Supabase's normal dump excludes important schemas; separate adapters make the omission visible and testable.

### Destinations

Destinations receive logical bundle writes and cannot influence component completeness.

### Security

Security primitives/redaction/path validation are shared infrastructure. Individual adapters cannot invent their own weaker redaction.

## Package exports

The CLI can expose an internal library API later, but public library API stability is not required for the first release unless deliberately documented.

Do not export internal secret-bearing types merely for convenience.

## Generated files

Generated API clients/schemas must:

- be reproducible;
- identify upstream source/revision;
- not contain tokens;
- be checked for breaking changes in CI.

## Build output

`dist/` is generated and not committed unless the chosen publishing model explicitly requires it.

Source maps must be reviewed for accidental embedded source secrets. Test fixtures contain fake data only.
