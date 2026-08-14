import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";

import { PgDumpsterError } from "../core/errors/error.js";
import { assertSafeBundlePath } from "../security/bundle-path.js";
import type { SecretValue } from "../security/secret-value.js";
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from "../utils/process.js";
import { postgresConnectionWithoutPassword } from "./connection.js";
import type { ExtensionInventory } from "./inventory.js";
import { writeFileAtomic } from "../utils/atomic-file.js";

const { Client } = pg;

export const SUPABASE_POSTGRES_RESTORE_IMAGE =
  "public.ecr.aws/supabase/postgres:17.6.1.155" as const;

export interface RestoreSqlDependencies {
  runProcess?: (
    command: string,
    args: readonly string[],
    options: RunProcessOptions,
  ) => Promise<ProcessResult>;
}

export interface RestoreSqlOptions {
  bundleRoot: string;
  artifact: string;
  targetDatabaseUrl: SecretValue;
  singleTransaction?: boolean | undefined;
  signal?: AbortSignal | undefined;
  dependencies?: RestoreSqlDependencies | undefined;
}

const PLATFORM_MANAGED_ROLE_STATEMENTS = new Set([
  'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
  'GRANT "postgres" TO "cli_login_postgres" WITH INHERIT FALSE GRANTED BY "supabase_admin";',
]);

export function filterPlatformManagedRoleStatements(sql: string): {
  sql: string;
  omittedStatements: string[];
} {
  const omittedStatements: string[] = [];
  const filtered = sql.split("\n").filter((line) => {
    const statement = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!PLATFORM_MANAGED_ROLE_STATEMENTS.has(statement)) return true;
    omittedStatements.push(statement);
    return false;
  });
  return { sql: filtered.join("\n"), omittedStatements };
}

export async function restorePlatformCompatibleRolesArtifact(
  options: RestoreSqlOptions,
): Promise<void> {
  if (path.posix.basename(options.artifact) !== "roles.sql") {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "restore_policy",
      message: "Platform-compatible role restore requires roles.sql.",
      retryable: false,
      component: "database.roles",
    });
  }
  assertSafeBundlePath(options.artifact);
  const sourcePath = path.join(
    options.bundleRoot,
    ...options.artifact.split("/"),
  );
  const [resolvedRoot, resolvedSource] = await Promise.all([
    realpath(options.bundleRoot),
    realpath(sourcePath),
  ]);
  const relative = path.relative(resolvedRoot, resolvedSource);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
      message: "Database role artifact escapes the verified bundle.",
      retryable: false,
    });
  }
  const filtered = filterPlatformManagedRoleStatements(
    await readFile(resolvedSource, "utf8"),
  );
  if (filtered.omittedStatements.length === 0) {
    await restoreSqlArtifact(options);
    return;
  }
  const temporary = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-roles-restore-"),
  );
  try {
    await writeFileAtomic(path.join(temporary, "roles.sql"), filtered.sql, {
      signal: options.signal,
      mode: 0o600,
    });
    await restoreSqlArtifact({
      ...options,
      bundleRoot: temporary,
      artifact: "roles.sql",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface RestoreExtensionClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface EnsureDatabaseExtensionsOptions {
  targetDatabaseUrl: SecretValue;
  sourceExtensions: readonly ExtensionInventory[];
  targetExtensions: readonly ExtensionInventory[];
  signal?: AbortSignal | undefined;
  createClient?:
    ((connectionString: string) => RestoreExtensionClient) | undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function ensureDatabaseExtensions(
  options: EnsureDatabaseExtensionsOptions,
): Promise<void> {
  const targetByName = new Map(
    options.targetExtensions.map((extension) => [extension.name, extension]),
  );
  const missing: ExtensionInventory[] = [];
  for (const source of options.sourceExtensions) {
    const target = targetByName.get(source.name);
    if (target === undefined) {
      missing.push(source);
      continue;
    }
    if (target.version !== source.version || target.schema !== source.schema) {
      throw new PgDumpsterError({
        code: "DATABASE_EXTENSION_CONFLICT",
        category: "database",
        message:
          "Target extension version or schema differs from the source backup.",
        retryable: false,
        component: "database.extensions",
        details: {
          extension: source.name,
          sourceVersion: source.version,
          targetVersion: target.version,
          sourceSchema: source.schema,
          targetSchema: target.schema,
        },
      });
    }
  }
  if (missing.length === 0) return;
  const client =
    options.createClient?.(options.targetDatabaseUrl.expose()) ??
    new Client({
      connectionString: options.targetDatabaseUrl.expose(),
      application_name: "pgdumpster-restore-extensions",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
    });
  try {
    await client.connect();
    for (const extension of missing) {
      options.signal?.throwIfAborted();
      await client.query(
        `create extension if not exists ${quoteIdentifier(extension.name)} with schema ${quoteIdentifier(extension.schema)} version ${quoteLiteral(extension.version)}`,
      );
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "DATABASE_EXTENSION_RESTORE_FAILED",
      category: "database",
      message: "Required PostgreSQL extension creation failed.",
      retryable: false,
      component: "database.extensions",
      cause: error,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function restoreSqlArtifact(
  options: RestoreSqlOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  assertSafeBundlePath(options.artifact);
  if (!options.artifact.endsWith(".sql")) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "restore_policy",
      message: "Database restore artifact must be a SQL file.",
      retryable: false,
    });
  }
  const rootStat = await lstat(options.bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
      message: "Restore bundle root must be a real directory.",
      retryable: false,
    });
  }
  const absoluteArtifact = path.join(
    options.bundleRoot,
    ...options.artifact.split("/"),
  );
  const [resolvedRoot, resolvedArtifact] = await Promise.all([
    realpath(options.bundleRoot),
    realpath(absoluteArtifact),
  ]);
  const relative = path.relative(resolvedRoot, resolvedArtifact);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
      message: "Database restore artifact escapes the verified bundle.",
      retryable: false,
    });
  }
  const artifactStat = await lstat(resolvedArtifact);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
      message: "Database restore artifact must be a regular file.",
      retryable: false,
    });
  }
  const connection = postgresConnectionWithoutPassword(
    options.targetDatabaseUrl.expose(),
  );
  const containerPath = `/backup/${options.artifact}`;
  const args = [
    "run",
    "--rm",
    "--pull",
    "missing",
    "--env",
    "PGPASSWORD",
    "--volume",
    `${resolvedRoot}:/backup:ro`,
    SUPABASE_POSTGRES_RESTORE_IMAGE,
    "psql",
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    ...(options.singleTransaction === false ? [] : ["--single-transaction"]),
    "--dbname",
    connection.safeUrl,
    "--file",
    containerPath,
  ];
  const runner = options.dependencies?.runProcess ?? runProcess;
  const processResult = await runner("docker", args, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: 3_600_000,
    maxOutputBytes: 1_048_576,
    environment: { ...process.env, PGPASSWORD: connection.password },
  });
  if (processResult.exitCode !== 0) {
    throw new PgDumpsterError({
      code: "DATABASE_RESTORE_FAILED",
      category: "database",
      message: "PostgreSQL logical restore failed.",
      retryable: false,
      details: { exitCode: processResult.exitCode, artifact: options.artifact },
    });
  }
}
