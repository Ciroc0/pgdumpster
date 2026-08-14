import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureDatabaseExtensions,
  filterPlatformManagedRoleStatements,
  restorePlatformCompatibleRolesArtifact,
  restoreSqlArtifact,
  type RestoreExtensionClient,
  type RestoreSqlDependencies,
} from "../../src/database/restore.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-restore-core-hardening-"),
  );

  temporaryDirectories.push(directory);
  return directory;
}

function targetDatabaseUrl(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:restore-secret@db.example.invalid/postgres",
    new Redactor(),
  );
}

describe("database restore core hardening", () => {
  it("requires the dedicated role restore artifact to be roles.sql", async () => {
    const directory = await root();

    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
    );

    await expect(
      restorePlatformCompatibleRolesArtifact({
        bundleRoot: directory,
        artifact: "database/schema.sql",
        targetDatabaseUrl: targetDatabaseUrl(),
        dependencies: {
          runProcess,
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.roles",
    });

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("delegates an unchanged roles.sql directly when no managed grants exist", async () => {
    const directory = await root();

    await writeFile(
      path.join(directory, "roles.sql"),
      'ALTER ROLE "anon" SET "statement_timeout" TO \'3s\';\n',
    );

    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
    );

    await restorePlatformCompatibleRolesArtifact({
      bundleRoot: directory,
      artifact: "roles.sql",
      targetDatabaseUrl: targetDatabaseUrl(),
      dependencies: {
        runProcess,
      },
    });

    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("handles CRLF platform-managed role statements exactly", () => {
    const filtered = filterPlatformManagedRoleStatements(
      [
        'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
        "select 1;",
        "",
      ].join("\r\n"),
    );

    expect(filtered.omittedStatements).toEqual([
      'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
    ]);

    expect(filtered.sql).toContain("select 1;");
  });

  it("does not create a database client when all extensions already match", async () => {
    const createClient =
      vi.fn<(connectionString: string) => RestoreExtensionClient>();

    await ensureDatabaseExtensions({
      targetDatabaseUrl: targetDatabaseUrl(),
      sourceExtensions: [
        {
          name: "pgcrypto",
          schema: "extensions",
          version: "1.3",
        },
      ],
      targetExtensions: [
        {
          name: "pgcrypto",
          schema: "extensions",
          version: "1.3",
        },
      ],
      createClient,
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  it("wraps extension creation failure and always closes the client", async () => {
    const end = vi.fn(() => Promise.resolve());

    const client: RestoreExtensionClient = {
      connect: vi.fn(() => Promise.resolve()),
      query: vi.fn(() => Promise.reject(new Error("extension create failure"))),
      end,
    };

    await expect(
      ensureDatabaseExtensions({
        targetDatabaseUrl: targetDatabaseUrl(),
        sourceExtensions: [
          {
            name: "vector",
            schema: "extensions",
            version: "0.8.0",
          },
        ],
        targetExtensions: [],
        createClient: () => client,
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_EXTENSION_RESTORE_FAILED",
      component: "database.extensions",
    });

    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves cancellation during extension setup and still closes the client", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel extension restore");

    const query = vi.fn<RestoreExtensionClient["query"]>(() =>
      Promise.resolve(),
    );

    const end = vi.fn(() => Promise.resolve());

    const client: RestoreExtensionClient = {
      connect: vi.fn(() => {
        controller.abort(reason);
        return Promise.resolve();
      }),
      query,
      end,
    };

    await expect(
      ensureDatabaseExtensions({
        targetDatabaseUrl: targetDatabaseUrl(),
        sourceExtensions: [
          {
            name: "vector",
            schema: "extensions",
            version: "0.8.0",
          },
        ],
        targetExtensions: [],
        signal: controller.signal,
        createClient: () => client,
      }),
    ).rejects.toBe(reason);

    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it("rejects a restore bundle root that is a regular file", async () => {
    const directory = await root();
    const file = path.join(directory, "bundle-file");

    await writeFile(file, "not a directory");

    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
    );

    await expect(
      restoreSqlArtifact({
        bundleRoot: file,
        artifact: "roles.sql",
        targetDatabaseUrl: targetDatabaseUrl(),
        dependencies: {
          runProcess,
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
    });

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("rejects a .sql artifact that resolves to a directory", async () => {
    const directory = await root();

    await mkdir(path.join(directory, "payload.sql"));

    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
    );

    await expect(
      restoreSqlArtifact({
        bundleRoot: directory,
        artifact: "payload.sql",
        targetDatabaseUrl: targetDatabaseUrl(),
        dependencies: {
          runProcess,
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
    });

    expect(runProcess).not.toHaveBeenCalled();
  });

  it("supports non-transactional restore mode while preserving process failure semantics", async () => {
    const directory = await root();

    await writeFile(path.join(directory, "data.sql"), "select 1;\n");

    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () =>
        Promise.resolve({
          exitCode: 7,
          stdout: "",
          stderr: "psql failed",
        }),
    );

    await expect(
      restoreSqlArtifact({
        bundleRoot: directory,
        artifact: "data.sql",
        targetDatabaseUrl: targetDatabaseUrl(),
        singleTransaction: false,
        dependencies: {
          runProcess,
        },
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_RESTORE_FAILED",
      details: {
        exitCode: 7,
        artifact: "data.sql",
      },
    });

    const [, args] = runProcess.mock.calls[0]!;

    expect(args).not.toContain("--single-transaction");
  });

  it("honors cancellation before inspecting an artifact", async () => {
    const directory = await root();

    const controller = new AbortController();
    const reason = new Error("cancel SQL restore");

    controller.abort(reason);

    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
    );

    await expect(
      restoreSqlArtifact({
        bundleRoot: directory,
        artifact: "roles.sql",
        targetDatabaseUrl: targetDatabaseUrl(),
        signal: controller.signal,
        dependencies: {
          runProcess,
        },
      }),
    ).rejects.toBe(reason);

    expect(runProcess).not.toHaveBeenCalled();
  });
});
