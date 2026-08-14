import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDedicatedDatabaseRestoreHandlers,
  createLogicalDatabaseRestoreHandlers,
  type DatabaseRestoreHandlerDependencies,
} from "../../src/core/restore/database-handlers.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
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

async function bundle(sql: string): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-database-handler-"),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "database"));
  await writeFile(path.join(root, "database", "roles.sql"), sql);
  return root;
}

function rolesAction(artifacts = ["database/roles.sql"]): RestoreAction {
  return {
    id: "restore.database.roles",
    component: "database.roles",
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

describe("logical database restore handlers", () => {
  it("applies verified SQL and ignores only pg_dump restriction nonces", async () => {
    const root = await bundle(
      "-- \\restrict SOURCE123\nALTER ROLE anon SET statement_timeout TO '3s';\n-- \\unrestrict SOURCE123\n",
    );
    const restore = vi
      .fn<
        NonNullable<DatabaseRestoreHandlerDependencies["restoreSqlArtifact"]>
      >()
      .mockResolvedValue(undefined);
    const dump = vi.fn<
      NonNullable<
        DatabaseRestoreHandlerDependencies["dumpLogicalDatabaseComponent"]
      >
    >(async (options, component) => {
      const directory = path.join(options.outputDirectory, "database");
      await mkdir(directory);
      const filename = path.join(directory, "roles.sql");
      await writeFile(
        filename,
        "-- \\restrict TARGET999\nALTER ROLE anon SET statement_timeout TO '3s';\n-- \\unrestrict TARGET999\n",
      );
      return {
        id: component,
        path: filename,
        bytes: 100,
      };
    });
    const handlers = createLogicalDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: new SecretValue(
        "postgresql://postgres:secret@db.example.invalid/postgres",
        new Redactor(),
      ),
      dependencies: {
        restoreSqlArtifact: restore,
        restorePlatformCompatibleRolesArtifact: restore,
        dumpLogicalDatabaseComponent: dump,
      },
    });
    const handler = handlers["database.roles"];

    const applied = await handler.apply({
      action: rolesAction(),
      attempt: 1,
    });
    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(restore).toHaveBeenCalledOnce();
    await expect(
      handler.verify({
        action: rolesAction(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("detects semantic SQL drift and rejects unsafe artifact sets", async () => {
    const root = await bundle(
      "ALTER ROLE anon SET statement_timeout TO '3s';\n",
    );
    const dump = vi.fn<
      NonNullable<
        DatabaseRestoreHandlerDependencies["dumpLogicalDatabaseComponent"]
      >
    >(async (options, component) => {
      const directory = path.join(options.outputDirectory, "database");
      await mkdir(directory);
      const filename = path.join(directory, "roles.sql");
      await writeFile(
        filename,
        "ALTER ROLE anon SET statement_timeout TO '8s';\n",
      );
      return { id: component, path: filename, bytes: 50 };
    });
    const restore = vi
      .fn<
        NonNullable<DatabaseRestoreHandlerDependencies["restoreSqlArtifact"]>
      >()
      .mockResolvedValue(undefined);
    const handler = createLogicalDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: new SecretValue(
        "postgresql://postgres:secret@db.example.invalid/postgres",
        new Redactor(),
      ),
      dependencies: {
        restoreSqlArtifact: restore,
        restorePlatformCompatibleRolesArtifact: restore,
        dumpLogicalDatabaseComponent: dump,
      },
    })["database.roles"];

    await expect(handler.verify({ action: rolesAction() })).resolves.toBe(
      false,
    );
    await expect(
      handler.apply({ action: rolesAction(["../roles.sql"]), attempt: 1 }),
    ).rejects.toBeDefined();
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("dedicated database restore handlers", () => {
  it("applies and semantically re-dumps Auth data with inventory scope", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-dedicated-handler-"),
    );
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "database"));
    const sql = "COPY auth.users (id) FROM stdin;\n\\.\n";
    await writeFile(path.join(root, "database", "auth-data.sql"), sql);
    await writeFile(
      path.join(root, "database", "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        extensions: [],
        schemas: [
          {
            name: "auth",
            extension: null,
            persistentTableCount: 1,
            persistentBytes: "0",
            classification: "auth_data",
          },
        ],
        unclassifiedPersistentSchemas: [],
      }),
    );
    const restore = vi
      .fn<
        NonNullable<DatabaseRestoreHandlerDependencies["restoreSqlArtifact"]>
      >()
      .mockResolvedValue(undefined);
    let dumpCalls = 0;
    const dump = vi.fn<
      NonNullable<
        DatabaseRestoreHandlerDependencies["dumpExcludedDatabaseComponent"]
      >
    >(async (options, _inventory, component) => {
      const directory = path.join(options.outputDirectory, "database");
      await mkdir(directory);
      const filename = path.join(directory, "auth-data.sql");
      await writeFile(
        filename,
        dumpCalls++ === 0 ? "COPY auth.users (id) FROM stdin;\n1\n\\.\n" : sql,
      );
      return { id: component, path: filename, bytes: Buffer.byteLength(sql) };
    });
    const handler = createDedicatedDatabaseRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: new SecretValue(
        "postgresql://postgres:secret@db.example.invalid/postgres",
        new Redactor(),
      ),
      dependencies: {
        restoreSqlArtifact: restore,
        dumpExcludedDatabaseComponent: dump,
      },
    })["auth.data"];
    const authAction: RestoreAction = {
      id: "restore.auth.data",
      component: "auth.data",
      phase: 7,
      operation: "apply_logical_database_state",
      risk: "mutation",
      billable: false,
      dependsOn: ["restore.database.data"],
      status: "planned",
      sourceStatus: "backed_up",
      restorePolicy: "restore",
      fidelity: "semantic",
      artifacts: ["database/auth-data.sql"],
    };

    const applied = await handler.apply({ action: authAction, attempt: 1 });
    expect(restore).toHaveBeenCalledOnce();
    await expect(
      handler.verify({
        action: authAction,
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    expect(dump).toHaveBeenCalledTimes(2);
  });
});
