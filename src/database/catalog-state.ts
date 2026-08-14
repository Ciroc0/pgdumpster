import { mkdir } from "node:fs/promises";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { canonicalJson } from "../utils/canonical-json.js";
import {
  createLinkedDatabaseQuery,
  type LinkedDatabaseQueryDependencies,
} from "./linked-query.js";

const { Client } = pg;

const publicationRowSchema = z.object({
  name: z.string().min(1),
  owner: z.string().min(1),
  all_tables: z.boolean(),
  publish_insert: z.boolean(),
  publish_update: z.boolean(),
  publish_delete: z.boolean(),
  publish_truncate: z.boolean(),
});

const publicationTableRowSchema = z.object({
  publication: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
  columns: z.array(z.string().min(1)).nullable(),
  row_filter: z.string().nullable(),
});

const webhookRowSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
  name: z.string().min(1),
  enabled: z.enum(["O", "D", "R", "A"]),
  function_schema: z.string().min(1),
  function_name: z.string().min(1),
  definition: z.string().min(1),
});

export interface PublicationState {
  name: string;
  owner: string;
  allTables: boolean;
  publish: {
    insert: boolean;
    update: boolean;
    delete: boolean;
    truncate: boolean;
  };
}

export interface PublicationTableState {
  publication: string;
  schema: string;
  table: string;
  columns: string[] | null;
  rowFilter: string | null;
}

export interface DatabaseWebhookState {
  schema: string;
  table: string;
  name: string;
  enabled: "O" | "D" | "R" | "A";
  functionSchema: string;
  functionName: string;
  definition: string;
}

export interface DatabaseCatalogState {
  schemaVersion: 1;
  publications: PublicationState[];
  publicationTables: PublicationTableState[];
  webhooks: DatabaseWebhookState[];
}

export const databaseCatalogStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    publications: z.array(
      z
        .object({
          name: z.string().min(1),
          owner: z.string().min(1),
          allTables: z.boolean(),
          publish: z
            .object({
              insert: z.boolean(),
              update: z.boolean(),
              delete: z.boolean(),
              truncate: z.boolean(),
            })
            .strict(),
        })
        .strict(),
    ),
    publicationTables: z.array(
      z
        .object({
          publication: z.string().min(1),
          schema: z.string().min(1),
          table: z.string().min(1),
          columns: z.string().min(1).array().nullable(),
          rowFilter: z.string().nullable(),
        })
        .strict(),
    ),
    webhooks: z.array(
      z
        .object({
          schema: z.string().min(1),
          table: z.string().min(1),
          name: z.string().min(1),
          enabled: z.enum(["O", "D", "R", "A"]),
          functionSchema: z.string().min(1),
          functionName: z.string().min(1),
          definition: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export interface DatabaseCatalogRows {
  publications: unknown[];
  publicationTables: unknown[];
  webhooks: unknown[];
}

export interface DatabaseCatalogClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface DatabaseCatalogDependencies {
  createClient?: (connectionString: string) => DatabaseCatalogClient;
}

export type LinkedDatabaseCatalogDependencies = LinkedDatabaseQueryDependencies;

export function normalizeDatabaseCatalogState(
  rows: DatabaseCatalogRows,
): DatabaseCatalogState {
  const publications = z.array(publicationRowSchema).parse(rows.publications);
  const publicationTables = z
    .array(publicationTableRowSchema)
    .parse(rows.publicationTables);
  const webhooks = z.array(webhookRowSchema).parse(rows.webhooks);
  return databaseCatalogStateSchema.parse({
    schemaVersion: 1,
    publications: publications
      .map((publication) => ({
        name: publication.name,
        owner: publication.owner,
        allTables: publication.all_tables,
        publish: {
          insert: publication.publish_insert,
          update: publication.publish_update,
          delete: publication.publish_delete,
          truncate: publication.publish_truncate,
        },
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "en")),
    publicationTables: publicationTables
      .map((table) => ({
        publication: table.publication,
        schema: table.schema,
        table: table.table,
        columns: table.columns,
        rowFilter: table.row_filter,
      }))
      .sort((left, right) =>
        `${left.publication}\0${left.schema}\0${left.table}`.localeCompare(
          `${right.publication}\0${right.schema}\0${right.table}`,
          "en",
        ),
      ),
    webhooks: webhooks
      .map((webhook) => ({
        schema: webhook.schema,
        table: webhook.table,
        name: webhook.name,
        enabled: webhook.enabled,
        functionSchema: webhook.function_schema,
        functionName: webhook.function_name,
        definition: webhook.definition,
      }))
      .sort((left, right) =>
        `${left.schema}\0${left.table}\0${left.name}`.localeCompare(
          `${right.schema}\0${right.table}\0${right.name}`,
          "en",
        ),
      ),
  });
}

const PUBLICATIONS_SQL = `
select
  p.pubname::text as name,
  pg_catalog.pg_get_userbyid(p.pubowner)::text as owner,
  p.puballtables as all_tables,
  p.pubinsert as publish_insert,
  p.pubupdate as publish_update,
  p.pubdelete as publish_delete,
  p.pubtruncate as publish_truncate
from pg_catalog.pg_publication p
order by p.pubname
`;

const PUBLICATION_TABLES_SQL = `
select
  p.pubname::text as publication,
  n.nspname::text as schema,
  c.relname::text as table,
  case
    when pr.prattrs is null then null
    else array(
      select a.attname::text
      from unnest(pr.prattrs::smallint[]) with ordinality selected(attnum, position)
      join pg_catalog.pg_attribute a
        on a.attrelid = pr.prrelid
       and a.attnum = selected.attnum
      order by selected.position
    )
  end as columns,
  pg_catalog.pg_get_expr(pr.prqual, pr.prrelid)::text as row_filter
from pg_catalog.pg_publication_rel pr
join pg_catalog.pg_publication p on p.oid = pr.prpubid
join pg_catalog.pg_class c on c.oid = pr.prrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
order by p.pubname, n.nspname, c.relname
`;

const WEBHOOKS_SQL = `
select
  n.nspname::text as schema,
  c.relname::text as table,
  t.tgname::text as name,
  t.tgenabled::text as enabled,
  pn.nspname::text as function_schema,
  p.proname::text as function_name,
  pg_catalog.pg_get_triggerdef(t.oid, true)::text as definition
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
where not t.tgisinternal
  and pn.nspname = 'supabase_functions'
  and p.proname = 'http_request'
order by n.nspname, c.relname, t.tgname
`;

async function persistDatabaseCatalogState(
  state: DatabaseCatalogState,
  outputDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  const databaseDirectory = path.join(outputDirectory, "database");
  await mkdir(databaseDirectory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    path.join(databaseDirectory, "catalog-state.json"),
    canonicalJson(state),
    { signal },
  );
}

export async function collectLinkedDatabaseCatalogState(
  outputDirectory: string,
  signal?: AbortSignal,
  dependencies: LinkedDatabaseCatalogDependencies = {},
): Promise<DatabaseCatalogState> {
  signal?.throwIfAborted();
  try {
    const query = await createLinkedDatabaseQuery(signal, dependencies);
    const publications = await query(PUBLICATIONS_SQL);
    const publicationTables = await query(PUBLICATION_TABLES_SQL);
    const webhooks = await query(WEBHOOKS_SQL);
    const state = normalizeDatabaseCatalogState({
      publications,
      publicationTables,
      webhooks,
    });
    await persistDatabaseCatalogState(state, outputDirectory, signal);
    return state;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      category: "database",
      message: "Linked PostgreSQL publication and webhook inventory failed.",
      retryable: false,
      component: "database.publications",
      cause: error,
    });
  }
}

export async function collectDatabaseCatalogState(
  connectionString: SecretValue,
  outputDirectory: string,
  signal?: AbortSignal,
  dependencies: DatabaseCatalogDependencies = {},
): Promise<DatabaseCatalogState> {
  signal?.throwIfAborted();
  const client =
    dependencies.createClient?.(connectionString.expose()) ??
    new Client({
      connectionString: connectionString.expose(),
      application_name: "pgdumpster-catalog-state",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
    });
  try {
    await client.connect();
    const publications = await client.query(PUBLICATIONS_SQL);
    signal?.throwIfAborted();
    const publicationTables = await client.query(PUBLICATION_TABLES_SQL);
    signal?.throwIfAborted();
    const webhooks = await client.query(WEBHOOKS_SQL);
    signal?.throwIfAborted();
    const state = normalizeDatabaseCatalogState({
      publications: publications.rows,
      publicationTables: publicationTables.rows,
      webhooks: webhooks.rows,
    });
    await persistDatabaseCatalogState(state, outputDirectory, signal);
    return state;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      category: "database",
      message: "PostgreSQL publication and webhook inventory failed.",
      retryable: false,
      component: "database.publications",
      cause: error,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
