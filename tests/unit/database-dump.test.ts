import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  dumpExcludedDatabaseState,
  dumpLogicalDatabase,
  dumpLogicalDatabaseComponent,
  dumpManagedSchemaCustomizations,
  dumpMigrationHistory,
} from "../../src/database/dump.js";
import type { DatabaseInventory } from "../../src/database/inventory.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type { RunProcessOptions } from "../../src/utils/process.js";

const temporaryDirectories: string[] = [];

const baseInventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [],
  schemas: [
    {
      name: "public",
      extension: null,
      persistentTableCount: 0,
      persistentBytes: "0",
      classification: "base_dump",
    },
    {
      name: "app_private",
      extension: null,
      persistentTableCount: 0,
      persistentBytes: "0",
      classification: "base_dump",
    },
  ],
  unclassifiedPersistentSchemas: [],
};

const managedSchemaInventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [],
  schemas: [
    {
      name: "auth",
      extension: null,
      persistentTableCount: 1,
      persistentBytes: "1",
      classification: "auth_data",
    },
    {
      name: "storage",
      extension: null,
      persistentTableCount: 1,
      persistentBytes: "1",
      classification: "storage_metadata",
    },
  ],
  unclassifiedPersistentSchemas: [],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Supabase logical database dumps", () => {
  it("uses the three official base dump forms without exposing the password in args", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-dump-"));
    temporaryDirectories.push(root);
    const calls: {
      args: readonly string[];
      options: RunProcessOptions;
    }[] = [];
    const password = "database-process-canary";
    const artifacts = await dumpLogicalDatabase(
      {
        connectionString: new SecretValue(
          `postgresql://postgres:${password}@db.example.invalid:5432/postgres`,
          new Redactor(),
        ),
        outputDirectory: root,
        dependencies: {
          resolveSupabaseCommand: () =>
            Promise.resolve({
              command: "supabase-test",
              prefixArgs: ["cli.js"],
            }),
          runProcess: async (_command, args, options) => {
            calls.push({ args, options });
            const fileIndex = args.indexOf("--file");
            const output = args[fileIndex + 1];
            if (output === undefined) throw new Error("Missing output path");
            await writeFile(output, `-- fixture ${calls.length}\n`);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      },
      baseInventory,
    );
    expect(artifacts).toHaveLength(3);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain(password);
      expect(call.options.environment?.["PGPASSWORD"]).toBe(password);
      expect(call.args).toContain("--db-url");
      expect(call.args.join(" ")).toContain("postgres@db.example.invalid");
    }
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining([
        "--use-copy",
        "--data-only",
        "app_private,public",
      ]),
    );
    const dataArgs = calls[2]!.args;
    const schemaIndex = dataArgs.indexOf("--schema");
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(dataArgs[schemaIndex + 1]).toBe("app_private,public");
    for (const artifact of artifacts) {
      expect(await readFile(artifact.path, "utf8")).toMatch(/^-- fixture/u);
    }
  });

  it("uses linked mode without requiring or injecting a database password", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-linked-"));
    temporaryDirectories.push(root);
    const calls: {
      args: readonly string[];
      options: RunProcessOptions;
    }[] = [];
    const artifacts = await dumpLogicalDatabase(
      {
        linked: true,
        outputDirectory: root,
        dependencies: {
          resolveSupabaseCommand: () =>
            Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
          runProcess: async (_command, args, options) => {
            calls.push({ args, options });
            const output = args[args.indexOf("--file") + 1];
            if (output === undefined) throw new Error("Missing output path");
            await writeFile(output, "-- linked fixture\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      },
      baseInventory,
    );
    expect(artifacts).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toContain("--linked");
      expect(call.args).not.toContain("--db-url");
      expect(call.options.environment?.["PGPASSWORD"]).toBeUndefined();
    }
  });

  it("accepts a 64 MiB streamed data dump without equivalent-size allocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-large-"));
    temporaryDirectories.push(root);
    const totalBytes = 64 * 1024 * 1024;
    const chunkBytes = 64 * 1024;
    let emittedBytes = 0;
    let emittedChunks = 0;
    const chunk = Buffer.alloc(chunkBytes, 0x61);

    const artifact = await dumpLogicalDatabaseComponent(
      {
        connectionString: new SecretValue(
          "postgresql://postgres:database-large-fixture@db.example.invalid/postgres",
          new Redactor(),
        ),
        outputDirectory: root,
        dependencies: {
          resolveSupabaseCommand: () =>
            Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
          runProcess: async (_command, args) => {
            const output = args[args.indexOf("--file") + 1];
            if (output === undefined) throw new Error("Missing output path");
            const body = Readable.from(
              (function* () {
                while (emittedBytes < totalBytes) {
                  const nextBytes = Math.min(
                    chunkBytes,
                    totalBytes - emittedBytes,
                  );
                  emittedBytes += nextBytes;
                  emittedChunks += 1;
                  yield chunk.subarray(0, nextBytes);
                }
              })(),
            );
            await pipeline(body, createWriteStream(output, { flags: "wx" }));
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      },
      "database.data",
      baseInventory,
    );

    expect(emittedChunks).toBe(totalBytes / chunkBytes);
    expect(artifact.bytes).toBe(totalBytes);
    expect(await stat(artifact.path)).toMatchObject({ size: totalBytes });
  });

  it("dumps migration history only when inventory proves the schema exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-migrations-"));
    temporaryDirectories.push(root);
    const calls: (readonly string[])[] = [];
    const baseInventory: DatabaseInventory = {
      schemaVersion: 1,
      extensions: [],
      schemas: [],
      unclassifiedPersistentSchemas: [],
    };
    const options = {
      linked: true,
      outputDirectory: root,
      dependencies: {
        resolveSupabaseCommand: () =>
          Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
        runProcess: async (_command: string, args: readonly string[]) => {
          calls.push(args);
          const output = args[args.indexOf("--file") + 1];
          if (output === undefined) throw new Error("Missing output path");
          await writeFile(output, "-- migration fixture\n");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    };
    await expect(dumpMigrationHistory(options, baseInventory)).resolves.toEqual(
      [],
    );
    expect(calls).toHaveLength(0);

    const artifacts = await dumpMigrationHistory(options, {
      ...baseInventory,
      schemas: [
        {
          name: "supabase_migrations",
          extension: null,
          persistentTableCount: 1,
          persistentBytes: "1024",
          classification: "migration_history",
        },
      ],
    });
    expect(artifacts.map(({ id }) => id)).toEqual([
      "database.migrations_schema",
      "database.migrations_data",
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toEqual(
        expect.arrayContaining(["--linked", "--schema", "supabase_migrations"]),
      );
    }
  });

  it("captures only the managed Auth and Storage customization delta", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-managed-schema-"),
    );
    temporaryDirectories.push(root);
    const calls: (readonly string[])[] = [];
    const artifacts = await dumpManagedSchemaCustomizations(
      {
        linked: true,
        outputDirectory: root,
        dependencies: {
          resolveSupabaseCommand: () =>
            Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
          runProcess: async (_command, args) => {
            calls.push(args);
            const output = args[args.indexOf("--output") + 1];
            if (output === undefined)
              throw new Error("Missing diff output path");
            await writeFile(
              output,
              "create trigger custom_auth after insert on auth.users execute function public.audit();\n",
            );
            return {
              exitCode: 0,
              stdout: "",
              stderr: "shadow database complete",
            };
          },
        },
      },
      managedSchemaInventory,
    );
    expect(artifacts.map(({ id }) => id)).toEqual([
      "database.auth_storage_customizations",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "--linked",
        "--schema",
        "auth,storage",
        "--use-pg-delta",
        "--output",
      ]),
    );
    expect(await readFile(artifacts[0]!.path, "utf8")).toContain(
      "create trigger custom_auth",
    );
  });

  it("returns no managed-schema artifact when the CLI emits no diff file", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-managed-schema-empty-"),
    );
    temporaryDirectories.push(root);
    const artifacts = await dumpManagedSchemaCustomizations(
      {
        linked: true,
        outputDirectory: root,
        dependencies: {
          resolveSupabaseCommand: () =>
            Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
          runProcess: () =>
            Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        },
      },
      managedSchemaInventory,
    );
    expect(artifacts).toEqual([]);
  });

  it("rejects an empty managed-schema diff file", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-managed-schema-invalid-"),
    );
    temporaryDirectories.push(root);
    await expect(
      dumpManagedSchemaCustomizations(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand: () =>
              Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
            runProcess: async (_command, args) => {
              const output = args[args.indexOf("--output") + 1];
              if (output === undefined)
                throw new Error("Missing diff output path");
              await writeFile(output, "");
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        },
        managedSchemaInventory,
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
    });
  });

  it("rejects ambiguous or missing database dump sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-source-"));
    temporaryDirectories.push(root);
    const connectionString = new SecretValue(
      "postgresql://postgres:password@db.example.invalid/postgres",
      new Redactor(),
    );
    const dependencies = {
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
    };
    await expect(
      dumpLogicalDatabase(
        { outputDirectory: root, dependencies },
        baseInventory,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      dumpLogicalDatabase(
        {
          connectionString,
          linked: true,
          outputDirectory: root,
          dependencies,
        },
        baseInventory,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("removes partial output and stops after a failed component", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-dump-"));
    temporaryDirectories.push(root);
    let calls = 0;
    await expect(
      dumpLogicalDatabase(
        {
          connectionString: new SecretValue(
            "postgresql://postgres:password@db.example.invalid/postgres",
            new Redactor(),
          ),
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand: () =>
              Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
            runProcess: async (_command, args) => {
              calls += 1;
              const output = args[args.indexOf("--file") + 1];
              if (output === undefined) throw new Error("Missing output path");
              await writeFile(output, "partial\n");
              return { exitCode: 1, stdout: "", stderr: "secret upstream" };
            },
          },
        },
        baseInventory,
      ),
    ).rejects.toMatchObject({ code: "DATABASE_DUMP_FAILED" });
    expect(calls).toBe(1);
    await expect(
      readFile(path.join(root, "database", "roles.sql")),
    ).rejects.toThrow();
  });

  it("rejects a zero-byte artifact even when a wrapper reports exit zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-dump-"));
    temporaryDirectories.push(root);
    await expect(
      dumpLogicalDatabase(
        {
          connectionString: new SecretValue(
            "postgresql://postgres:password@db.example.invalid/postgres",
            new Redactor(),
          ),
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand: () =>
              Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
            runProcess: async (_command, args) => {
              const output = args[args.indexOf("--file") + 1];
              if (output === undefined) throw new Error("Missing output path");
              await writeFile(output, "");
              return { exitCode: 0, stdout: "", stderr: "docker unavailable" };
            },
          },
        },
        baseInventory,
      ),
    ).rejects.toMatchObject({ code: "DATABASE_DUMP_FAILED" });
    await expect(
      readFile(path.join(root, "database", "roles.sql")),
    ).rejects.toThrow();
  });

  it("dumps known excluded persistent schemas and blocks an unknown one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-dump-"));
    temporaryDirectories.push(root);
    const calls: (readonly string[])[] = [];
    const inventory: DatabaseInventory = {
      schemaVersion: 1,
      vaultSecretCount: 1,
      extensions: [],
      schemas: [
        {
          name: "auth",
          extension: null,
          persistentTableCount: 10,
          persistentBytes: "100",
          classification: "auth_data",
        },
        {
          name: "cron",
          extension: "pg_cron",
          persistentTableCount: 2,
          persistentBytes: "20",
          classification: "cron",
        },
        {
          name: "storage",
          extension: null,
          persistentTableCount: 8,
          persistentBytes: "25",
          classification: "storage_metadata",
        },
        {
          name: "pgmq",
          extension: "pgmq",
          persistentTableCount: 2,
          persistentBytes: "30",
          classification: "queues",
        },
        {
          name: "pgmq_public",
          extension: "pgmq",
          persistentTableCount: 0,
          persistentBytes: "0",
          classification: "queues",
        },
        {
          name: "vault",
          extension: "supabase_vault",
          persistentTableCount: 1,
          persistentBytes: "40",
          classification: "vault_data",
        },
      ],
      unclassifiedPersistentSchemas: [],
    };
    const options = {
      connectionString: new SecretValue(
        "postgresql://postgres:password@db.example.invalid/postgres",
        new Redactor(),
      ),
      outputDirectory: root,
      dependencies: {
        resolveSupabaseCommand: () =>
          Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
        runProcess: async (_command: string, args: readonly string[]) => {
          calls.push(args);
          const output = args[args.indexOf("--file") + 1];
          if (output === undefined) throw new Error("Missing output path");
          await writeFile(output, "-- explicit state\n");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    };
    const artifacts = await dumpExcludedDatabaseState(options, inventory);
    expect(artifacts.map(({ id }) => id)).toEqual([
      "auth.data",
      "storage.file_metadata",
      "database.cron",
      "database.queues",
      "database.vault_data",
    ]);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "--schema",
        "storage",
        "storage.buckets_vectors,storage.vector_indexes",
      ]),
    );
    expect(calls[3]).toEqual(
      expect.arrayContaining(["--schema", "pgmq,pgmq_public"]),
    );

    await expect(
      dumpExcludedDatabaseState(options, {
        ...inventory,
        unclassifiedPersistentSchemas: ["unknown_extension_state"],
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
    });
  });
});
