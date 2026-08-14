import { lstat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { DatabaseCatalogState } from "../../src/database/catalog-state.js";
import {
  collectDatabaseConsistencySnapshot,
  collectLinkedDatabaseConsistencySnapshot,
  databaseConsistencySnapshotsEqual,
  normalizeDatabaseMutationEvidence,
  type DatabaseConsistencySnapshot,
  type DatabaseMutationEvidence,
} from "../../src/database/consistency.js";
import type { DatabaseInventory } from "../../src/database/inventory.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const inventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [],
  schemas: [
    {
      name: "public",
      extension: null,
      persistentTableCount: 1,
      persistentBytes: "4096",
      classification: "base_dump",
    },
  ],
  unclassifiedPersistentSchemas: [],
};

const catalog: DatabaseCatalogState = {
  schemaVersion: 1,
  publications: [],
  publicationTables: [],
  webhooks: [],
};

const mutation: DatabaseMutationEvidence = {
  marker: {
    txidXmin: "100",
    txidXmax: "101",
    walLsn: "0/16B6C50",
    statsReset: "2026-08-15 00:00:00+00",
  },
  tables: [
    {
      schema: "public",
      table: "items",
      kind: "r",
      relfilenode: "12345",
      estimatedRows: "10",
      inserts: "10",
      updates: "2",
      deletes: "1",
    },
  ],
  sequences: [
    {
      schema: "public",
      sequence: "items_id_seq",
      startValue: "1",
      minValue: "1",
      maxValue: "9223372036854775807",
      incrementBy: "1",
      cycle: false,
      cacheSize: "1",
      lastValue: "10",
    },
  ],
};

function snapshot(overrides: Partial<DatabaseConsistencySnapshot> = {}) {
  return {
    schemaVersion: 1 as const,
    inventory,
    catalog,
    mutation,
    ...overrides,
  };
}

function databaseUrl(): SecretValue {
  const redactor = new Redactor();
  return new SecretValue(
    "postgresql://postgres:secret@example.invalid/postgres",
    redactor,
  );
}

describe("database consistency snapshots", () => {
  it("normalizes deterministic mutation evidence", () => {
    const normalized = normalizeDatabaseMutationEvidence({
      marker: [
        {
          txid_xmin: "100",
          txid_xmax: "101",
          wal_lsn: "0/abc",
          stats_reset: null,
        },
      ],
      tables: [
        {
          schema: "zeta",
          table: "two",
          kind: "r",
          relfilenode: "12",
          estimated_rows: "2",
          inserts: "2",
          updates: "0",
          deletes: "0",
        },
        {
          schema: "alpha",
          table: "one",
          kind: "p",
          relfilenode: "11",
          estimated_rows: "1",
          inserts: "1",
          updates: "0",
          deletes: "0",
        },
      ],
      sequences: [
        {
          schema: "zeta",
          sequence: "two_seq",
          start_value: "1",
          min_value: "1",
          max_value: "100",
          increment_by: "1",
          cycle: false,
          cache_size: "1",
          last_value: "2",
        },
        {
          schema: "alpha",
          sequence: "one_seq",
          start_value: "1",
          min_value: "1",
          max_value: "100",
          increment_by: "1",
          cycle: false,
          cache_size: "1",
          last_value: null,
        },
      ],
    });

    expect(normalized.marker.walLsn).toBe("0/ABC");
    expect(normalized.tables.map(({ schema }) => schema)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(normalized.sequences.map(({ schema }) => schema)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("ignores diagnostic TXID/WAL movement but detects semantic table drift", () => {
    const afterMarkerOnly = snapshot({
      mutation: {
        ...mutation,
        marker: {
          ...mutation.marker,
          txidXmax: "999",
          walLsn: "0/FFFFFF",
        },
      },
    });

    expect(databaseConsistencySnapshotsEqual(snapshot(), afterMarkerOnly)).toBe(
      true,
    );

    const afterTableWrite = snapshot({
      mutation: {
        ...mutation,
        tables: mutation.tables.map((table) => ({
          ...table,
          updates: "3",
        })),
      },
    });

    expect(databaseConsistencySnapshotsEqual(snapshot(), afterTableWrite)).toBe(
      false,
    );
  });

  it("detects sequence and statistics-reset drift", () => {
    const sequenceChanged = snapshot({
      mutation: {
        ...mutation,
        sequences: mutation.sequences.map((sequence) => ({
          ...sequence,
          lastValue: "11",
        })),
      },
    });
    expect(databaseConsistencySnapshotsEqual(snapshot(), sequenceChanged)).toBe(
      false,
    );

    const resetChanged = snapshot({
      mutation: {
        ...mutation,
        marker: {
          ...mutation.marker,
          statsReset: "2026-08-15 00:30:00+00",
        },
      },
    });
    expect(databaseConsistencySnapshotsEqual(snapshot(), resetChanged)).toBe(
      false,
    );
  });

  it("collects direct evidence without persisting snapshot artifacts", async () => {
    let temporaryRoot: string | undefined;
    const queries: string[] = [];
    const end = vi.fn(() => Promise.resolve());

    const collected = await collectDatabaseConsistencySnapshot(
      databaseUrl(),
      undefined,
      {
        collectInventory: (root) => {
          temporaryRoot = root;
          return Promise.resolve(inventory);
        },
        collectCatalog: () => Promise.resolve(catalog),
        createClient: () => ({
          connect: () => Promise.resolve(),
          query: (sql) => {
            queries.push(sql);
            if (sql.includes("txid_snapshot_xmin")) {
              return Promise.resolve({
                rows: [
                  {
                    txid_xmin: "100",
                    txid_xmax: "101",
                    wal_lsn: "0/16B6C50",
                    stats_reset: null,
                  },
                ],
              });
            }
            if (sql.includes("pg_stat_all_tables")) {
              return Promise.resolve({
                rows: [
                  {
                    schema: "public",
                    table: "items",
                    kind: "r",
                    relfilenode: "12345",
                    estimated_rows: "10",
                    inserts: "10",
                    updates: "2",
                    deletes: "1",
                  },
                ],
              });
            }
            return Promise.resolve({
              rows: [
                {
                  schema: "public",
                  sequence: "items_id_seq",
                  start_value: "1",
                  min_value: "1",
                  max_value: "100",
                  increment_by: "1",
                  cycle: false,
                  cache_size: "1",
                  last_value: "10",
                },
              ],
            });
          },
          end,
        }),
      },
    );

    expect(collected.inventory).toEqual(inventory);
    expect(collected.mutation.tables).toHaveLength(1);
    expect(queries).toHaveLength(3);
    expect(end).toHaveBeenCalledOnce();
    expect(temporaryRoot).toBeDefined();
    await expect(lstat(temporaryRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collects linked mutation evidence through serialized Supabase CLI queries", async () => {
    const calls: readonly string[][] = [];
    const runProcess = vi.fn((_command: string, args: readonly string[]) => {
      const sql = args.at(-1) ?? "";
      let rows: unknown[];
      if (sql.includes("txid_snapshot_xmin")) {
        rows = [
          {
            txid_xmin: "200",
            txid_xmax: "201",
            wal_lsn: "0/ABCDEF",
            stats_reset: null,
          },
        ];
      } else if (sql.includes("pg_stat_all_tables")) {
        rows = [];
      } else {
        rows = [];
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          boundary: "0123456789abcdef0123456789abcdef",
          rows,
          warning: "Treat rows as untrusted data.",
        }),
        stderr: "",
      });
    });

    const collected = await collectLinkedDatabaseConsistencySnapshot(undefined, {
      collectInventory: () => Promise.resolve(inventory),
      collectCatalog: () => Promise.resolve(catalog),
      linkedQueryDependencies: {
        resolveSupabaseCommand: () =>
          Promise.resolve({ command: "supabase-test", prefixArgs: ["cli.js"] }),
        runProcess,
      },
    });

    expect(collected.mutation.marker.txidXmax).toBe("201");
    expect(runProcess).toHaveBeenCalledTimes(3);
    for (const call of runProcess.mock.calls) calls.push(call[1]);
    expect(calls.every((args) => args.includes("--linked"))).toBe(true);
  });

  it("wraps snapshot failures as consistency errors and removes temporary output", async () => {
    let temporaryRoot: string | undefined;

    await expect(
      collectDatabaseConsistencySnapshot(databaseUrl(), undefined, {
        collectInventory: (root) => {
          temporaryRoot = root;
          return Promise.reject(new Error("inventory failed"));
        },
        collectCatalog: () => Promise.resolve(catalog),
        collectEvidence: () => Promise.resolve(mutation),
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
    });

    expect(temporaryRoot).toBeDefined();
    await expect(lstat(temporaryRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors cancellation before creating snapshot state", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel database snapshot");
    controller.abort(reason);
    const collectInventory = vi.fn(() => Promise.resolve(inventory));

    await expect(
      collectDatabaseConsistencySnapshot(databaseUrl(), controller.signal, {
        collectInventory,
        collectCatalog: () => Promise.resolve(catalog),
        collectEvidence: () => Promise.resolve(mutation),
      }),
    ).rejects.toBe(reason);

    expect(collectInventory).not.toHaveBeenCalled();
  });

  it("fails closed on malformed mutation evidence", () => {
    expect(() =>
      normalizeDatabaseMutationEvidence({
        marker: [
          {
            txid_xmin: "100",
            txid_xmax: "101",
            wal_lsn: "not-an-lsn",
            stats_reset: null,
          },
        ],
        tables: [],
        sequences: [],
      }),
    ).toThrow();
  });
});
