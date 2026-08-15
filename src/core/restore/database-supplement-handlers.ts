import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import pg from "pg";

import {
  collectDatabaseCatalogState,
  databaseCatalogStateSchema,
  type DatabaseCatalogState,
  type DatabaseWebhookState,
} from "../../database/catalog-state.js";
import {
  dumpExcludedDatabaseComponent,
  dumpManagedSchemaCustomizations,
  dumpMigrationHistory,
  type DatabaseDumpArtifact,
  type DatabaseDumpOptions,
} from "../../database/dump.js";
import {
  collectDatabaseInventory,
  type DatabaseInventory,
} from "../../database/inventory.js";
import { restoreSqlArtifact } from "../../database/restore.js";
import type { SecretValue } from "../../security/secret-value.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const { Client } = pg;

export type DatabaseSupplementRestoreComponent =
  | "database.migrations"
  | "database.auth_storage_customizations"
  | "database.cron"
  | "database.queues"
  | "database.webhooks";

type DedicatedComponent = "database.cron" | "database.queues";

interface WebhookMutationClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface DatabaseSupplementRestoreDependencies {
  restoreSqlArtifact?: typeof restoreSqlArtifact | undefined;
  dumpMigrationHistory?: typeof dumpMigrationHistory | undefined;
  dumpManagedSchemaCustomizations?:
    | typeof dumpManagedSchemaCustomizations
    | undefined;
  dumpExcludedDatabaseComponent?:
    | typeof dumpExcludedDatabaseComponent
    | undefined;
  collectDatabaseInventory?: typeof collectDatabaseInventory | undefined;
  collectDatabaseCatalogState?: typeof collectDatabaseCatalogState | undefined;
  createWebhookClient?:
    | ((connectionString: string) => WebhookMutationClient)
    | undefined;
}

export interface DatabaseSupplementRestoreOptions {
  bundleRoot: string;
  targetDatabaseUrl: SecretValue;
  conflictPolicy: "fail" | "replace";
  dependencies?: DatabaseSupplementRestoreDependencies | undefined;
}

const NON_SEMANTIC_DUMP_LINE = /^-- \\(?:un)?restrict [A-Za-z0-9]+$/u;
const MIGRATION_SCHEMA = "database/migration-history-schema.sql";
const MIGRATION_DATA = "database/migration-history-data.sql";
const CUSTOMIZATION = "database/auth-storage-customizations.sql";
const DEDICATED_ARTIFACTS: Readonly<Record<DedicatedComponent, string>> = {
  "database.cron": "database/cron-data.sql",
  "database.queues": "database/queues-data.sql",
};

function restoreError(
  code: string,
  message: string,
  component: DatabaseSupplementRestoreComponent,
  category: "restore_policy" | "integrity" | "database" = "restore_policy",
  cause?: unknown,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category,
    message,
    retryable: false,
    component,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function normalizedSqlSha256(filename: string): Promise<string> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "Database restore evidence must be a regular file.",
      "database.migrations",
      "integrity",
    );
  }
  const hash = createHash("sha256");
  const input = createReadStream(filename, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!NON_SEMANTIC_DUMP_LINE.test(line)) hash.update(line).update("\n");
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return hash.digest("hex");
}

async function sqlDumpContainsRows(filename: string): Promise<boolean> {
  const input = createReadStream(filename, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let copy = false;
  try {
    for await (const line of lines) {
      if (/^COPY\s.+\sFROM stdin;$/iu.test(line)) {
        copy = true;
        continue;
      }
      if (copy && line === "\\.") {
        copy = false;
        continue;
      }
      if (copy && line.length > 0) return true;
      if (/^INSERT\s+INTO\s/iu.test(line)) return true;
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

function aggregateFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

function assertArtifactSet(
  component: DatabaseSupplementRestoreComponent,
  artifacts: readonly string[],
  expected: readonly string[],
): void {
  const actual = [...artifacts].sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "Restore artifact set does not match its database component.",
      component,
    );
  }
}

async function sourceHashes(
  options: DatabaseSupplementRestoreOptions,
  component: DatabaseSupplementRestoreComponent,
  artifacts: readonly string[],
): Promise<string[]> {
  const hashes: string[] = [];
  for (const artifact of artifacts) {
    hashes.push(
      await normalizedSqlSha256(
        await resolveBundleArtifact(options.bundleRoot, artifact),
      ),
    );
  }
  return hashes;
}

async function withTargetEvidence<T>(
  options: DatabaseSupplementRestoreOptions,
  signal: AbortSignal | undefined,
  callback: (input: {
    outputDirectory: string;
    inventory: DatabaseInventory;
  }) => Promise<T>,
): Promise<T> {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-restore-db-evidence-"),
  );
  try {
    const inventory = await (
      options.dependencies?.collectDatabaseInventory ?? collectDatabaseInventory
    )(options.targetDatabaseUrl, outputDirectory, signal);
    return await callback({ outputDirectory, inventory });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function dumpOptions(
  options: DatabaseSupplementRestoreOptions,
  outputDirectory: string,
  signal: AbortSignal | undefined,
): DatabaseDumpOptions {
  return {
    connectionString: options.targetDatabaseUrl,
    outputDirectory,
    ...(signal === undefined ? {} : { signal }),
  };
}

function conflict(
  component: DatabaseSupplementRestoreComponent,
  message: string,
): PgDumpsterError {
  return restoreError("RESTORE_TARGET_CONFLICT", message, component);
}

function artifactById(
  artifacts: readonly DatabaseDumpArtifact[],
  id: DatabaseDumpArtifact["id"],
): DatabaseDumpArtifact | undefined {
  return artifacts.find((artifact) => artifact.id === id);
}

function createMigrationHandler(
  options: DatabaseSupplementRestoreOptions,
): RestoreActionHandler {
  const restore = options.dependencies?.restoreSqlArtifact ?? restoreSqlArtifact;
  const dump = options.dependencies?.dumpMigrationHistory ?? dumpMigrationHistory;

  const source = async (artifacts: readonly string[]) => {
    assertArtifactSet(
      "database.migrations",
      artifacts,
      [MIGRATION_SCHEMA, MIGRATION_DATA],
    );
    const hashes = await sourceHashes(options, "database.migrations", [
      MIGRATION_SCHEMA,
      MIGRATION_DATA,
    ]);
    return {
      schemaHash: hashes[0]!,
      dataHash: hashes[1]!,
      fingerprint: aggregateFingerprint(hashes),
    };
  };

  const target = (signal?: AbortSignal) =>
    withTargetEvidence(options, signal, async ({ outputDirectory, inventory }) => {
      const artifacts = await dump(
        dumpOptions(options, outputDirectory, signal),
        inventory,
      );
      if (artifacts.length === 0) return undefined;
      const schema = artifactById(artifacts, "database.migrations_schema");
      const data = artifactById(artifacts, "database.migrations_data");
      if (schema === undefined || data === undefined || artifacts.length !== 2) {
        throw restoreError(
          "RESTORE_TARGET_EVIDENCE_INVALID",
          "Target migration-history evidence is incomplete.",
          "database.migrations",
          "integrity",
        );
      }
      return {
        schemaPath: schema.path,
        dataPath: data.path,
        schemaHash: await normalizedSqlSha256(schema.path),
        dataHash: await normalizedSqlSha256(data.path),
      };
    });

  return {
    async apply(context): Promise<RestoreActionResult> {
      const desired = await source(context.action.artifacts);
      const observed = await target(context.signal);
      if (observed === undefined) {
        await restore({
          bundleRoot: options.bundleRoot,
          artifact: MIGRATION_SCHEMA,
          targetDatabaseUrl: options.targetDatabaseUrl,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        await restore({
          bundleRoot: options.bundleRoot,
          artifact: MIGRATION_DATA,
          targetDatabaseUrl: options.targetDatabaseUrl,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
        return { fingerprint: desired.fingerprint };
      }
      if (observed.schemaHash !== desired.schemaHash) {
        throw conflict(
          "database.migrations",
          "Target migration-history schema differs from the source backup.",
        );
      }
      if (observed.dataHash === desired.dataHash) {
        return { fingerprint: desired.fingerprint };
      }
      if (await sqlDumpContainsRows(observed.dataPath)) {
        throw conflict(
          "database.migrations",
          "Target migration history contains different existing rows.",
        );
      }
      await restore({
        bundleRoot: options.bundleRoot,
        artifact: MIGRATION_DATA,
        targetDatabaseUrl: options.targetDatabaseUrl,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return { fingerprint: desired.fingerprint };
    },

    async verify(context): Promise<boolean> {
      const desired = await source(context.action.artifacts);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== desired.fingerprint
      ) {
        return false;
      }
      const observed = await target(context.signal);
      return (
        observed !== undefined &&
        observed.schemaHash === desired.schemaHash &&
        observed.dataHash === desired.dataHash
      );
    },
  };
}

function createCustomizationHandler(
  options: DatabaseSupplementRestoreOptions,
): RestoreActionHandler {
  const restore = options.dependencies?.restoreSqlArtifact ?? restoreSqlArtifact;
  const dump =
    options.dependencies?.dumpManagedSchemaCustomizations ??
    dumpManagedSchemaCustomizations;

  const desiredHash = async (artifacts: readonly string[]) => {
    assertArtifactSet(
      "database.auth_storage_customizations",
      artifacts,
      [CUSTOMIZATION],
    );
    return (
      await sourceHashes(options, "database.auth_storage_customizations", [
        CUSTOMIZATION,
      ])
    )[0]!;
  };

  const targetHash = (signal?: AbortSignal) =>
    withTargetEvidence(options, signal, async ({ outputDirectory, inventory }) => {
      const artifacts = await dump(
        dumpOptions(options, outputDirectory, signal),
        inventory,
      );
      if (artifacts.length === 0) return undefined;
      if (artifacts.length !== 1) {
        throw restoreError(
          "RESTORE_TARGET_EVIDENCE_INVALID",
          "Target managed-schema customization evidence is ambiguous.",
          "database.auth_storage_customizations",
          "integrity",
        );
      }
      return normalizedSqlSha256(artifacts[0]!.path);
    });

  return {
    async apply(context): Promise<RestoreActionResult> {
      const expected = await desiredHash(context.action.artifacts);
      const observed = await targetHash(context.signal);
      if (observed === expected) return { fingerprint: expected };
      if (observed !== undefined) {
        throw conflict(
          "database.auth_storage_customizations",
          "Target Auth/Storage managed-schema customizations differ from the source.",
        );
      }
      await restore({
        bundleRoot: options.bundleRoot,
        artifact: CUSTOMIZATION,
        targetDatabaseUrl: options.targetDatabaseUrl,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return { fingerprint: expected };
    },
    async verify(context): Promise<boolean> {
      const expected = await desiredHash(context.action.artifacts);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      ) {
        return false;
      }
      return (await targetHash(context.signal)) === expected;
    },
  };
}

function createDedicatedHandler(
  options: DatabaseSupplementRestoreOptions,
  component: DedicatedComponent,
): RestoreActionHandler {
  const restore = options.dependencies?.restoreSqlArtifact ?? restoreSqlArtifact;
  const dump =
    options.dependencies?.dumpExcludedDatabaseComponent ??
    dumpExcludedDatabaseComponent;
  const artifact = DEDICATED_ARTIFACTS[component];

  const desiredHash = async (artifacts: readonly string[]) => {
    assertArtifactSet(component, artifacts, [artifact]);
    return (await sourceHashes(options, component, [artifact]))[0]!;
  };

  const target = (signal?: AbortSignal) =>
    withTargetEvidence(options, signal, async ({ outputDirectory, inventory }) => {
      const result = await dump(
        dumpOptions(options, outputDirectory, signal),
        inventory,
        component,
      );
      return {
        path: result.path,
        hash: await normalizedSqlSha256(result.path),
      };
    });

  return {
    async apply(context): Promise<RestoreActionResult> {
      const expected = await desiredHash(context.action.artifacts);
      const observed = await target(context.signal);
      if (observed.hash === expected) return { fingerprint: expected };
      if (await sqlDumpContainsRows(observed.path)) {
        throw conflict(
          component,
          "Target dedicated database state contains different existing rows.",
        );
      }
      await restore({
        bundleRoot: options.bundleRoot,
        artifact,
        targetDatabaseUrl: options.targetDatabaseUrl,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return { fingerprint: expected };
    },
    async verify(context): Promise<boolean> {
      const expected = await desiredHash(context.action.artifacts);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      ) {
        return false;
      }
      return (await target(context.signal)).hash === expected;
    },
  };
}

function webhookIdentity(webhook: DatabaseWebhookState): string {
  return `${webhook.schema}\0${webhook.table}\0${webhook.name}`;
}

function webhookStructure(webhook: DatabaseWebhookState): unknown {
  return {
    schema: webhook.schema,
    table: webhook.table,
    name: webhook.name,
    functionSchema: webhook.functionSchema,
    functionName: webhook.functionName,
    definition: webhook.definition,
  };
}

function webhookFingerprint(state: DatabaseCatalogState): string {
  return createHash("sha256")
    .update(canonicalJson(state.webhooks))
    .digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function triggerTarget(webhook: DatabaseWebhookState): string {
  return `${quoteIdentifier(webhook.schema)}.${quoteIdentifier(webhook.table)}`;
}

function dropWebhook(webhook: DatabaseWebhookState): string {
  return `DROP TRIGGER IF EXISTS ${quoteIdentifier(webhook.name)} ON ${triggerTarget(webhook)}`;
}

function enabledStatement(webhook: DatabaseWebhookState): string | undefined {
  const prefix = `ALTER TABLE ${triggerTarget(webhook)} `;
  if (webhook.enabled === "O") return undefined;
  if (webhook.enabled === "D")
    return `${prefix}DISABLE TRIGGER ${quoteIdentifier(webhook.name)}`;
  if (webhook.enabled === "R")
    return `${prefix}ENABLE REPLICA TRIGGER ${quoteIdentifier(webhook.name)}`;
  return `${prefix}ENABLE ALWAYS TRIGGER ${quoteIdentifier(webhook.name)}`;
}

function validateWebhookDefinition(webhook: DatabaseWebhookState): void {
  if (
    webhook.functionSchema !== "supabase_functions" ||
    webhook.functionName !== "http_request" ||
    !/^CREATE\s+TRIGGER\s/iu.test(webhook.definition) ||
    webhook.definition.includes("\0")
  ) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "Database Webhook definition is outside the supported trigger contract.",
      "database.webhooks",
      "integrity",
    );
  }
}

function webhookStatements(
  source: DatabaseCatalogState,
  target: DatabaseCatalogState,
  conflictPolicy: "fail" | "replace",
): string[] {
  const statements: string[] = [];
  const sourceById = new Map(
    source.webhooks.map((webhook) => [webhookIdentity(webhook), webhook]),
  );
  const targetById = new Map(
    target.webhooks.map((webhook) => [webhookIdentity(webhook), webhook]),
  );

  for (const webhook of source.webhooks) validateWebhookDefinition(webhook);

  for (const targetWebhook of target.webhooks) {
    if (sourceById.has(webhookIdentity(targetWebhook))) continue;
    if (conflictPolicy === "fail") {
      throw conflict(
        "database.webhooks",
        "Target has a Database Webhook absent from the source backup.",
      );
    }
    statements.push(dropWebhook(targetWebhook));
  }

  for (const sourceWebhook of source.webhooks) {
    const targetWebhook = targetById.get(webhookIdentity(sourceWebhook));
    if (targetWebhook === undefined) {
      statements.push(sourceWebhook.definition);
      const enabled = enabledStatement(sourceWebhook);
      if (enabled !== undefined) statements.push(enabled);
      continue;
    }
    if (
      canonicalJson(webhookStructure(targetWebhook)) ===
      canonicalJson(webhookStructure(sourceWebhook))
    ) {
      if (targetWebhook.enabled !== sourceWebhook.enabled) {
        const enabled = enabledStatement(sourceWebhook);
        statements.push(
          enabled ??
            `ALTER TABLE ${triggerTarget(sourceWebhook)} ENABLE TRIGGER ${quoteIdentifier(sourceWebhook.name)}`,
        );
      }
      continue;
    }
    if (conflictPolicy === "fail") {
      throw conflict(
        "database.webhooks",
        "Target Database Webhook definition differs from the source backup.",
      );
    }
    statements.push(dropWebhook(targetWebhook), sourceWebhook.definition);
    const enabled = enabledStatement(sourceWebhook);
    if (enabled !== undefined) statements.push(enabled);
  }
  return statements;
}

async function readSourceCatalog(
  options: DatabaseSupplementRestoreOptions,
  artifacts: readonly string[],
): Promise<DatabaseCatalogState> {
  assertArtifactSet(
    "database.webhooks",
    artifacts,
    ["database/catalog-state.json"],
  );
  const filename = await resolveBundleArtifact(
    options.bundleRoot,
    "database/catalog-state.json",
  );
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_388_608) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "Database Webhook catalog is not a bounded regular file.",
      "database.webhooks",
      "integrity",
    );
  }
  try {
    return databaseCatalogStateSchema.parse(
      JSON.parse(await readFile(filename, "utf8")) as unknown,
    );
  } catch (error) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "Database Webhook catalog is invalid.",
      "database.webhooks",
      "integrity",
      error,
    );
  }
}

async function collectTargetCatalog(
  options: DatabaseSupplementRestoreOptions,
  signal?: AbortSignal,
): Promise<DatabaseCatalogState> {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-webhook-verify-"),
  );
  try {
    return await (
      options.dependencies?.collectDatabaseCatalogState ??
      collectDatabaseCatalogState
    )(options.targetDatabaseUrl, outputDirectory, signal);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function createWebhookHandler(
  options: DatabaseSupplementRestoreOptions,
): RestoreActionHandler {
  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await readSourceCatalog(options, context.action.artifacts);
      const expected = webhookFingerprint(source);
      const target = await collectTargetCatalog(options, context.signal);
      if (webhookFingerprint(target) === expected) return { fingerprint: expected };
      const statements = webhookStatements(
        source,
        target,
        options.conflictPolicy,
      );
      if (statements.length === 0) return { fingerprint: expected };
      const client =
        options.dependencies?.createWebhookClient?.(
          options.targetDatabaseUrl.expose(),
        ) ??
        new Client({
          connectionString: options.targetDatabaseUrl.expose(),
          application_name: "pgdumpster-restore-webhooks",
          connectionTimeoutMillis: 10_000,
          statement_timeout: 60_000,
        });
      try {
        await client.connect();
        await client.query("BEGIN");
        for (const statement of statements) {
          context.signal?.throwIfAborted();
          await client.query(statement);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        context.signal?.throwIfAborted();
        throw restoreError(
          "DATABASE_WEBHOOK_RESTORE_FAILED",
          "Database Webhook restore failed.",
          "database.webhooks",
          "database",
          error,
        );
      } finally {
        await client.end().catch(() => undefined);
      }
      return { fingerprint: expected };
    },
    async verify(context): Promise<boolean> {
      const source = await readSourceCatalog(options, context.action.artifacts);
      const expected = webhookFingerprint(source);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      ) {
        return false;
      }
      return (
        webhookFingerprint(await collectTargetCatalog(options, context.signal)) ===
        expected
      );
    },
  };
}

export function createDatabaseSupplementRestoreHandlers(
  options: DatabaseSupplementRestoreOptions,
): Readonly<Record<DatabaseSupplementRestoreComponent, RestoreActionHandler>> {
  return {
    "database.migrations": createMigrationHandler(options),
    "database.auth_storage_customizations": createCustomizationHandler(options),
    "database.cron": createDedicatedHandler(options, "database.cron"),
    "database.queues": createDedicatedHandler(options, "database.queues"),
    "database.webhooks": createWebhookHandler(options),
  };
}
