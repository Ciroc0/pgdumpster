import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";

import {
  collectDatabaseCatalogState,
  databaseCatalogStateSchema,
  type DatabaseCatalogState,
  type PublicationState,
  type PublicationTableState,
} from "../../database/catalog-state.js";
import type { SecretValue } from "../../security/secret-value.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler } from "./executor.js";

const { Client } = pg;

interface PublicationMutationClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface PublicationRestoreHandlerOptions {
  bundleRoot: string;
  targetDatabaseUrl: SecretValue;
  conflictPolicy: "fail" | "replace";
  collectTarget?: typeof collectDatabaseCatalogState;
  createClient?:
    ((connectionString: string) => PublicationMutationClient) | undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function publishList(publication: PublicationState): string {
  return (["insert", "update", "delete", "truncate"] as const)
    .filter((operation) => publication.publish[operation])
    .join(",");
}

function tableIdentity(table: PublicationTableState): string {
  return `${table.schema}\0${table.table}`;
}

function tableDefinition(table: PublicationTableState): string {
  const relation = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
  const columns =
    table.columns === null
      ? ""
      : ` (${table.columns.map(quoteIdentifier).join(", ")})`;
  const rowFilter =
    table.rowFilter === null ? "" : ` WHERE (${table.rowFilter})`;
  return `${relation}${columns}${rowFilter}`;
}

function publicationSnapshot(state: DatabaseCatalogState) {
  return {
    publications: state.publications,
    publicationTables: state.publicationTables,
  };
}

function fingerprint(state: DatabaseCatalogState): string {
  return createHash("sha256")
    .update(canonicalJson(publicationSnapshot(state)))
    .digest("hex");
}

async function readSourceState(
  options: PublicationRestoreHandlerOptions,
  artifacts: string[],
): Promise<DatabaseCatalogState> {
  if (
    artifacts.length !== 1 ||
    artifacts[0] !== "database/catalog-state.json"
  ) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "restore_policy",
      message: "Publication restore requires database/catalog-state.json.",
      retryable: false,
      component: "database.publications",
    });
  }
  const filename = await resolveBundleArtifact(
    options.bundleRoot,
    artifacts[0],
  );
  const fileStat = await lstat(filename);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.size > 8_388_608
  )
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Publication catalog is not a bounded regular file.",
      retryable: false,
      component: "database.publications",
    });
  try {
    return databaseCatalogStateSchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Publication catalog artifact is invalid.",
      retryable: false,
      component: "database.publications",
      cause: error,
    });
  }
}

async function collectTargetState(
  options: PublicationRestoreHandlerOptions,
  signal?: AbortSignal,
): Promise<DatabaseCatalogState> {
  const output = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-publication-verify-"),
  );
  try {
    return await (options.collectTarget ?? collectDatabaseCatalogState)(
      options.targetDatabaseUrl,
      output,
      signal,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

function createPublicationStatements(
  publication: PublicationState,
  tables: PublicationTableState[],
): string[] {
  const name = quoteIdentifier(publication.name);
  const create = publication.allTables
    ? `CREATE PUBLICATION ${name} FOR ALL TABLES WITH (publish = ${quoteLiteral(publishList(publication))})`
    : `CREATE PUBLICATION ${name} WITH (publish = ${quoteLiteral(publishList(publication))})`;
  return [
    create,
    ...tables.map(
      (table) =>
        `ALTER PUBLICATION ${name} ADD TABLE ${tableDefinition(table)}`,
    ),
    `ALTER PUBLICATION ${name} OWNER TO ${quoteIdentifier(publication.owner)}`,
  ];
}

function reconciliationStatements(
  source: DatabaseCatalogState,
  target: DatabaseCatalogState,
  conflictPolicy: "fail" | "replace",
): string[] {
  const statements: string[] = [];
  const sourceByName = new Map(
    source.publications.map((item) => [item.name, item]),
  );
  const targetByName = new Map(
    target.publications.map((item) => [item.name, item]),
  );
  for (const targetPublication of target.publications) {
    if (!sourceByName.has(targetPublication.name)) {
      if (conflictPolicy === "fail")
        throw new PgDumpsterError({
          code: "RESTORE_TARGET_CONFLICT",
          category: "restore_policy",
          message: "Target has a publication absent from the source backup.",
          retryable: false,
          component: "database.publications",
          details: { publication: targetPublication.name },
        });
      statements.push(
        `DROP PUBLICATION ${quoteIdentifier(targetPublication.name)}`,
      );
    }
  }
  for (const sourcePublication of source.publications) {
    const targetPublication = targetByName.get(sourcePublication.name);
    const sourceTables = source.publicationTables.filter(
      ({ publication }) => publication === sourcePublication.name,
    );
    if (targetPublication === undefined) {
      statements.push(
        ...createPublicationStatements(sourcePublication, sourceTables),
      );
      continue;
    }
    if (targetPublication.allTables !== sourcePublication.allTables) {
      if (conflictPolicy === "fail")
        throw new PgDumpsterError({
          code: "RESTORE_TARGET_CONFLICT",
          category: "restore_policy",
          message: "Publication all-tables mode conflicts with the source.",
          retryable: false,
          component: "database.publications",
          details: { publication: sourcePublication.name },
        });
      statements.push(
        `DROP PUBLICATION ${quoteIdentifier(sourcePublication.name)}`,
        ...createPublicationStatements(sourcePublication, sourceTables),
      );
      continue;
    }
    const name = quoteIdentifier(sourcePublication.name);
    if (
      canonicalJson(targetPublication.publish) !==
      canonicalJson(sourcePublication.publish)
    )
      statements.push(
        `ALTER PUBLICATION ${name} SET (publish = ${quoteLiteral(publishList(sourcePublication))})`,
      );
    if (targetPublication.owner !== sourcePublication.owner)
      statements.push(
        `ALTER PUBLICATION ${name} OWNER TO ${quoteIdentifier(sourcePublication.owner)}`,
      );
    if (!sourcePublication.allTables) {
      const targetTables = target.publicationTables.filter(
        ({ publication }) => publication === sourcePublication.name,
      );
      const sourceTableMap = new Map(
        sourceTables.map((table) => [tableIdentity(table), table]),
      );
      const targetTableMap = new Map(
        targetTables.map((table) => [tableIdentity(table), table]),
      );
      for (const targetTable of targetTables) {
        const sourceTable = sourceTableMap.get(tableIdentity(targetTable));
        if (
          sourceTable === undefined ||
          canonicalJson(sourceTable) !== canonicalJson(targetTable)
        )
          statements.push(
            `ALTER PUBLICATION ${name} DROP TABLE ${quoteIdentifier(targetTable.schema)}.${quoteIdentifier(targetTable.table)}`,
          );
      }
      for (const sourceTable of sourceTables) {
        const targetTable = targetTableMap.get(tableIdentity(sourceTable));
        if (
          targetTable === undefined ||
          canonicalJson(sourceTable) !== canonicalJson(targetTable)
        )
          statements.push(
            `ALTER PUBLICATION ${name} ADD TABLE ${tableDefinition(sourceTable)}`,
          );
      }
    }
  }
  return statements;
}

export function createPublicationRestoreHandler(
  options: PublicationRestoreHandlerOptions,
): RestoreActionHandler {
  return {
    async apply(context) {
      const source = await readSourceState(options, context.action.artifacts);
      const target = await collectTargetState(options, context.signal);
      const expected = fingerprint(source);
      if (fingerprint(target) === expected) return { fingerprint: expected };
      const statements = reconciliationStatements(
        source,
        target,
        options.conflictPolicy,
      );
      const client =
        options.createClient?.(options.targetDatabaseUrl.expose()) ??
        new Client({
          connectionString: options.targetDatabaseUrl.expose(),
          application_name: "pgdumpster-restore-publications",
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
        throw new PgDumpsterError({
          code: "DATABASE_PUBLICATION_RESTORE_FAILED",
          category: "database",
          message: "PostgreSQL publication restore failed.",
          retryable: false,
          component: "database.publications",
          cause: error,
        });
      } finally {
        await client.end().catch(() => undefined);
      }
      return { fingerprint: expected };
    },

    async verify(context) {
      const source = await readSourceState(options, context.action.artifacts);
      const expected = fingerprint(source);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      )
        return false;
      return (
        fingerprint(await collectTargetState(options, context.signal)) ===
        expected
      );
    },
  };
}
