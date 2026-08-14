import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectDatabaseCatalogState } from "../../src/database/catalog-state.js";
import { collectDatabaseInventory } from "../../src/database/inventory.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { collectFileStorageCatalog } from "../../src/storage/catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function secret(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:canary@invalid/postgres",
    new Redactor(),
  );
}

async function output(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-collector-"));
  temporaryDirectories.push(root);
  return root;
}

describe("catalog collectors", () => {
  it("executes and persists database schema inventory", async () => {
    const root = await output();
    const query = vi
      .fn<(sql: string) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({
        rows: [{ name: "pg_cron", version: "1.6", schema: "cron" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            name: "cron",
            extension: "pg_cron",
            persistent_table_count: 2,
            persistent_bytes: "100",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const inventory = await collectDatabaseInventory(
      secret(),
      root,
      undefined,
      {
        createClient: () => ({
          connect: () => Promise.resolve(),
          query,
          end,
        }),
      },
    );
    expect(inventory.schemas[0]?.classification).toBe("cron");
    expect(
      JSON.parse(
        await readFile(path.join(root, "database", "metadata.json"), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 1 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledOnce();
  });

  it("executes and persists publication/webhook catalog state", async () => {
    const root = await output();
    const query = vi
      .fn<(sql: string) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({
        rows: [
          {
            name: "supabase_realtime",
            owner: "postgres",
            all_tables: false,
            publish_insert: true,
            publish_update: true,
            publish_delete: true,
            publish_truncate: true,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const state = await collectDatabaseCatalogState(secret(), root, undefined, {
      createClient: () => ({
        connect: () => Promise.resolve(),
        query,
        end: () => Promise.resolve(),
      }),
    });
    expect(state.publications[0]?.name).toBe("supabase_realtime");
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "database", "catalog-state.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ schemaVersion: 1 });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("executes and persists File Storage catalog", async () => {
    const root = await output();
    const query = vi
      .fn<(sql: string) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "files",
            name: "files",
            public: false,
            type: "STANDARD",
            file_size_limit: null,
            allowed_mime_types: null,
            created_at: null,
            updated_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const catalog = await collectFileStorageCatalog(secret(), root, undefined, {
      createClient: () => ({
        connect: () => Promise.resolve(),
        query,
        end: () => Promise.resolve(),
      }),
    });
    expect(catalog.buckets[0]?.id).toBe("files");
    expect(
      JSON.parse(
        await readFile(path.join(root, "storage", "file-catalog.json"), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 1 });
  });

  it("sanitizes collector failures and still closes clients", async () => {
    const root = await output();
    const end = vi.fn().mockResolvedValue(undefined);
    await expect(
      collectDatabaseInventory(secret(), root, undefined, {
        createClient: () => ({
          connect: () => Promise.resolve(),
          query: () => Promise.reject(new Error("upstream secret body")),
          end,
        }),
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      message: "PostgreSQL schema and extension inventory failed.",
    });
    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves cancellation rather than reclassifying it", async () => {
    const root = await output();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    await expect(
      collectFileStorageCatalog(secret(), root, controller.signal, {
        createClient: () => {
          throw new Error("must not create client");
        },
      }),
    ).rejects.toThrow(/cancelled by test/u);
  });
});
