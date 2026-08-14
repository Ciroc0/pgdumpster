import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabaseExtensionRestoreHandler,
  createDatabaseRestoreHandlers,
  createDedicatedDatabaseRestoreHandlers,
  createLogicalDatabaseRestoreHandlers,
  type DatabaseRestoreHandlerDependencies,
} from "../../src/core/restore/database-handlers.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
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

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-database-hardening-"),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "database"), { recursive: true });
  return root;
}

async function writeMetadata(
  root: string,
  inventory: DatabaseInventory,
): Promise<void> {
  await writeFile(
    path.join(root, "database", "metadata.json"),
    JSON.stringify(inventory),
  );
}

function targetDatabaseUrl(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:secret@db.example.invalid/postgres",
    new Redactor(),
  );
}

function action(component: string, artifacts: string[]): RestoreAction {
  return {
    id: `restore.${component}`,
    component,
    phase: 4,
    operation: "apply_logical_database_state",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "restore",
    fidelity: "semantic",
    artifacts,
  };
}

const sourceInventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [
    {
      name: "vector",
      version: "0.8.0",
      schema: "extensions",
    },
  ],
  schemas: [],
  unclassifiedPersistentSchemas: [],
};

const olderTargetInventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [
    {
      name: "vector",
      version: "0.7.0",
      schema: "extensions",
    },
  ],
  schemas: [],
  unclassifiedPersistentSchemas: [],
};

describe("database restore hardening", () => {
  it("applies extensions and verifies exact version/schema parity", async () => {
    const root = await workspace();
    await writeMetadata(root, sourceInventory);

    const collect = vi
      .fn<
        NonNullable<
          DatabaseRestoreHandlerDependencies["collectDatabaseInventory"]
        >
      >()
      .mockResolvedValueOnce(olderTargetInventory)
      .mockResolvedValueOnce(sourceInventory)
      .mockResolvedValueOnce({
        ...sourceInventory,
        extensions: [
          {
            name: "vector",
            version: "0.8.0",
            schema: "other_schema",
          },
        ],
      });

    const ensure = vi
      .fn<
        NonNullable<
          DatabaseRestoreHandlerDependencies["ensureDatabaseExtensions"]
        >
      >()
      .mockResolvedValue(undefined);

    const databaseUrl = targetDatabaseUrl();

    const handler = createDatabaseExtensionRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl: databaseUrl,
      dependencies: {
        collectDatabaseInventory: collect,
        ensureDatabaseExtensions: ensure,
      },
    });

    const restoreAction = action("database.extensions", [
      "database/metadata.json",
    ]);
    const controller = new AbortController();

    const applied = await handler.apply({
      action: restoreAction,
      attempt: 1,
      signal: controller.signal,
    });

    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(ensure).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDatabaseUrl: databaseUrl,
        sourceExtensions: sourceInventory.extensions,
        targetExtensions: olderTargetInventory.extensions,
        signal: controller.signal,
      }),
    );

    await expect(
      handler.verify({
        action: restoreAction,
      }),
    ).resolves.toBe(true);

    await expect(
      handler.verify({
        action: restoreAction,
      }),
    ).resolves.toBe(false);
  });

  it("rejects wrong extension artifacts and malformed inventory", async () => {
    const root = await workspace();
    await writeMetadata(root, sourceInventory);

    const collect =
      vi.fn<
        NonNullable<
          DatabaseRestoreHandlerDependencies["collectDatabaseInventory"]
        >
      >();

    const ensure =
      vi.fn<
        NonNullable<
          DatabaseRestoreHandlerDependencies["ensureDatabaseExtensions"]
        >
      >();

    const handler = createDatabaseExtensionRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      dependencies: {
        collectDatabaseInventory: collect,
        ensureDatabaseExtensions: ensure,
      },
    });

    await expect(
      handler.apply({
        action: action("database.extensions", ["database/schema.sql"]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.extensions",
    });

    const malformedRoot = await workspace();
    await writeFile(path.join(malformedRoot, "database", "metadata.json"), "{");

    const malformedHandler = createDatabaseExtensionRestoreHandler({
      bundleRoot: malformedRoot,
      targetDatabaseUrl: targetDatabaseUrl(),
      dependencies: {
        collectDatabaseInventory: collect,
        ensureDatabaseExtensions: ensure,
      },
    });

    await expect(
      malformedHandler.apply({
        action: action("database.extensions", ["database/metadata.json"]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.extensions",
    });

    expect(collect).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("uses the normal SQL restore path and inventory-scoped database.data verification", async () => {
    const root = await workspace();
    await writeMetadata(root, sourceInventory);

    const schemaSql = "CREATE TABLE public.items (id bigint);\n";
    const dataSql = "COPY public.items (id) FROM stdin;\n1\n\\.\n";

    await writeFile(path.join(root, "database", "schema.sql"), schemaSql);
    await writeFile(path.join(root, "database", "data.sql"), dataSql);

    const restore = vi
      .fn<
        NonNullable<DatabaseRestoreHandlerDependencies["restoreSqlArtifact"]>
      >()
      .mockResolvedValue(undefined);

    const dump = vi.fn<
      NonNullable<
        DatabaseRestoreHandlerDependencies["dumpLogicalDatabaseComponent"]
      >
    >(async (options, component, inventory) => {
      expect(component).toBe("database.data");
      expect(inventory).toEqual(sourceInventory);

      const directory = path.join(options.outputDirectory, "database");
      await mkdir(directory, { recursive: true });

      const filename = path.join(directory, "data.sql");
      await writeFile(filename, dataSql);

      return {
        id: component,
        path: filename,
        bytes: Buffer.byteLength(dataSql),
      };
    });

    const handlers = createLogicalDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      dependencies: {
        restoreSqlArtifact: restore,
        restorePlatformCompatibleRolesArtifact: restore,
        dumpLogicalDatabaseComponent: dump,
      },
    });

    const controller = new AbortController();

    await handlers["database.schema"].apply({
      action: action("database.schema", ["database/schema.sql"]),
      attempt: 1,
      signal: controller.signal,
    });

    expect(restore).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "database/schema.sql",
        signal: controller.signal,
      }),
    );

    await expect(
      handlers["database.data"].verify({
        action: action("database.data", ["database/data.sql"]),
      }),
    ).resolves.toBe(true);

    expect(dump).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid SQL artifact sets and non-regular files", async () => {
    const root = await workspace();

    const restore =
      vi.fn<
        NonNullable<DatabaseRestoreHandlerDependencies["restoreSqlArtifact"]>
      >();

    const handlers = createLogicalDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      dependencies: {
        restoreSqlArtifact: restore,
        restorePlatformCompatibleRolesArtifact: restore,
      },
    });

    await expect(
      handlers["database.schema"].apply({
        action: action("database.schema", []),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.schema",
    });

    await mkdir(path.join(root, "database", "not-a-file.sql"), {
      recursive: true,
    });

    await expect(
      handlers["database.schema"].apply({
        action: action("database.schema", ["database/not-a-file.sql"]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
    });

    expect(restore).not.toHaveBeenCalled();
  });

  it("no-ops an already matching Vault data target and verifies without a supplied fingerprint", async () => {
    const root = await workspace();

    const sql = "COPY vault.secrets (id) FROM stdin;\n1\n\\.\n";

    await writeMetadata(root, sourceInventory);
    await writeFile(path.join(root, "database", "vault.sql"), sql);

    const restore = vi
      .fn<
        NonNullable<DatabaseRestoreHandlerDependencies["restoreSqlArtifact"]>
      >()
      .mockResolvedValue(undefined);

    const dump = vi.fn<
      NonNullable<
        DatabaseRestoreHandlerDependencies["dumpExcludedDatabaseComponent"]
      >
    >(async (options, _inventory, component) => {
      const directory = path.join(options.outputDirectory, "database");
      await mkdir(directory, { recursive: true });

      const filename = path.join(directory, "vault.sql");
      await writeFile(filename, sql);

      return {
        id: component,
        path: filename,
        bytes: Buffer.byteLength(sql),
      };
    });

    const handler = createDedicatedDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
      dependencies: {
        restoreSqlArtifact: restore,
        dumpExcludedDatabaseComponent: dump,
      },
    })["database.vault_data"];

    const restoreAction = action("database.vault_data", ["database/vault.sql"]);

    const applied = await handler.apply({
      action: restoreAction,
      attempt: 1,
    });

    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(restore).not.toHaveBeenCalled();

    await expect(
      handler.verify({
        action: restoreAction,
      }),
    ).resolves.toBe(true);

    expect(dump).toHaveBeenCalledTimes(2);
  });

  it("constructs the complete database restore handler registry", async () => {
    const root = await workspace();

    const handlers = createDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: targetDatabaseUrl(),
    });

    expect(Object.keys(handlers).sort()).toEqual([
      "auth.data",
      "database.data",
      "database.extensions",
      "database.roles",
      "database.schema",
      "database.vault_data",
    ]);
  });
});
