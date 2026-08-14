import { mkdir } from "node:fs/promises";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import { canonicalJson } from "../utils/canonical-json.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import {
  createLinkedDatabaseQuery,
  type LinkedDatabaseQueryDependencies,
} from "./linked-query.js";

const { Client } = pg;

const extensionRowSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  schema: z.string().min(1),
});

const schemaRowSchema = z.object({
  name: z.string().min(1),
  extension: z.string().nullable(),
  persistent_table_count: z.coerce.number().int().nonnegative(),
  persistent_bytes: z.coerce.bigint().nonnegative(),
});

const vaultSecretCountRowSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
});

export const databaseInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    extensions: z
      .array(
        z
          .object({
            name: z.string().min(1),
            version: z.string().min(1),
            schema: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    schemas: z
      .array(
        z
          .object({
            name: z.string().min(1),
            extension: z.string().nullable(),
            persistentTableCount: z.number().int().nonnegative(),
            persistentBytes: z.string().regex(/^\d+$/u),
            classification: z.enum([
              "base_dump",
              "auth_data",
              "storage_metadata",
              "migration_history",
              "cron",
              "queues",
              "webhook_runtime",
              "vault_data",
              "managed_runtime",
              "extension_state",
              "unclassified_persistent",
            ]),
          })
          .strict(),
      )
      .default([]),
    unclassifiedPersistentSchemas: z.string().array().default([]),
    vaultSecretCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export type SchemaClassification =
  | "base_dump"
  | "auth_data"
  | "storage_metadata"
  | "migration_history"
  | "cron"
  | "queues"
  | "webhook_runtime"
  | "vault_data"
  | "managed_runtime"
  | "extension_state"
  | "unclassified_persistent";

export interface ExtensionInventory {
  name: string;
  version: string;
  schema: string;
}

export interface SchemaInventory {
  name: string;
  extension: string | null;
  persistentTableCount: number;
  persistentBytes: string;
  classification: SchemaClassification;
}

export type DatabaseInventory = z.infer<typeof databaseInventorySchema>;

export interface CatalogRows {
  extensions: unknown[];
  schemas: unknown[];
  vaultSecrets?: unknown[] | undefined;
}

export interface DatabaseInventoryClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface DatabaseInventoryDependencies {
  createClient?: (connectionString: string) => DatabaseInventoryClient;
}

export type LinkedDatabaseInventoryDependencies =
  LinkedDatabaseQueryDependencies;

const MANAGED_RUNTIME = new Set([
  "_analytics",
  "_realtime",
  "_supavisor",
  "etl",
  "extensions",
  "graphql",
  "graphql_public",
  "pgbouncer",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "realtime",
  "repack",
  "supabase_functions",
  "tiger",
  "tiger_data",
  "topology",
]);

export function classifySchema(
  name: string,
  extension: string | null,
  persistentTableCount: number,
): SchemaClassification {
  if (name === "auth") return "auth_data";
  if (name === "storage") return "storage_metadata";
  if (name === "supabase_migrations") return "migration_history";
  if (name === "cron") return "cron";
  if (name === "pgmq" || name === "pgmq_public") return "queues";
  if (name === "net") return "webhook_runtime";
  if (name === "vault") return "vault_data";
  if (
    MANAGED_RUNTIME.has(name) ||
    name.startsWith("timescaledb_") ||
    name.startsWith("_timescaledb_")
  )
    return "managed_runtime";
  if (extension === null) return "base_dump";
  if (persistentTableCount === 0) return "managed_runtime";
  return "unclassified_persistent";
}

export function normalizeDatabaseInventory(
  rows: CatalogRows,
): DatabaseInventory {
  const extensions = z.array(extensionRowSchema).parse(rows.extensions);
  const schemas = z.array(schemaRowSchema).parse(rows.schemas);
  const vaultSecretCount =
    rows.vaultSecrets === undefined
      ? undefined
      : z
          .array(vaultSecretCountRowSchema)
          .length(1)
          .parse(rows.vaultSecrets)[0]!.count;
  const normalizedSchemas = schemas
    .map((schema): SchemaInventory => ({
      name: schema.name,
      extension: schema.extension,
      persistentTableCount: schema.persistent_table_count,
      persistentBytes: schema.persistent_bytes.toString(),
      classification: classifySchema(
        schema.name,
        schema.extension,
        schema.persistent_table_count,
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  return databaseInventorySchema.parse({
    schemaVersion: 1,
    extensions: extensions
      .map((extension) => ({ ...extension }))
      .sort((left, right) => left.name.localeCompare(right.name, "en")),
    schemas: normalizedSchemas,
    unclassifiedPersistentSchemas: normalizedSchemas
      .filter(
        ({ classification }) => classification === "unclassified_persistent",
      )
      .map(({ name }) => name),
    ...(vaultSecretCount === undefined ? {} : { vaultSecretCount }),
  });
}

const EXTENSIONS_SQL = `
select
  e.extname::text as name,
  e.extversion::text as version,
  n.nspname::text as schema
from pg_catalog.pg_extension e
join pg_catalog.pg_namespace n on n.oid = e.extnamespace
order by e.extname
`;

const SCHEMAS_SQL = `
with extension_schemas as (
  select n.oid as schema_oid, e.extname::text as extension_name
  from pg_catalog.pg_namespace n
  join pg_catalog.pg_depend d
    on d.classid = 'pg_catalog.pg_namespace'::regclass
   and d.objid = n.oid
   and d.deptype = 'e'
  join pg_catalog.pg_extension e on e.oid = d.refobjid
  union
  select e.extnamespace, e.extname::text
  from pg_catalog.pg_extension e
)
select
  n.nspname::text as name,
  min(es.extension_name)::text as extension,
  count(c.oid) filter (where c.relkind in ('r', 'p'))::int as persistent_table_count,
  coalesce(
    sum(pg_catalog.pg_total_relation_size(c.oid)) filter (where c.relkind in ('r', 'p')),
    0
  )::text as persistent_bytes
from pg_catalog.pg_namespace n
left join extension_schemas es on es.schema_oid = n.oid
left join pg_catalog.pg_class c on c.relnamespace = n.oid
where n.nspname <> 'information_schema'
  and n.nspname !~ '^pg_'
group by n.oid, n.nspname
order by n.nspname
`;

const VAULT_SECRET_COUNT_SQL = `
select count(*)::int as count
from vault.secrets
`;

async function persistDatabaseInventory(
  inventory: DatabaseInventory,
  outputDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  const databaseDirectory = path.join(outputDirectory, "database");
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    path.join(databaseDirectory, "metadata.json"),
    canonicalJson(inventory),
    { signal },
  );
}

export async function collectLinkedDatabaseInventory(
  outputDirectory: string,
  signal?: AbortSignal,
  dependencies: LinkedDatabaseInventoryDependencies = {},
): Promise<DatabaseInventory> {
  signal?.throwIfAborted();
  try {
    const query = await createLinkedDatabaseQuery(signal, dependencies);
    const extensions = await query(EXTENSIONS_SQL);
    signal?.throwIfAborted();
    const schemas = await query(SCHEMAS_SQL);
    signal?.throwIfAborted();
    const vaultSecrets = await query(VAULT_SECRET_COUNT_SQL);
    const inventory = normalizeDatabaseInventory({
      extensions,
      schemas,
      vaultSecrets,
    });
    await persistDatabaseInventory(inventory, outputDirectory, signal);
    return inventory;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      category: "database",
      message: "Linked PostgreSQL schema and extension inventory failed.",
      retryable: false,
      component: "database.extension_state",
      cause: error,
    });
  }
}

export async function collectDatabaseInventory(
  connectionString: SecretValue,
  outputDirectory: string,
  signal?: AbortSignal,
  dependencies: DatabaseInventoryDependencies = {},
): Promise<DatabaseInventory> {
  signal?.throwIfAborted();
  const client =
    dependencies.createClient?.(connectionString.expose()) ??
    new Client({
      connectionString: connectionString.expose(),
      application_name: "pgdumpster-inventory",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
    });
  try {
    await client.connect();
    const extensions = await client.query(EXTENSIONS_SQL);
    signal?.throwIfAborted();
    const schemas = await client.query(SCHEMAS_SQL);
    signal?.throwIfAborted();
    const vaultSecrets = await client.query(VAULT_SECRET_COUNT_SQL);
    const inventory = normalizeDatabaseInventory({
      extensions: extensions.rows,
      schemas: schemas.rows,
      vaultSecrets: vaultSecrets.rows,
    });
    await persistDatabaseInventory(inventory, outputDirectory, signal);
    return inventory;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      category: "database",
      message: "PostgreSQL schema and extension inventory failed.",
      retryable: false,
      component: "database.extension_state",
      cause: error,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
