import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPublicationRestoreHandler } from "../../src/core/restore/publication-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
import type {
  DatabaseCatalogState,
  PublicationState,
  PublicationTableState,
} from "../../src/database/catalog-state.js";
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

const targetDatabaseUrl = new SecretValue(
  "postgresql://postgres:secret@db.example.invalid/postgres",
  new Redactor(),
);

function publication(
  overrides: Partial<PublicationState> = {},
): PublicationState {
  return {
    name: "supabase_realtime",
    owner: "postgres",
    allTables: false,
    publish: {
      insert: true,
      update: true,
      delete: true,
      truncate: true,
    },
    ...overrides,
  };
}

function table(
  overrides: Partial<PublicationTableState> = {},
): PublicationTableState {
  return {
    publication: "supabase_realtime",
    schema: "public",
    table: "events",
    columns: null,
    rowFilter: null,
    ...overrides,
  };
}

function state(
  publications: PublicationState[] = [],
  publicationTables: PublicationTableState[] = [],
): DatabaseCatalogState {
  return {
    schemaVersion: 1,
    publications,
    publicationTables,
    webhooks: [],
  };
}

async function bundle(source: DatabaseCatalogState): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-publication-hardening-"),
  );
  temporaryDirectories.push(root);

  await mkdir(path.join(root, "database"), {
    recursive: true,
  });

  await writeFile(
    path.join(root, "database", "catalog-state.json"),
    JSON.stringify(source),
  );

  return root;
}

function action(artifacts = ["database/catalog-state.json"]): RestoreAction {
  return {
    id: "restore.database.publications",
    component: "database.publications",
    phase: 9,
    operation: "apply_logical_database_state",
    risk: "mutation",
    billable: false,
    dependsOn: ["restore.database.data"],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "explicit_restore",
    fidelity: "semantic",
    artifacts,
  };
}

function mutationClient(options?: { failOn?: (sql: string) => boolean }) {
  const statements: string[] = [];
  const connect = vi.fn(() => Promise.resolve());
  const end = vi.fn(() => Promise.resolve());

  const query = vi.fn((sql: string) => {
    statements.push(sql);

    if (options?.failOn?.(sql) === true) {
      return Promise.reject(new Error("fixture query failure"));
    }

    return Promise.resolve();
  });

  return {
    client: {
      connect,
      query,
      end,
    },
    statements,
    connect,
    query,
    end,
  };
}

describe("publication restore hardening", () => {
  it("creates a missing publication and restores its table definition", async () => {
    const source = state(
      [
        publication({
          owner: 'reporting"owner',
          publish: {
            insert: true,
            update: false,
            delete: true,
            truncate: false,
          },
        }),
      ],
      [
        table({
          columns: ["id", "created_at"],
          rowFilter: "id > 10",
        }),
      ],
    );

    const root = await bundle(source);
    const mutation = mutationClient();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "fail",
      collectTarget: () => Promise.resolve(state()),
      createClient: () => mutation.client,
    });

    const result = await handler.apply({
      action: action(),
      attempt: 1,
    });

    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    expect(mutation.statements).toEqual([
      "BEGIN",
      `CREATE PUBLICATION "supabase_realtime" WITH (publish = 'insert,delete')`,
      `ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."events" ("id", "created_at") WHERE (id > 10)`,
      `ALTER PUBLICATION "supabase_realtime" OWNER TO "reporting""owner"`,
      "COMMIT",
    ]);
  });

  it("creates FOR ALL TABLES publications when that mode is backed up", async () => {
    const source = state([
      publication({
        name: "all_tables",
        allTables: true,
        publish: {
          insert: true,
          update: true,
          delete: false,
          truncate: false,
        },
      }),
    ]);

    const root = await bundle(source);
    const mutation = mutationClient();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: () => Promise.resolve(state()),
      createClient: () => mutation.client,
    });

    await handler.apply({
      action: action(),
      attempt: 1,
    });

    expect(mutation.statements).toContain(
      `CREATE PUBLICATION "all_tables" FOR ALL TABLES WITH (publish = 'insert,update')`,
    );
  });

  it("drops target-only publications under replace policy", async () => {
    const source = state();
    const target = state([
      publication({
        name: "target_only",
      }),
    ]);

    const root = await bundle(source);
    const mutation = mutationClient();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: () => Promise.resolve(target),
      createClient: () => mutation.client,
    });

    await handler.apply({
      action: action(),
      attempt: 1,
    });

    expect(mutation.statements).toEqual([
      "BEGIN",
      `DROP PUBLICATION "target_only"`,
      "COMMIT",
    ]);
  });

  it("replaces a publication when all-tables mode conflicts", async () => {
    const source = state([
      publication({
        allTables: true,
      }),
    ]);

    const target = state([
      publication({
        allTables: false,
      }),
    ]);

    const root = await bundle(source);
    const mutation = mutationClient();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: () => Promise.resolve(target),
      createClient: () => mutation.client,
    });

    await handler.apply({
      action: action(),
      attempt: 1,
    });

    expect(mutation.statements).toContain(
      `DROP PUBLICATION "supabase_realtime"`,
    );
    expect(mutation.statements).toContain(
      `CREATE PUBLICATION "supabase_realtime" FOR ALL TABLES WITH (publish = 'insert,update,delete,truncate')`,
    );
  });

  it("fails before mutation when all-tables mode conflicts under fail policy", async () => {
    const source = state([
      publication({
        allTables: true,
      }),
    ]);

    const target = state([
      publication({
        allTables: false,
      }),
    ]);

    const root = await bundle(source);
    const createClient = vi.fn();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "fail",
      collectTarget: () => Promise.resolve(target),
      createClient,
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_TARGET_CONFLICT",
      component: "database.publications",
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  it("updates owner and replaces a changed table definition", async () => {
    const source = state(
      [
        publication({
          owner: "source_owner",
        }),
      ],
      [
        table({
          columns: ["id"],
          rowFilter: "id > 0",
        }),
      ],
    );

    const target = state(
      [
        publication({
          owner: "target_owner",
        }),
      ],
      [
        table({
          columns: null,
          rowFilter: null,
        }),
      ],
    );

    const root = await bundle(source);
    const mutation = mutationClient();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: () => Promise.resolve(target),
      createClient: () => mutation.client,
    });

    await handler.apply({
      action: action(),
      attempt: 1,
    });

    expect(mutation.statements).toContain(
      `ALTER PUBLICATION "supabase_realtime" OWNER TO "source_owner"`,
    );
    expect(mutation.statements).toContain(
      `ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."events"`,
    );
    expect(mutation.statements).toContain(
      `ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."events" ("id") WHERE (id > 0)`,
    );
  });

  it("rejects the wrong artifact before target inspection", async () => {
    const root = await bundle(state([publication()]));

    const collectTarget = vi.fn();

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget,
    });

    await expect(
      handler.apply({
        action: action(["database/not-catalog-state.json"]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.publications",
    });

    expect(collectTarget).not.toHaveBeenCalled();
  });

  it("rejects malformed and non-regular catalog artifacts", async () => {
    const malformedRoot = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-publication-hardening-"),
    );
    temporaryDirectories.push(malformedRoot);

    await mkdir(path.join(malformedRoot, "database"), {
      recursive: true,
    });
    await writeFile(
      path.join(malformedRoot, "database", "catalog-state.json"),
      "{",
    );

    const malformedHandler = createPublicationRestoreHandler({
      bundleRoot: malformedRoot,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: vi.fn(),
    });

    await expect(
      malformedHandler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.publications",
    });

    const directoryRoot = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-publication-hardening-"),
    );
    temporaryDirectories.push(directoryRoot);

    await mkdir(path.join(directoryRoot, "database", "catalog-state.json"), {
      recursive: true,
    });

    const directoryHandler = createPublicationRestoreHandler({
      bundleRoot: directoryRoot,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: vi.fn(),
    });

    await expect(
      directoryHandler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.publications",
    });
  });

  it("rolls back and closes the client when a publication mutation fails", async () => {
    const source = state([
      publication({
        name: "source_only",
      }),
    ]);

    const root = await bundle(source);

    const mutation = mutationClient({
      failOn: (sql) => sql.startsWith("CREATE PUBLICATION"),
    });

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget: () => Promise.resolve(state()),
      createClient: () => mutation.client,
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_PUBLICATION_RESTORE_FAILED",
      component: "database.publications",
    });

    expect(mutation.statements).toContain("ROLLBACK");
    expect(mutation.statements).not.toContain("COMMIT");
    expect(mutation.end).toHaveBeenCalledOnce();
  });

  it("short-circuits verification when the supplied fingerprint is wrong", async () => {
    const source = state([publication()]);

    const root = await bundle(source);
    const collectTarget = vi.fn(() => Promise.resolve(source));

    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "replace",
      collectTarget,
    });

    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);

    expect(collectTarget).not.toHaveBeenCalled();
  });
});
