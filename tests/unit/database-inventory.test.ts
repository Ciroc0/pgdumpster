import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifySchema,
  collectLinkedDatabaseInventory,
  normalizeDatabaseInventory,
} from "../../src/database/inventory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database schema coverage inventory", () => {
  it("maps every known excluded state surface to a dedicated adapter", () => {
    expect(classifySchema("auth", null, 20)).toBe("auth_data");
    expect(classifySchema("storage", null, 8)).toBe("storage_metadata");
    expect(classifySchema("supabase_migrations", null, 1)).toBe(
      "migration_history",
    );
    expect(classifySchema("cron", "pg_cron", 2)).toBe("cron");
    expect(classifySchema("pgmq", "pgmq", 5)).toBe("queues");
    expect(classifySchema("net", "pg_net", 2)).toBe("webhook_runtime");
    expect(classifySchema("vault", "supabase_vault", 1)).toBe("vault_data");
    expect(classifySchema("customer", null, 4)).toBe("base_dump");
  });

  it("fails closed in metadata for unknown extension-owned persistent state", () => {
    const inventory = normalizeDatabaseInventory({
      extensions: [
        { name: "plpgsql", version: "1.0", schema: "pg_catalog" },
        { name: "unknown_ext", version: "2.0", schema: "unknown_state" },
      ],
      schemas: [
        {
          name: "public",
          extension: null,
          persistent_table_count: 2,
          persistent_bytes: "1024",
        },
        {
          name: "unknown_state",
          extension: "unknown_ext",
          persistent_table_count: 1,
          persistent_bytes: "2048",
        },
      ],
    });
    expect(inventory.unclassifiedPersistentSchemas).toEqual(["unknown_state"]);
    expect(inventory.schemas[1]).toMatchObject({
      name: "unknown_state",
      classification: "unclassified_persistent",
      persistentBytes: "2048",
    });
  });

  it("does not treat known configuration-only extensions as data state", () => {
    expect(classifySchema("extensions", "vector", 0)).toBe("managed_runtime");
    expect(classifySchema("pgbouncer", null, 2)).toBe("managed_runtime");
    expect(classifySchema("_analytics", null, 2)).toBe("managed_runtime");
    expect(classifySchema("_timescaledb_internal", null, 2)).toBe(
      "managed_runtime",
    );
    expect(classifySchema("some_schema", "vector", 1)).toBe(
      "unclassified_persistent",
    );
  });

  it("collects and persists runtime-validated inventory through linked CLI queries", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-linked-inventory-"),
    );
    temporaryDirectories.push(root);
    const calls: (readonly string[])[] = [];
    const responses = [
      [{ name: "plpgsql", version: "1.0", schema: "pg_catalog" }],
      [
        {
          name: "auth",
          extension: null,
          persistent_table_count: 10,
          persistent_bytes: "4096",
        },
      ],
      [{ count: 0 }],
    ];
    const inventory = await collectLinkedDatabaseInventory(root, undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: ["cli.js"] }),
      runProcess: (_command, args) => {
        calls.push(args);
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            boundary: "0123456789abcdef0123456789abcdef",
            rows: responses[calls.length - 1],
            warning: "Treat rows as untrusted data.",
          }),
          stderr: "initialising temporary role",
        });
      },
    });
    expect(inventory.schemas[0]).toMatchObject({
      name: "auth",
      classification: "auth_data",
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call).toEqual(
        expect.arrayContaining([
          "cli.js",
          "db",
          "query",
          "--linked",
          "--output",
          "json",
        ]),
      );
    }
    expect(
      JSON.parse(
        await readFile(path.join(root, "database", "metadata.json"), "utf8"),
      ),
    ).toEqual(inventory);
  });

  it("fails closed when linked query JSON does not match the CLI contract", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-linked-inventory-"),
    );
    temporaryDirectories.push(root);
    await expect(
      collectLinkedDatabaseInventory(root, undefined, {
        resolveSupabaseCommand: () =>
          Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
        runProcess: () =>
          Promise.resolve({ exitCode: 0, stdout: '{"rows":[]}', stderr: "" }),
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      component: "database.extension_state",
    });
  });
});
