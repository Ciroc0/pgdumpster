import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabaseCatalogState } from "../../src/database/catalog-state.js";
import type { DatabaseDumpArtifact } from "../../src/database/dump.js";
import type { DatabaseInventory } from "../../src/database/inventory.js";
import {
  createDatabaseSupplementRestoreHandlers,
  type DatabaseSupplementRestoreDependencies,
  type DatabaseSupplementRestoreComponent,
} from "../../src/core/restore/database-supplement-handlers.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const temporaryDirectories: string[] = [];

const sourceSql = {
  migrationSchema:
    "-- \\restrict SOURCE\nCREATE TABLE supabase_migrations.schema_migrations(version text);\n-- \\unrestrict SOURCE\n",
  migrationData:
    "-- \\restrict SOURCE\nCOPY supabase_migrations.schema_migrations (version) FROM stdin;\n001\n\\.\n-- \\unrestrict SOURCE\n",
  customization: "ALTER TABLE auth.users ADD COLUMN app_flag boolean;\n",
  cron: "COPY cron.job (jobid) FROM stdin;\n1\n\\.\n",
  queues: "COPY pgmq.q_demo (msg_id) FROM stdin;\n1\n\\.\n",
};

function targetDatabaseUrl(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:secret@db.example.invalid/postgres",
    new Redactor(),
  );
}

function inventory(
  classifications: readonly DatabaseInventory["schemas"][number]["classification"][] = [],
): DatabaseInventory {
  return {
    schemaVersion: 1,
    extensions: [],
    schemas: classifications.map((classification, index) => ({
      name:
        classification === "migration_history"
          ? "supabase_migrations"
          : classification === "cron"
            ? "cron"
            : classification === "queues"
              ? index === 0
                ? "pgmq"
                : "pgmq_public"
              : `schema_${index}`,
      extension: null,
      persistentTableCount: 1,
      persistentBytes: "0",
      classification,
    })),
    unclassifiedPersistentSchemas: [],
  };
}

function catalog(
  webhooks: DatabaseCatalogState["webhooks"] = [],
): DatabaseCatalogState {
  return {
    schemaVersion: 1,
    publications: [],
    publicationTables: [],
    webhooks,
  };
}

async function bundle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-supplement-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "database"));
  await writeFile(
    path.join(root, "database", "migration-history-schema.sql"),
    sourceSql.migrationSchema,
  );
  await writeFile(
    path.join(root, "database", "migration-history-data.sql"),
    sourceSql.migrationData,
  );
  await writeFile(
    path.join(root, "database", "auth-storage-customizations.sql"),
    sourceSql.customization,
  );
  await writeFile(path.join(root, "database", "cron-data.sql"), sourceSql.cron);
  await writeFile(
    path.join(root, "database", "queues-data.sql"),
    sourceSql.queues,
  );
  await writeFile(
    path.join(root, "database", "catalog-state.json"),
    JSON.stringify(catalog()),
  );
  return root;
}

function artifacts(component: DatabaseSupplementRestoreComponent): string[] {
  if (component === "database.migrations") {
    return [
      "database/migration-history-schema.sql",
      "database/migration-history-data.sql",
    ];
  }
  if (component === "database.auth_storage_customizations") {
    return ["database/auth-storage-customizations.sql"];
  }
  if (component === "database.cron") return ["database/cron-data.sql"];
  if (component === "database.queues") return ["database/queues-data.sql"];
  return ["database/catalog-state.json"];
}

function action(component: DatabaseSupplementRestoreComponent): RestoreAction {
  return {
    id: `restore.${component}`,
    component,
    phase:
      component === "database.migrations" ||
      component === "database.auth_storage_customizations"
        ? 8
        : 7,
    operation: "apply_logical_database_state",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "restore",
    fidelity: "semantic",
    artifacts: artifacts(component),
  };
}

async function writeDump(
  outputDirectory: string,
  filename: string,
  contents: string,
  id: DatabaseDumpArtifact["id"],
): Promise<DatabaseDumpArtifact> {
  const directory = path.join(outputDirectory, "database");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, filename);
  await writeFile(file, contents);
  return { id, path: file, bytes: Buffer.byteLength(contents) };
}

function baseDependencies(
  overrides: DatabaseSupplementRestoreDependencies = {},
): DatabaseSupplementRestoreDependencies {
  return {
    collectDatabaseInventory: vi.fn().mockResolvedValue(inventory()),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database supplement restore handlers", () => {
  it("restores migration schema and data when the target has no migration history", async () => {
    const root = await bundle();
    const restore = vi.fn().mockResolvedValue(undefined);
    let observed = false;
    const dumpMigrationHistory = vi.fn<
      NonNullable<DatabaseSupplementRestoreDependencies["dumpMigrationHistory"]>
    >(async (options) => {
      if (!observed) {
        observed = true;
        return [];
      }
      return [
        await writeDump(
          options.outputDirectory,
          "migration-history-schema.sql",
          sourceSql.migrationSchema.replaceAll("SOURCE", "TARGET"),
          "database.migrations_schema",
        ),
        await writeDump(
          options.outputDirectory,
          "migration-history-data.sql",
          sourceSql.migrationData.replaceAll("SOURCE", "TARGET"),
          "database.migrations_data",
        ),
      ];
    });
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies({
        restoreSqlArtifact: restore,
        dumpMigrationHistory,
      }),
    })["database.migrations"];

    const applied = await handler.apply({
      action: action("database.migrations"),
      attempt: 1,
    });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore.mock.calls.map(([options]) => options.artifact)).toEqual([
      "database/migration-history-schema.sql",
      "database/migration-history-data.sql",
    ]);
    await expect(
      handler.verify({
        action: action("database.migrations"),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("restores only empty migration data when the schema already matches", async () => {
    const root = await bundle();
    const restore = vi.fn().mockResolvedValue(undefined);
    let applied = false;
    restore.mockImplementation(() => {
      applied = true;
      return Promise.resolve();
    });
    const dumpMigrationHistory = vi.fn<
      NonNullable<DatabaseSupplementRestoreDependencies["dumpMigrationHistory"]>
    >(async (options) => [
      await writeDump(
        options.outputDirectory,
        "migration-history-schema.sql",
        sourceSql.migrationSchema.replaceAll("SOURCE", "TARGET"),
        "database.migrations_schema",
      ),
      await writeDump(
        options.outputDirectory,
        "migration-history-data.sql",
        applied
          ? sourceSql.migrationData.replaceAll("SOURCE", "TARGET")
          : "COPY supabase_migrations.schema_migrations (version) FROM stdin;\n\\.\n",
        "database.migrations_data",
      ),
    ]);
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({
        restoreSqlArtifact: restore,
        dumpMigrationHistory,
      }),
    })["database.migrations"];

    const result = await handler.apply({
      action: action("database.migrations"),
      attempt: 1,
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(restore.mock.calls[0]?.[0]).toMatchObject({
      artifact: "database/migration-history-data.sql",
    });
    await expect(
      handler.verify({
        action: action("database.migrations"),
        expectedFingerprint: result.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("refuses incompatible migration schema or non-empty target migration rows", async () => {
    const root = await bundle();
    let incompatibleSchema = true;
    const dumpMigrationHistory = vi.fn<
      NonNullable<DatabaseSupplementRestoreDependencies["dumpMigrationHistory"]>
    >(async (options) => [
      await writeDump(
        options.outputDirectory,
        "migration-history-schema.sql",
        incompatibleSchema
          ? "CREATE TABLE supabase_migrations.other(id int);\n"
          : sourceSql.migrationSchema,
        "database.migrations_schema",
      ),
      await writeDump(
        options.outputDirectory,
        "migration-history-data.sql",
        "COPY supabase_migrations.schema_migrations (version) FROM stdin;\n999\n\\.\n",
        "database.migrations_data",
      ),
    ]);
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({ dumpMigrationHistory }),
    })["database.migrations"];

    await expect(
      handler.apply({ action: action("database.migrations"), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    incompatibleSchema = false;
    await expect(
      handler.apply({ action: action("database.migrations"), attempt: 2 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
  });

  it("rejects incomplete target migration evidence and mismatched resume fingerprints", async () => {
    const root = await bundle();
    const dumpMigrationHistory = vi.fn<
      NonNullable<DatabaseSupplementRestoreDependencies["dumpMigrationHistory"]>
    >(async (options) => [
      await writeDump(
        options.outputDirectory,
        "migration-history-schema.sql",
        sourceSql.migrationSchema,
        "database.migrations_schema",
      ),
    ]);
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies({ dumpMigrationHistory }),
    })["database.migrations"];

    await expect(
      handler.verify({ action: action("database.migrations") }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_EVIDENCE_INVALID" });

    const noEvidence = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies({
        dumpMigrationHistory: vi.fn().mockResolvedValue([]),
      }),
    })["database.migrations"];
    await expect(
      noEvidence.verify({
        action: action("database.migrations"),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("applies a managed-schema customization only to a clean target", async () => {
    const root = await bundle();
    const restore = vi.fn().mockResolvedValue(undefined);
    let applied = false;
    restore.mockImplementation(() => {
      applied = true;
      return Promise.resolve();
    });
    const dumpManagedSchemaCustomizations = vi.fn<
      NonNullable<
        DatabaseSupplementRestoreDependencies["dumpManagedSchemaCustomizations"]
      >
    >(async (options) =>
      applied
        ? [
            await writeDump(
              options.outputDirectory,
              "auth-storage-customizations.sql",
              sourceSql.customization,
              "database.auth_storage_customizations",
            ),
          ]
        : [],
    );
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies({
        restoreSqlArtifact: restore,
        dumpManagedSchemaCustomizations,
      }),
    })["database.auth_storage_customizations"];

    const result = await handler.apply({
      action: action("database.auth_storage_customizations"),
      attempt: 1,
    });
    expect(restore).toHaveBeenCalledOnce();
    await expect(
      handler.verify({
        action: action("database.auth_storage_customizations"),
        expectedFingerprint: result.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("refuses a different managed-schema customization even with replace policy", async () => {
    const root = await bundle();
    const dumpManagedSchemaCustomizations = vi.fn<
      NonNullable<
        DatabaseSupplementRestoreDependencies["dumpManagedSchemaCustomizations"]
      >
    >(async (options) => [
      await writeDump(
        options.outputDirectory,
        "other.sql",
        "ALTER TABLE auth.users ADD COLUMN different boolean;\n",
        "database.auth_storage_customizations",
      ),
    ]);
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({ dumpManagedSchemaCustomizations }),
    })["database.auth_storage_customizations"];

    await expect(
      handler.apply({
        action: action("database.auth_storage_customizations"),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    await expect(
      handler.verify({
        action: action("database.auth_storage_customizations"),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("restores empty Cron state and skips an already matching Queue dump", async () => {
    const root = await bundle();
    const restore = vi.fn().mockResolvedValue(undefined);
    let cronApplied = false;
    restore.mockImplementation((options) => {
      if (options.artifact === "database/cron-data.sql") cronApplied = true;
      return Promise.resolve();
    });
    const dumpExcludedDatabaseComponent = vi.fn<
      NonNullable<
        DatabaseSupplementRestoreDependencies["dumpExcludedDatabaseComponent"]
      >
    >(async (options, _inventory, component) =>
      component === "database.cron"
        ? writeDump(
            options.outputDirectory,
            "cron-data.sql",
            cronApplied
              ? sourceSql.cron
              : "COPY cron.job (jobid) FROM stdin;\n\\.\n",
            "database.cron",
          )
        : writeDump(
            options.outputDirectory,
            "queues-data.sql",
            sourceSql.queues,
            "database.queues",
          ),
    );
    const handlers = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies({
        restoreSqlArtifact: restore,
        dumpExcludedDatabaseComponent,
      }),
    });

    const cron = await handlers["database.cron"].apply({
      action: action("database.cron"),
      attempt: 1,
    });
    expect(restore).toHaveBeenCalledOnce();
    await expect(
      handlers["database.cron"].verify({
        action: action("database.cron"),
        expectedFingerprint: cron.fingerprint,
      }),
    ).resolves.toBe(true);

    await handlers["database.queues"].apply({
      action: action("database.queues"),
      attempt: 1,
    });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("refuses to merge different non-empty Cron state", async () => {
    const root = await bundle();
    const dumpExcludedDatabaseComponent = vi.fn<
      NonNullable<
        DatabaseSupplementRestoreDependencies["dumpExcludedDatabaseComponent"]
      >
    >(async (options) =>
      writeDump(
        options.outputDirectory,
        "cron-data.sql",
        "COPY cron.job (jobid) FROM stdin;\n99\n\\.\n",
        "database.cron",
      ),
    );
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({ dumpExcludedDatabaseComponent }),
    })["database.cron"];

    await expect(
      handler.apply({ action: action("database.cron"), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
  });

  it("fails closed on an unexpected artifact set", async () => {
    const root = await bundle();
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies(),
    })["database.cron"];
    const invalid = action("database.cron");
    invalid.artifacts = ["database/queues-data.sql"];

    await expect(handler.apply({ action: invalid, attempt: 1 })).rejects.toMatchObject(
      { code: "RESTORE_ARTIFACT_INVALID" },
    );
  });

  it("refuses extra or changed Database Webhooks under fail policy", async () => {
    const root = await bundle();
    const sourceWebhook: DatabaseCatalogState["webhooks"][number] = {
      schema: "public",
      table: "orders",
      name: "orders_hook",
      enabled: "O",
      functionSchema: "supabase_functions",
      functionName: "http_request",
      definition:
        "CREATE TRIGGER orders_hook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://example.invalid','POST','{}','{}','1000')",
    };
    await writeFile(
      path.join(root, "database", "catalog-state.json"),
      JSON.stringify(catalog([sourceWebhook])),
    );
    const extra = {
      ...sourceWebhook,
      table: "other",
      name: "extra_hook",
      definition: sourceWebhook.definition.replaceAll("orders", "other"),
    };
    const collectDatabaseCatalogState = vi
      .fn<
        NonNullable<
          DatabaseSupplementRestoreDependencies["collectDatabaseCatalogState"]
        >
      >()
      .mockResolvedValue(catalog([sourceWebhook, extra]));
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "fail",
      dependencies: baseDependencies({ collectDatabaseCatalogState }),
    })["database.webhooks"];

    await expect(
      handler.apply({ action: action("database.webhooks"), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });

    collectDatabaseCatalogState.mockResolvedValue(
      catalog([{ ...sourceWebhook, definition: `${sourceWebhook.definition} changed` }]),
    );
    await expect(
      handler.apply({ action: action("database.webhooks"), attempt: 2 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
  });

  it("reconciles Database Webhooks transactionally under replace policy", async () => {
    const root = await bundle();
    const hookA: DatabaseCatalogState["webhooks"][number] = {
      schema: "public",
      table: "orders",
      name: "orders_hook",
      enabled: "D",
      functionSchema: "supabase_functions",
      functionName: "http_request",
      definition:
        "CREATE TRIGGER orders_hook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://a.invalid','POST','{}','{}','1000')",
    };
    const hookB: DatabaseCatalogState["webhooks"][number] = {
      schema: "public",
      table: "profiles",
      name: "profiles_hook",
      enabled: "O",
      functionSchema: "supabase_functions",
      functionName: "http_request",
      definition:
        "CREATE TRIGGER profiles_hook AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://b.invalid','POST','{}','{}','1000')",
    };
    await writeFile(
      path.join(root, "database", "catalog-state.json"),
      JSON.stringify(catalog([hookA, hookB])),
    );
    const extra = {
      ...hookB,
      table: "extra",
      name: "extra_hook",
      definition: hookB.definition.replaceAll("profiles", "extra"),
    };
    const changedA = {
      ...hookA,
      enabled: "R" as const,
      definition: hookA.definition.replace("https://a.invalid", "https://old.invalid"),
    };
    const collectDatabaseCatalogState = vi
      .fn<
        NonNullable<
          DatabaseSupplementRestoreDependencies["collectDatabaseCatalogState"]
        >
      >()
      .mockResolvedValueOnce(catalog([changedA, extra]))
      .mockResolvedValue(catalog([hookA, hookB]));
    const queries: string[] = [];
    const createWebhookClient = vi.fn(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve({});
      }),
      end: vi.fn().mockResolvedValue(undefined),
    }));
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({
        collectDatabaseCatalogState,
        createWebhookClient,
      }),
    })["database.webhooks"];

    const result = await handler.apply({
      action: action("database.webhooks"),
      attempt: 1,
    });
    expect(createWebhookClient).toHaveBeenCalledOnce();
    expect(queries[0]).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(queries.some((sql) => sql.includes("DROP TRIGGER"))).toBe(true);
    expect(queries.some((sql) => sql === hookA.definition)).toBe(true);
    expect(queries.some((sql) => sql === hookB.definition)).toBe(true);
    expect(queries.some((sql) => sql.includes("DISABLE TRIGGER"))).toBe(true);
    await expect(
      handler.verify({
        action: action("database.webhooks"),
        expectedFingerprint: result.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("updates only trigger enablement when the Database Webhook definition matches", async () => {
    const root = await bundle();
    const sourceWebhook: DatabaseCatalogState["webhooks"][number] = {
      schema: "public",
      table: "orders",
      name: "orders_hook",
      enabled: "O",
      functionSchema: "supabase_functions",
      functionName: "http_request",
      definition:
        "CREATE TRIGGER orders_hook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://example.invalid','POST','{}','{}','1000')",
    };
    await writeFile(
      path.join(root, "database", "catalog-state.json"),
      JSON.stringify(catalog([sourceWebhook])),
    );
    const collectDatabaseCatalogState = vi
      .fn<
        NonNullable<
          DatabaseSupplementRestoreDependencies["collectDatabaseCatalogState"]
        >
      >()
      .mockResolvedValueOnce(catalog([{ ...sourceWebhook, enabled: "D" }]))
      .mockResolvedValue(catalog([sourceWebhook]));
    const queries: string[] = [];
    const createWebhookClient = vi.fn(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve({});
      }),
      end: vi.fn().mockResolvedValue(undefined),
    }));
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({
        collectDatabaseCatalogState,
        createWebhookClient,
      }),
    })["database.webhooks"];

    await handler.apply({ action: action("database.webhooks"), attempt: 1 });
    expect(queries).toContain(
      'ALTER TABLE "public"."orders" ENABLE TRIGGER "orders_hook"',
    );
    expect(queries.some((sql) => sql.startsWith("DROP TRIGGER"))).toBe(false);
  });

  it("rejects unsupported Webhook definitions and persists rollback on query failure", async () => {
    const root = await bundle();
    const invalid: DatabaseCatalogState["webhooks"][number] = {
      schema: "public",
      table: "orders",
      name: "orders_hook",
      enabled: "A",
      functionSchema: "public",
      functionName: "evil",
      definition: "CREATE TRIGGER orders_hook AFTER INSERT ON public.orders EXECUTE FUNCTION public.evil()",
    };
    await writeFile(
      path.join(root, "database", "catalog-state.json"),
      JSON.stringify(catalog([invalid])),
    );
    const emptyTarget = vi.fn().mockResolvedValue(catalog());
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({
        collectDatabaseCatalogState: emptyTarget,
      }),
    })["database.webhooks"];
    await expect(
      handler.apply({ action: action("database.webhooks"), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const valid = {
      ...invalid,
      functionSchema: "supabase_functions",
      functionName: "http_request",
      definition:
        "CREATE TRIGGER orders_hook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://example.invalid','POST','{}','{}','1000')",
    };
    await writeFile(
      path.join(root, "database", "catalog-state.json"),
      JSON.stringify(catalog([valid])),
    );
    const queries: string[] = [];
    const failingClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn((sql: string) => {
        queries.push(sql);
        return sql.startsWith("CREATE TRIGGER")
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({});
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const failing = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      conflictPolicy: "replace",
      dependencies: baseDependencies({
        collectDatabaseCatalogState: emptyTarget,
        createWebhookClient: () => failingClient,
      }),
    })["database.webhooks"];
    await expect(
      failing.apply({ action: action("database.webhooks"), attempt: 1 }),
    ).rejects.toMatchObject({ code: "DATABASE_WEBHOOK_RESTORE_FAILED" });
    expect(queries).toContain("ROLLBACK");
    expect(failingClient.end).toHaveBeenCalledOnce();
  });
});
