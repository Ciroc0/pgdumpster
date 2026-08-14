import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dumpExcludedDatabaseComponent,
  dumpLogicalDatabase,
  dumpLogicalDatabaseComponent,
  dumpManagedSchemaCustomizations,
  dumpMigrationHistory,
} from "../../src/database/dump.js";
import type { DatabaseInventory } from "../../src/database/inventory.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function outputDirectory(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-database-dump-hardening-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function inventory(
  schemas: DatabaseInventory["schemas"] = [],
  overrides: Partial<DatabaseInventory> = {},
): DatabaseInventory {
  return {
    schemaVersion: 1,
    extensions: [],
    schemas,
    unclassifiedPersistentSchemas: [],
    ...overrides,
  };
}

function schema(
  name: string,
  classification: DatabaseInventory["schemas"][number]["classification"],
): DatabaseInventory["schemas"][number] {
  return {
    name,
    extension: null,
    persistentTableCount: 1,
    persistentBytes: "1",
    classification,
  };
}

function connectionString(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:database-secret@db.example.invalid/postgres",
    new Redactor(),
  );
}

describe("database dump hardening", () => {
  it("fails closed when no base dump schema exists", async () => {
    const root = await outputDirectory();
    const resolveSupabaseCommand = vi.fn();

    await expect(
      dumpLogicalDatabase(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        inventory([schema("auth", "auth_data")]),
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_DUMP_SCOPE_INVALID",
      component: "database.data",
    });

    expect(resolveSupabaseCommand).not.toHaveBeenCalled();
  });

  it("rejects a database.data component request without inventory", async () => {
    const root = await outputDirectory();
    const resolveSupabaseCommand = vi.fn();

    await expect(
      dumpLogicalDatabaseComponent(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        "database.data",
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_DUMP_COMPONENT_INVALID",
      component: "database.data",
    });

    expect(resolveSupabaseCommand).not.toHaveBeenCalled();
  });

  it("dumps individual logical components through the component API", async () => {
    const root = await outputDirectory();
    const calls: (readonly string[])[] = [];

    const options = {
      linked: true,
      outputDirectory: root,
      dependencies: {
        resolveSupabaseCommand: () =>
          Promise.resolve({
            command: "supabase-test",
            prefixArgs: [],
          }),
        runProcess: async (_command: string, args: readonly string[]) => {
          calls.push(args);

          const output = args[args.indexOf("--file") + 1];
          if (output === undefined) {
            throw new Error("Missing dump output path");
          }

          await writeFile(output, "-- fixture\n");

          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      },
    };

    const roles = await dumpLogicalDatabaseComponent(options, "database.roles");

    const data = await dumpLogicalDatabaseComponent(
      options,
      "database.data",
      inventory([schema("zeta", "base_dump"), schema("alpha", "base_dump")]),
    );

    expect(roles.id).toBe("database.roles");
    expect(data.id).toBe("database.data");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--role-only");

    const schemaIndex = calls[1]!.indexOf("--schema");

    expect(calls[1]![schemaIndex + 1]).toBe("alpha,zeta");
  });

  it("skips managed-schema diff when neither Auth nor Storage is present", async () => {
    const root = await outputDirectory();
    const resolveSupabaseCommand = vi.fn();

    await expect(
      dumpManagedSchemaCustomizations(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        inventory([schema("public", "base_dump")]),
      ),
    ).resolves.toEqual([]);

    expect(resolveSupabaseCommand).not.toHaveBeenCalled();
  });

  it("rejects a managed-schema output root that is not a directory", async () => {
    const root = await outputDirectory();
    const file = path.join(root, "not-a-directory");

    await writeFile(file, "file");

    const resolveSupabaseCommand = vi.fn();

    await expect(
      dumpManagedSchemaCustomizations(
        {
          linked: true,
          outputDirectory: file,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        inventory([schema("auth", "auth_data")]),
      ),
    ).rejects.toThrow("Database dump output must be a real directory");

    expect(resolveSupabaseCommand).not.toHaveBeenCalled();
  });

  it("rejects missing and ambiguous managed-schema source configuration", async () => {
    const root = await outputDirectory();

    const resolveSupabaseCommand = vi.fn(() =>
      Promise.resolve({
        command: "supabase-test",
        prefixArgs: [],
      }),
    );

    const managedInventory = inventory([schema("storage", "storage_metadata")]);

    await expect(
      dumpManagedSchemaCustomizations(
        {
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        managedInventory,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    await expect(
      dumpManagedSchemaCustomizations(
        {
          linked: true,
          connectionString: connectionString(),
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        managedInventory,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    expect(resolveSupabaseCommand).not.toHaveBeenCalled();
  });

  it("uses direct database credentials safely for managed-schema diff", async () => {
    const root = await outputDirectory();

    let capturedArgs: readonly string[] = [];
    let capturedPassword: string | undefined;

    const artifacts = await dumpManagedSchemaCustomizations(
      {
        connectionString: connectionString(),
        outputDirectory: root,
        dependencies: {
          resolveSupabaseCommand: () =>
            Promise.resolve({
              command: "supabase-test",
              prefixArgs: ["cli.js"],
            }),
          runProcess: async (_command, args, options) => {
            capturedArgs = args;
            capturedPassword = options.environment?.["PGPASSWORD"];

            const output = args[args.indexOf("--output") + 1];

            if (output === undefined) {
              throw new Error("Missing diff output path");
            }

            await writeFile(
              output,
              "create trigger custom_trigger before insert on auth.users execute function public.audit();\n",
            );

            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          },
        },
      },
      inventory([schema("auth", "auth_data")]),
    );

    expect(artifacts).toHaveLength(1);
    expect(capturedArgs).toContain("--db-url");
    expect(capturedArgs).not.toContain("--linked");
    expect(capturedArgs.join(" ")).not.toContain("database-secret");
    expect(capturedPassword).toBe("database-secret");
  });

  it("reports a failed managed-schema diff without accepting partial output", async () => {
    const root = await outputDirectory();

    await expect(
      dumpManagedSchemaCustomizations(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand: () =>
              Promise.resolve({
                command: "supabase-test",
                prefixArgs: [],
              }),
            runProcess: () =>
              Promise.resolve({
                exitCode: 7,
                stdout: "",
                stderr: "fixture failure",
              }),
          },
        },
        inventory([schema("auth", "auth_data")]),
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_CUSTOMIZATION_EXPORT_FAILED",
      component: "database.auth_storage_customizations",
      details: {
        exitCode: 7,
      },
    });
  });

  it("rejects unavailable dedicated excluded-state components", async () => {
    const root = await outputDirectory();
    const resolveSupabaseCommand = vi.fn();

    await expect(
      dumpExcludedDatabaseComponent(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand,
          },
        },
        inventory(),
        "database.vault_data",
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_DUMP_COMPONENT_INVALID",
      component: "database.vault_data",
    });

    expect(resolveSupabaseCommand).not.toHaveBeenCalled();
  });

  it("maps migration CLI failures to the database.migrations component", async () => {
    const root = await outputDirectory();

    await expect(
      dumpMigrationHistory(
        {
          linked: true,
          outputDirectory: root,
          dependencies: {
            resolveSupabaseCommand: () =>
              Promise.resolve({
                command: "supabase-test",
                prefixArgs: [],
              }),
            runProcess: () =>
              Promise.resolve({
                exitCode: 9,
                stdout: "",
                stderr: "migration failure",
              }),
          },
        },
        inventory([schema("supabase_migrations", "migration_history")]),
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_DUMP_FAILED",
      component: "database.migrations",
      details: {
        exitCode: 9,
      },
    });
  });
});
