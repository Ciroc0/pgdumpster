# pgDumpster

pgDumpster is a CLI for backing up, verifying, inspecting, and restoring one **hosted Supabase project**. It treats a database dump as only one part of recovery: the bundle also accounts for applicable project configuration, Storage, Auth, Edge Functions, API keys, Vault, and other registered surfaces.

It does not claim that Supabase state is one atomic snapshot. When Supabase does not expose a value, or does not let pgDumpster recreate it exactly, the bundle and restore plan report that as a platform/manual limit instead of silently calling recovery complete.

## Start here

The normal recovery path is:

1. Install pgDumpster and its prerequisites.
2. Configure encrypted output with an `age` recipient.
3. Run `doctor` against the source project.
4. Create an encrypted backup.
5. Verify and inspect that exact backup offline.
6. Dry-run a restore to a **different, fresh target project**.
7. Run `restore --apply` only after reviewing the plan.

The commands below are PowerShell examples. Use the matching shell syntax for environment variables on macOS/Linux.

### 1. Install prerequisites

You need Node.js `>=22.15.0 <23` or `>=24 <25`, a supported Supabase CLI (`>=2.111.0 <3.0.0`), a reachable Docker-compatible daemon for the Supabase database workflow, and [`age`](https://age-encryption.org/) for the recommended encrypted path.

```powershell
npm install -g pgdumpster
pgdumpster --version
```

For a source checkout, use the pinned package manager instead:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

### 2. Set source credentials

Set these in the session where you run pgDumpster. Do not put real values in `.env.example`, commit them, or pass a database URL directly on the command line.

```powershell
$env:PGDUMPSTER_PROJECT_REF = "abcdefghijklmnopqrst"
$env:PGDUMPSTER_ACCESS_TOKEN = "<Supabase Management API token>"
$env:PGDUMPSTER_DB_URL = "postgresql://..."
$env:PGDUMPSTER_STORAGE_KEY = "<privileged Storage key>"
```

`doctor` currently requires all four values, including `PGDUMPSTER_DB_URL` and `PGDUMPSTER_STORAGE_KEY`. A linked workspace is preferred for the backup database step, but it does not remove those current `doctor` checks.

### 3. Configure encryption

Copy [examples/backup.config.example.yaml](examples/backup.config.example.yaml) to `pgdumpster.yaml`, then replace the example project ref and `age` recipient. Keep the identity file private; it is required later to read the encrypted backup.

```yaml
projectRef: abcdefghijklmnopqrst

backup:
  output: ./backups
  consistency: verified

encryption:
  mode: age
  recipient: age1replace_with_your_recipient
  identityFile: ./age-identity.txt

destination:
  type: local
```

### 4. Preflight and back up

If the workspace is linked, link it and use `--linked`:

```powershell
supabase link --project-ref $env:PGDUMPSTER_PROJECT_REF
pgdumpster doctor --project-ref $env:PGDUMPSTER_PROJECT_REF
pgdumpster backup --config ./pgdumpster.yaml --project-ref $env:PGDUMPSTER_PROJECT_REF --linked
```

For an unlinked source, replace `--linked` with `--db-url-env PGDUMPSTER_DB_URL`:

```powershell
pgdumpster backup --config ./pgdumpster.yaml --project-ref $env:PGDUMPSTER_PROJECT_REF --db-url-env PGDUMPSTER_DB_URL
```

The successful encrypted command prints the output path and produces a `.tar.zst.age` archive. It creates the `.tar.zst` transport archive itself; do not add `--archive`. On normal success, plaintext staging is removed. A hard interruption can leave the resumable working directory, so protect the output volume.

### 5. Verify and inspect the backup

Use the exact path printed by the backup command. Encrypted input needs the `identityFile` configured above.

```powershell
pgdumpster verify <backup-path>.tar.zst.age --config ./pgdumpster.yaml
pgdumpster coverage <backup-path>.tar.zst.age --config ./pgdumpster.yaml
pgdumpster inspect <backup-path>.tar.zst.age --config ./pgdumpster.yaml
```

Do not treat a backup as recoverable until `verify` succeeds and `coverage` shows a terminal outcome for every component.

### 6. Plan and apply a restore

Restores target a different project. Start with a dry run; it verifies the input and produces an integrity-first plan without mutating the target.

```powershell
$env:PGDUMPSTER_TARGET_PROJECT_REF = "zyxwvutsrqponmlkjihg"
$env:PGDUMPSTER_TARGET_DB_URL = "postgresql://..."

pgdumpster restore <backup-path>.tar.zst.age --config ./pgdumpster.yaml --target-project-ref $env:PGDUMPSTER_TARGET_PROJECT_REF --target-db-url-env PGDUMPSTER_TARGET_DB_URL --dry-run
```

Only after reviewing that plan, run the explicit mutation command:

```powershell
pgdumpster restore <backup-path>.tar.zst.age --config ./pgdumpster.yaml --target-project-ref $env:PGDUMPSTER_TARGET_PROJECT_REF --target-db-url-env PGDUMPSTER_TARGET_DB_URL --apply
```

`--apply` fails before mutation if a planned action has no supported restore handler. It can also produce explicit manual/platform actions—for example where Supabase withholds private source material or cannot import it on the target.

## What the commands do

| Command             | Purpose                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `doctor`            | Checks source credentials, Supabase CLI, Docker, database/Storage access, local capacity, and `age`.                   |
| `backup`            | Creates a coverage-accounted backup. Encryption is recommended; plaintext output requires `--allow-plaintext-secrets`. |
| `verify`            | Validates bundle structure, integrity, and archive safety offline.                                                     |
| `coverage`          | Shows the final result for every registered component.                                                                 |
| `inspect`           | Shows non-secret bundle metadata.                                                                                      |
| `restore --dry-run` | Builds a verified restore plan without target mutation.                                                                |
| `restore --apply`   | Executes a fully supported, preflighted restore plan.                                                                  |

All commands accept `--json` for machine-readable output, `--config <path>` for configuration, and `--non-interactive` for explicit CI use. The CLI is prompt-free; `--non-interactive` does not make restore destructive.

## Important limits and safety rules

- pgDumpster backs up one hosted Supabase project ref. It does not back up organization membership, billing, external DNS/SMTP/OAuth resources, source Git repositories, or historical Storage versions already deleted before backup.
- Branch topology may be inventoried, but each branch/environment with its own data must be backed up separately.
- `verified` is the default consistency mode. It is an application-level stabilization check across observable services, not a single Supabase-wide transaction.
- A plaintext backup can contain highly sensitive data. Use the encrypted path in normal operation. Plaintext output requires explicit `--allow-plaintext-secrets`.
- A `complete_with_platform_limits` or `restored_with_platform_limits` result is not an error, but it requires you to read the associated coverage/plan/parity output and complete listed manual actions.
- Test recovery with a fresh target before relying on a new environment, Supabase configuration, or pgDumpster release.

## Documentation

| Need                                                                  | Read                                          |
| --------------------------------------------------------------------- | --------------------------------------------- |
| Detailed setup, S3 input/output, resume, troubleshooting hand-off     | [User guide](docs/08-setup-user-guide.md)     |
| Every implemented flag, config field, output mode, and exit code      | [CLI reference](docs/07-cli-and-ux.md)        |
| Recovery limitations and common failures                              | [Troubleshooting](docs/16-troubleshooting.md) |
| Compatibility policy and evidence boundaries                          | [Compatibility](docs/17-compatibility.md)     |
| Current implementation and release evidence                           | [Current status](docs/23-current-status.md)   |
| Product requirements, architecture, coverage, and maintainer material | [Documentation index](docs/README.md)         |

The documents above distinguish current implementation from requirements and planned design. The compiled CLI and [CLI reference](docs/07-cli-and-ux.md) are the command contract; [current status](docs/23-current-status.md) is evidence for a specific release, not a promise for future versions.

## License and trademark

pgDumpster is source-available under the [PolyForm Shield License 1.0.0](LICENSE). Internal and non-competing use is permitted; operating a competing hosted, managed, white-label, or commercial backup product/service requires a separate commercial license. See [LICENSING.md](LICENSING.md).

pgDumpster is independent of Supabase and is not affiliated with, endorsed by, sponsored by, or maintained by Supabase. “Supabase” and related marks belong to their respective owners.
