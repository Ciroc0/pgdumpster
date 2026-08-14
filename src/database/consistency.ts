import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import { canonicalJson } from "../utils/canonical-json.js";
import {
  collectDatabaseCatalogState,
  collectLinkedDatabaseCatalogState,
  type DatabaseCatalogState,
} from "./catalog-state.js";
import {
  collectDatabaseInventory,
  collectLinkedDatabaseInventory,
  type DatabaseInventory,
} from "./inventory.js";
import {
  createLinkedDatabaseQuery,
  type LinkedDatabaseQueryDependencies,
} from "./linked-query.js";

const { Client } = pg;

const markerRowSchema = z
  .object({
    txid_xmin: z.string().regex(/^\d+$/u),
    txid_xmax: z.string().regex(/^\d+$/u),
    wal_lsn: z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/iu),
    stats_reset: z.string().nullable(),
  })
  .strict();

const tableFingerprintRowSchema = z
  .object({
    schema: z.string().min(1),
    table: z.string().min(1),
    kind: z.enum(["r", "p"]),
    relfilenode: z.string().regex(/^\d+$/u),
    estimated_rows: z.string().min(1),
    inserts: z.string().regex(/^\d+$/u),
    updates: z.string().regex(/^\d+$/u),
    deletes: z.string().regex(/^\d+$/u),
  })
  .strict();

const sequenceFingerprintRowSchema = z
  .object({
    schema: z.string().min(1),
    sequence: z.string().min(1),
    start_value: z.string(),
    min_value: z.string(),
    max_value: z.string(),
    increment_by: z.string(),
    cycle: z.boolean(),
    cache_size: z.string(),
    last_value: z.string().nullable(),
  })
  .strict();

export interface DatabaseConsistencyMarker {
  txidXmin: string;
  txidXmax: string;
  walLsn: string;
  statsReset: string | null;
}

export interface DatabaseTableFingerprint {
  schema: string;
  table: string;
  kind: "r" | "p";
  relfilenode: string;
  estimatedRows: string;
  inserts: string;
  updates: string;
  deletes: string;
}

export interface DatabaseSequenceFingerprint {
  schema: string;
  sequence: string;
  startValue: string;
  minValue: string;
  maxValue: string;
  incrementBy: string;
  cycle: boolean;
  cacheSize: string;
  lastValue: string | null;
}

export interface DatabaseMutationEvidence {
  marker: DatabaseConsistencyMarker;
  tables: DatabaseTableFingerprint[];
  sequences: DatabaseSequenceFingerprint[];
}

export interface DatabaseConsistencySnapshot {
  schemaVersion: 1;
  inventory: DatabaseInventory;
  catalog: DatabaseCatalogState;
  mutation: DatabaseMutationEvidence;
}

export interface DatabaseConsistencyClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface DatabaseConsistencyDependencies {
  collectInventory?: (
    outputDirectory: string,
    signal?: AbortSignal,
  ) => Promise<DatabaseInventory>;
  collectCatalog?: (
    outputDirectory: string,
    signal?: AbortSignal,
  ) => Promise<DatabaseCatalogState>;
  collectEvidence?: (signal?: AbortSignal) => Promise<DatabaseMutationEvidence>;
  createClient?: (connectionString: string) => DatabaseConsistencyClient;
  linkedQueryDependencies?: LinkedDatabaseQueryDependencies;
}

interface MutationRows {
  marker: unknown[];
  tables: unknown[];
  sequences: unknown[];
}

type DatabaseQuery = (sql: string) => Promise<unknown[]>;

const MARKER_SQL = `
select
  txid_snapshot_xmin(txid_current_snapshot())::text as txid_xmin,
  txid_snapshot_xmax(txid_current_snapshot())::text as txid_xmax,
  pg_current_wal_lsn()::text as wal_lsn,
  (
    select stats_reset::text
    from pg_catalog.pg_stat_database
    where datname = current_database()
  ) as stats_reset
`;

const TABLE_FINGERPRINT_SQL = `
select
  n.nspname::text as schema,
  c.relname::text as table,
  c.relkind::text as kind,
  c.relfilenode::text as relfilenode,
  c.reltuples::text as estimated_rows,
  coalesce(s.n_tup_ins, 0)::text as inserts,
  coalesce(s.n_tup_upd, 0)::text as updates,
  coalesce(s.n_tup_del, 0)::text as deletes
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_stat_all_tables s on s.relid = c.oid
where c.relkind in ('r', 'p')
  and n.nspname <> 'information_schema'
  and n.nspname !~ '^pg_'
order by n.nspname, c.relname
`;

const SEQUENCE_FINGERPRINT_SQL = `
select
  schemaname::text as schema,
  sequencename::text as sequence,
  start_value::text as start_value,
  min_value::text as min_value,
  max_value::text as max_value,
  increment_by::text as increment_by,
  cycle,
  cache_size::text as cache_size,
  last_value::text as last_value
from pg_catalog.pg_sequences
where schemaname <> 'information_schema'
  and schemaname !~ '^pg_'
order by schemaname, sequencename
`;

export function normalizeDatabaseMutationEvidence(
  rows: MutationRows,
): DatabaseMutationEvidence {
  const marker = z.array(markerRowSchema).length(1).parse(rows.marker)[0]!;
  const tables = z.array(tableFingerprintRowSchema).parse(rows.tables);
  const sequences = z.array(sequenceFingerprintRowSchema).parse(rows.sequences);

  return {
    marker: {
      txidXmin: marker.txid_xmin,
      txidXmax: marker.txid_xmax,
      walLsn: marker.wal_lsn.toUpperCase(),
      statsReset: marker.stats_reset,
    },
    tables: tables
      .map((table) => ({
        schema: table.schema,
        table: table.table,
        kind: table.kind,
        relfilenode: table.relfilenode,
        estimatedRows: table.estimated_rows,
        inserts: table.inserts,
        updates: table.updates,
        deletes: table.deletes,
      }))
      .sort((left, right) =>
        `${left.schema}\0${left.table}`.localeCompare(
          `${right.schema}\0${right.table}`,
          "en",
        ),
      ),
    sequences: sequences
      .map((sequence) => ({
        schema: sequence.schema,
        sequence: sequence.sequence,
        startValue: sequence.start_value,
        minValue: sequence.min_value,
        maxValue: sequence.max_value,
        incrementBy: sequence.increment_by,
        cycle: sequence.cycle,
        cacheSize: sequence.cache_size,
        lastValue: sequence.last_value,
      }))
      .sort((left, right) =>
        `${left.schema}\0${left.sequence}`.localeCompare(
          `${right.schema}\0${right.sequence}`,
          "en",
        ),
      ),
  };
}

async function collectMutationEvidence(
  query: DatabaseQuery,
  signal?: AbortSignal,
): Promise<DatabaseMutationEvidence> {
  signal?.throwIfAborted();
  const marker = await query(MARKER_SQL);
  signal?.throwIfAborted();
  const tables = await query(TABLE_FINGERPRINT_SQL);
  signal?.throwIfAborted();
  const sequences = await query(SEQUENCE_FINGERPRINT_SQL);
  signal?.throwIfAborted();
  return normalizeDatabaseMutationEvidence({ marker, tables, sequences });
}

async function collectDirectMutationEvidence(
  connectionString: SecretValue,
  signal?: AbortSignal,
  createClient?: (connectionString: string) => DatabaseConsistencyClient,
): Promise<DatabaseMutationEvidence> {
  signal?.throwIfAborted();
  const client =
    createClient?.(connectionString.expose()) ??
    new Client({
      connectionString: connectionString.expose(),
      application_name: "pgdumpster-consistency",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
    });

  try {
    await client.connect();
    return await collectMutationEvidence(
      async (sql) => (await client.query(sql)).rows,
      signal,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function collectLinkedMutationEvidence(
  signal?: AbortSignal,
  dependencies: LinkedDatabaseQueryDependencies = {},
): Promise<DatabaseMutationEvidence> {
  const query = await createLinkedDatabaseQuery(signal, dependencies);
  return collectMutationEvidence(query, signal);
}

function comparableSnapshot(snapshot: DatabaseConsistencySnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    inventory: snapshot.inventory,
    catalog: snapshot.catalog,
    statsReset: snapshot.mutation.marker.statsReset,
    tables: snapshot.mutation.tables,
    sequences: snapshot.mutation.sequences,
  };
}

export function databaseConsistencySnapshotsEqual(
  before: DatabaseConsistencySnapshot,
  after: DatabaseConsistencySnapshot,
): boolean {
  // TXID/WAL markers are retained for diagnostics but deliberately excluded
  // from equality. In --linked mode the Supabase CLI creates short-lived
  // login roles, which can advance cluster transaction/WAL markers even when
  // the project data being backed up did not change.
  return (
    canonicalJson(comparableSnapshot(before)) ===
    canonicalJson(comparableSnapshot(after))
  );
}

async function collectSnapshot(
  signal: AbortSignal | undefined,
  dependencies: Required<
    Pick<
      DatabaseConsistencyDependencies,
      "collectInventory" | "collectCatalog" | "collectEvidence"
    >
  >,
): Promise<DatabaseConsistencySnapshot> {
  signal?.throwIfAborted();
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-db-consistency-"),
  );

  try {
    const inventory = await dependencies.collectInventory(
      temporaryRoot,
      signal,
    );
    signal?.throwIfAborted();
    const catalog = await dependencies.collectCatalog(temporaryRoot, signal);
    signal?.throwIfAborted();
    const mutation = await dependencies.collectEvidence(signal);
    signal?.throwIfAborted();
    return {
      schemaVersion: 1,
      inventory,
      catalog,
      mutation,
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "DATABASE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      message: "Database consistency inventory could not be collected safely.",
      retryable: false,
      component: "database.data",
      cause: error,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export function collectDatabaseConsistencySnapshot(
  connectionString: SecretValue,
  signal?: AbortSignal,
  dependencies: DatabaseConsistencyDependencies = {},
): Promise<DatabaseConsistencySnapshot> {
  return collectSnapshot(signal, {
    collectInventory:
      dependencies.collectInventory ??
      ((outputDirectory, snapshotSignal) =>
        collectDatabaseInventory(
          connectionString,
          outputDirectory,
          snapshotSignal,
        )),
    collectCatalog:
      dependencies.collectCatalog ??
      ((outputDirectory, snapshotSignal) =>
        collectDatabaseCatalogState(
          connectionString,
          outputDirectory,
          snapshotSignal,
        )),
    collectEvidence:
      dependencies.collectEvidence ??
      ((snapshotSignal) =>
        collectDirectMutationEvidence(
          connectionString,
          snapshotSignal,
          dependencies.createClient,
        )),
  });
}

export function collectLinkedDatabaseConsistencySnapshot(
  signal?: AbortSignal,
  dependencies: DatabaseConsistencyDependencies = {},
): Promise<DatabaseConsistencySnapshot> {
  return collectSnapshot(signal, {
    collectInventory:
      dependencies.collectInventory ??
      ((outputDirectory, snapshotSignal) =>
        collectLinkedDatabaseInventory(
          outputDirectory,
          snapshotSignal,
          dependencies.linkedQueryDependencies,
        )),
    collectCatalog:
      dependencies.collectCatalog ??
      ((outputDirectory, snapshotSignal) =>
        collectLinkedDatabaseCatalogState(
          outputDirectory,
          snapshotSignal,
          dependencies.linkedQueryDependencies,
        )),
    collectEvidence:
      dependencies.collectEvidence ??
      ((snapshotSignal) =>
        collectLinkedMutationEvidence(
          snapshotSignal,
          dependencies.linkedQueryDependencies,
        )),
  });
}
