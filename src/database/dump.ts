import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import type { DatabaseInventory, SchemaClassification } from "./inventory.js";
import { postgresConnectionWithoutPassword } from "./connection.js";
import {
  resolveSupabaseCommand,
  runProcess,
  type ResolvedCommand,
  type RunProcessOptions,
  type ProcessResult,
} from "../utils/process.js";

export interface DatabaseDumpDependencies {
  resolveSupabaseCommand?: () => Promise<ResolvedCommand>;
  runProcess?: (
    command: string,
    args: readonly string[],
    options: RunProcessOptions,
  ) => Promise<ProcessResult>;
}

export interface DatabaseDumpOptions {
  /**
   * A direct connection is required for restore and remains available for
   * environments that do not use a linked Supabase workspace. For backup,
   * linked mode lets the CLI obtain its short-lived credential without
   * placing a database password in pgDumpster configuration.
   */
  connectionString?: SecretValue | undefined;
  linked?: boolean | undefined;
  outputDirectory: string;
  signal?: AbortSignal | undefined;
  dependencies?: DatabaseDumpDependencies;
}

export interface DatabaseDumpArtifact {
  id:
    | "database.roles"
    | "database.schema"
    | "database.data"
    | "database.migrations_schema"
    | "database.migrations_data"
    | "database.auth_storage_customizations"
    | "auth.data"
    | "storage.file_metadata"
    | "database.cron"
    | "database.queues"
    | "database.vault_data";
  path: string;
  bytes: number;
}

interface DumpSpec {
  id: DatabaseDumpArtifact["id"];
  filename: string;
  flags: readonly string[];
}

const BASE_STRUCTURE_DUMPS: readonly DumpSpec[] = [
  { id: "database.roles", filename: "roles.sql", flags: ["--role-only"] },
  { id: "database.schema", filename: "schema.sql", flags: [] },
];

function baseDataDump(inventory: DatabaseInventory): DumpSpec {
  const schemas = inventory.schemas
    .filter(({ classification }) => classification === "base_dump")
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (schemas.length === 0) {
    throw new PgDumpsterError({
      code: "DATABASE_DUMP_SCOPE_INVALID",
      category: "database",
      message: "No base database schema was discovered for logical data dump.",
      retryable: false,
      component: "database.data",
    });
  }
  return {
    id: "database.data",
    filename: "data.sql",
    flags: ["--use-copy", "--data-only", "--schema", schemas.join(",")],
  };
}

const MIGRATION_DUMPS: readonly DumpSpec[] = [
  {
    id: "database.migrations_schema",
    filename: "migration-history-schema.sql",
    flags: ["--schema", "supabase_migrations"],
  },
  {
    id: "database.migrations_data",
    filename: "migration-history-data.sql",
    flags: ["--use-copy", "--data-only", "--schema", "supabase_migrations"],
  },
];

function hasClassification(
  inventory: DatabaseInventory,
  classification: SchemaClassification,
): boolean {
  return inventory.schemas.some(
    (schema) => schema.classification === classification,
  );
}

function excludedStateDumps(inventory: DatabaseInventory): DumpSpec[] {
  const dumps: DumpSpec[] = [];
  if (hasClassification(inventory, "auth_data")) {
    dumps.push({
      id: "auth.data",
      filename: "auth-data.sql",
      flags: ["--use-copy", "--data-only", "--schema", "auth"],
    });
  }
  if (hasClassification(inventory, "storage_metadata")) {
    dumps.push({
      id: "storage.file_metadata",
      filename: "storage-metadata.sql",
      flags: [
        "--use-copy",
        "--data-only",
        "--schema",
        "storage",
        "--exclude",
        "storage.buckets_vectors,storage.vector_indexes",
      ],
    });
  }
  if (hasClassification(inventory, "cron")) {
    dumps.push({
      id: "database.cron",
      filename: "cron-data.sql",
      flags: ["--use-copy", "--data-only", "--schema", "cron"],
    });
  }
  if (hasClassification(inventory, "queues")) {
    const schemas = inventory.schemas
      .filter(({ classification }) => classification === "queues")
      .map(({ name }) => name)
      .join(",");
    dumps.push({
      id: "database.queues",
      filename: "queues-data.sql",
      flags: ["--use-copy", "--data-only", "--schema", schemas],
    });
  }
  if (
    hasClassification(inventory, "vault_data") &&
    (inventory.vaultSecretCount ?? 0) > 0
  ) {
    dumps.push({
      id: "database.vault_data",
      filename: "vault-data.sql",
      flags: ["--use-copy", "--data-only", "--schema", "vault"],
    });
  }
  return dumps;
}

function dumpError(spec: DumpSpec, result: ProcessResult): PgDumpsterError {
  return new PgDumpsterError({
    code: "DATABASE_DUMP_FAILED",
    category: "database",
    message: `Supabase CLI database dump failed for ${spec.id}.`,
    retryable: false,
    component:
      spec.id === "database.migrations_schema" ||
      spec.id === "database.migrations_data"
        ? "database.migrations"
        : spec.id,
    details: { exitCode: result.exitCode },
  });
}

export async function dumpLogicalDatabase(
  options: DatabaseDumpOptions,
  inventory: DatabaseInventory,
): Promise<DatabaseDumpArtifact[]> {
  return executeDumps(options, [
    ...BASE_STRUCTURE_DUMPS,
    baseDataDump(inventory),
  ]);
}

export async function dumpLogicalDatabaseComponent(
  options: DatabaseDumpOptions,
  component: "database.roles" | "database.schema" | "database.data",
  inventory?: DatabaseInventory,
): Promise<DatabaseDumpArtifact> {
  const spec =
    component === "database.data"
      ? inventory === undefined
        ? undefined
        : baseDataDump(inventory)
      : BASE_STRUCTURE_DUMPS.find(({ id }) => id === component);
  if (spec === undefined) {
    throw new PgDumpsterError({
      code: "DATABASE_DUMP_COMPONENT_INVALID",
      category: "database",
      message: "Logical database dump component is unsupported.",
      retryable: false,
      component,
    });
  }
  const [artifact] = await executeDumps(options, [spec]);
  return artifact!;
}

export async function dumpMigrationHistory(
  options: DatabaseDumpOptions,
  inventory: DatabaseInventory,
): Promise<DatabaseDumpArtifact[]> {
  return hasClassification(inventory, "migration_history")
    ? executeDumps(options, MIGRATION_DUMPS)
    : [];
}

export async function dumpManagedSchemaCustomizations(
  options: DatabaseDumpOptions,
  inventory: DatabaseInventory,
): Promise<DatabaseDumpArtifact[]> {
  if (
    !hasClassification(inventory, "auth_data") &&
    !hasClassification(inventory, "storage_metadata")
  )
    return [];
  const outputStat = await lstat(options.outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink())
    throw new Error("Database dump output must be a real directory");
  if ((options.connectionString === undefined) === (options.linked !== true)) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message:
        "Managed-schema diff requires exactly one source: a connection string or linked Supabase project.",
      retryable: false,
    });
  }
  const resolved = await (
    options.dependencies?.resolveSupabaseCommand ?? resolveSupabaseCommand
  )();
  const connection =
    options.connectionString === undefined
      ? undefined
      : postgresConnectionWithoutPassword(options.connectionString.expose());
  const sourceArgs =
    connection === undefined
      ? (["--linked"] as const)
      : (["--db-url", connection.safeUrl] as const);
  const databaseDirectory = path.join(options.outputDirectory, "database");
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    databaseDirectory,
    `auth-storage-customizations.sql.partial-${randomUUID()}`,
  );
  try {
    const result = await (options.dependencies?.runProcess ?? runProcess)(
      resolved.command,
      [
        ...resolved.prefixArgs,
        "db",
        "diff",
        ...sourceArgs,
        "--schema",
        "auth,storage",
        "--output",
        temporaryPath,
      ],
      {
        signal: options.signal,
        timeoutMs: 900_000,
        maxOutputBytes: 1_048_576,
        environment:
          connection === undefined
            ? process.env
            : { ...process.env, PGPASSWORD: connection.password },
      },
    );
    if (result.exitCode !== 0)
      throw new PgDumpsterError({
        code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
        category: "database",
        message: "Supabase managed-schema customization diff failed.",
        retryable: false,
        component: "database.auth_storage_customizations",
        details: { exitCode: result.exitCode },
      });
    let temporaryStat;
    try {
      temporaryStat = await lstat(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (
      !temporaryStat.isFile() ||
      temporaryStat.isSymbolicLink() ||
      temporaryStat.size === 0 ||
      temporaryStat.size > 67_108_864
    )
      throw new PgDumpsterError({
        code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
        category: "platform_contract",
        message: "Supabase managed-schema diff output is invalid or oversized.",
        retryable: false,
        component: "database.auth_storage_customizations",
      });
    const finalPath = path.join(
      databaseDirectory,
      "auth-storage-customizations.sql",
    );
    await link(temporaryPath, finalPath);
    await rm(temporaryPath);
    return [
      {
        id: "database.auth_storage_customizations",
        path: finalPath,
        bytes: temporaryStat.size,
      },
    ];
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function dumpExcludedDatabaseState(
  options: DatabaseDumpOptions,
  inventory: DatabaseInventory,
): Promise<DatabaseDumpArtifact[]> {
  if (inventory.unclassifiedPersistentSchemas.length > 0) {
    throw new PgDumpsterError({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      category: "database",
      message:
        "Unknown extension-owned persistent schemas require a versioned adapter before backup can continue.",
      retryable: false,
      component: "database.extension_state",
      details: { schemas: inventory.unclassifiedPersistentSchemas },
    });
  }
  return executeDumps(options, excludedStateDumps(inventory));
}

export async function dumpExcludedDatabaseComponent(
  options: DatabaseDumpOptions,
  inventory: DatabaseInventory,
  component:
    | "auth.data"
    | "storage.file_metadata"
    | "database.cron"
    | "database.queues"
    | "database.vault_data",
): Promise<DatabaseDumpArtifact> {
  const spec = excludedStateDumps(inventory).find(({ id }) => id === component);
  if (spec === undefined) {
    throw new PgDumpsterError({
      code: "DATABASE_DUMP_COMPONENT_INVALID",
      category: "database",
      message: "Dedicated database dump component is unavailable.",
      retryable: false,
      component,
    });
  }
  const [artifact] = await executeDumps(options, [spec]);
  return artifact!;
}

async function executeDumps(
  options: DatabaseDumpOptions,
  specs: readonly DumpSpec[],
): Promise<DatabaseDumpArtifact[]> {
  options.signal?.throwIfAborted();
  const outputStat = await lstat(options.outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error("Database dump output must be a real directory");
  }
  const databaseDirectory = path.join(options.outputDirectory, "database");
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
  const resolved = await (
    options.dependencies?.resolveSupabaseCommand ?? resolveSupabaseCommand
  )();
  const processRunner = options.dependencies?.runProcess ?? runProcess;
  if ((options.connectionString === undefined) === (options.linked !== true)) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message:
        "Database dump requires exactly one source: a connection string or linked Supabase project.",
      retryable: false,
    });
  }
  const connection =
    options.connectionString === undefined
      ? undefined
      : postgresConnectionWithoutPassword(options.connectionString.expose());
  const environment =
    connection === undefined
      ? process.env
      : {
          ...process.env,
          PGPASSWORD: connection.password,
        };
  const artifacts: DatabaseDumpArtifact[] = [];

  for (const spec of specs) {
    options.signal?.throwIfAborted();
    const finalPath = path.join(databaseDirectory, spec.filename);
    const temporaryPath = `${finalPath}.partial-${randomUUID()}`;
    const sourceArgs =
      connection === undefined
        ? (["--linked"] as const)
        : (["--db-url", connection.safeUrl] as const);
    const args = [
      ...resolved.prefixArgs,
      "db",
      "dump",
      ...sourceArgs,
      "--file",
      temporaryPath,
      ...spec.flags,
    ];
    try {
      const result = await processRunner(resolved.command, args, {
        signal: options.signal,
        timeoutMs: 3_600_000,
        maxOutputBytes: 1_048_576,
        environment,
      });
      if (result.exitCode !== 0) throw dumpError(spec, result);
      const temporaryStat = await stat(temporaryPath);
      if (!temporaryStat.isFile() || temporaryStat.size === 0) {
        throw new PgDumpsterError({
          code: "DATABASE_DUMP_FAILED",
          category: "database",
          message: `Supabase CLI produced an empty dump for ${spec.id}.`,
          retryable: false,
          component: spec.id,
        });
      }
      await link(temporaryPath, finalPath);
      await rm(temporaryPath);
      artifacts.push({
        id: spec.id,
        path: finalPath,
        bytes: temporaryStat.size,
      });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return artifacts;
}
