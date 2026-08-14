import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database SQL restore", () => {
  it("runs pinned container psql with a password-free URL and environment-only password", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-restore-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "roles.sql"), "select 1;\n");
    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const password = "restore-secret-password";

    await restoreSqlArtifact({
      bundleRoot: root,
      artifact: "roles.sql",
      targetDatabaseUrl: new SecretValue(
        `postgresql://postgres:${password}@db.example.invalid/postgres`,
        new Redactor(),
      ),
      dependencies: { runProcess },
    });

    expect(runProcess).toHaveBeenCalledOnce();
    const [command, args, options] = runProcess.mock.calls[0]!;
    expect(command).toBe("docker");
    expect(args).toContain("ON_ERROR_STOP=1");
    expect(args).toContain("--single-transaction");
    expect(args.join(" ")).not.toContain(password);
    expect(args.join(" ")).toContain(
      "postgresql://postgres@db.example.invalid/postgres",
    );
    expect(Reflect.get(options.environment ?? {}, "PGPASSWORD")).toBe(password);
  });

  it("rejects unsafe and non-SQL artifacts before process execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-restore-"));
    temporaryDirectories.push(root);
    const runProcess = vi.fn();
    const targetDatabaseUrl = new SecretValue(
      "postgresql://postgres:secret@db.example.invalid/postgres",
      new Redactor(),
    );

    await expect(
      restoreSqlArtifact({
        bundleRoot: root,
        artifact: "../escape.sql",
        targetDatabaseUrl,
        dependencies: { runProcess },
      }),
    ).rejects.toBeDefined();
    await expect(
      restoreSqlArtifact({
        bundleRoot: root,
        artifact: "payload.json",
        targetDatabaseUrl,
        dependencies: { runProcess },
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("omits only known platform-managed role grants from execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-db-restore-"));
    temporaryDirectories.push(root);
    const source = [
      'ALTER ROLE "anon" SET "statement_timeout" TO \'3s\';',
      'GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin";',
      'GRANT "postgres" TO "cli_login_postgres" WITH INHERIT FALSE GRANTED BY "supabase_admin";',
      'GRANT SET ON PARAMETER "work_mem" TO "customer_role";',
      "",
    ].join("\n");
    await writeFile(path.join(root, "roles.sql"), source);
    const executed: string[] = [];
    const runProcess = vi.fn<NonNullable<RestoreSqlDependencies["runProcess"]>>(
      async (_command, args) => {
        const volume = args[args.indexOf("--volume") + 1]!;
        const hostRoot = volume.slice(0, -":/backup:ro".length);
        executed.push(await readFile(path.join(hostRoot, "roles.sql"), "utf8"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );
    await restorePlatformCompatibleRolesArtifact({
      bundleRoot: root,
      artifact: "roles.sql",
      targetDatabaseUrl: new SecretValue(
        "postgresql://postgres:secret@db.example.invalid/postgres",
        new Redactor(),
      ),
      dependencies: { runProcess },
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("ALTER ROLE");
    expect(executed[0]).toContain('"work_mem" TO "customer_role"');
    expect(executed[0]).not.toContain('"log_min_messages"');
    expect(executed[0]).not.toContain('TO "cli_login_postgres"');
    expect(await readFile(path.join(root, "roles.sql"), "utf8")).toBe(source);
    expect(
      filterPlatformManagedRoleStatements(
        'GRANT SET ON PARAMETER "work_mem" TO "customer_role";\n',
      ).omittedStatements,
    ).toEqual([]);
  });
});

describe("database extension restore", () => {
  it("creates only missing exact versions with quoted identifiers and literals", async () => {
    const query = vi.fn<RestoreExtensionClient["query"]>(() =>
      Promise.resolve(),
    );
    const client: RestoreExtensionClient = {
      connect: vi.fn(() => Promise.resolve()),
      query,
      end: vi.fn(() => Promise.resolve()),
    };
    await ensureDatabaseExtensions({
      targetDatabaseUrl: new SecretValue(
        "postgresql://postgres:secret@db.example.invalid/postgres",
        new Redactor(),
      ),
      sourceExtensions: [
        { name: 'odd"name', schema: 'odd"schema', version: "1.0'b" },
      ],
      targetExtensions: [],
      createClient: () => client,
    });

    expect(query).toHaveBeenCalledWith(
      'create extension if not exists "odd""name" with schema "odd""schema" version \'1.0\'\'b\'',
    );
  });

  it("fails closed on an existing version or schema conflict", async () => {
    const createClient = vi.fn();
    await expect(
      ensureDatabaseExtensions({
        targetDatabaseUrl: new SecretValue(
          "postgresql://postgres:secret@db.example.invalid/postgres",
          new Redactor(),
        ),
        sourceExtensions: [
          { name: "pgcrypto", schema: "extensions", version: "1.3" },
        ],
        targetExtensions: [
          { name: "pgcrypto", schema: "public", version: "1.3" },
        ],
        createClient,
      }),
    ).rejects.toMatchObject({ code: "DATABASE_EXTENSION_CONFLICT" });
    expect(createClient).not.toHaveBeenCalled();
  });
});
