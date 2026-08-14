import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabaseCatalogState } from "../../src/database/catalog-state.js";
import { createPublicationRestoreHandler } from "../../src/core/restore/publication-handler.js";
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

const sourceState = (): DatabaseCatalogState => ({
  schemaVersion: 1,
  publications: [
    {
      name: "supabase_realtime",
      owner: "postgres",
      allTables: false,
      publish: { insert: true, update: true, delete: true, truncate: true },
    },
  ],
  publicationTables: [],
  webhooks: [],
});

async function bundle(state: DatabaseCatalogState): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-publication-restore-"),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "database"));
  await writeFile(
    path.join(root, "database", "catalog-state.json"),
    JSON.stringify(state),
  );
  return root;
}

function action(): RestoreAction {
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
    artifacts: ["database/catalog-state.json"],
  };
}

const targetDatabaseUrl = new SecretValue(
  "postgresql://postgres:secret@db.example.invalid/postgres",
  new Redactor(),
);

describe("publication restore", () => {
  it("is a verified no-op when source and target already match", async () => {
    const source = sourceState();
    const root = await bundle(source);
    const createClient = vi.fn();
    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "fail",
      collectTarget: () => Promise.resolve(source),
      createClient,
    });

    const applied = await handler.apply({ action: action(), attempt: 1 });
    expect(createClient).not.toHaveBeenCalled();
    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("reconciles publication settings and table membership transactionally", async () => {
    const source = sourceState();
    source.publicationTables.push({
      publication: "supabase_realtime",
      schema: "public",
      table: "events",
      columns: ["id"],
      rowFilter: "id > 0",
    });
    const target = sourceState();
    target.publications[0]!.publish.update = false;
    target.publicationTables.push({
      publication: "supabase_realtime",
      schema: "public",
      table: "old_events",
      columns: null,
      rowFilter: null,
    });
    const root = await bundle(source);
    const states = [target, source];
    const statements: string[] = [];
    const handler = createPublicationRestoreHandler({
      bundleRoot: root,
      targetDatabaseUrl,
      conflictPolicy: "fail",
      collectTarget: () => Promise.resolve(states.shift()!),
      createClient: () => ({
        connect: () => Promise.resolve(),
        query: (sql) => {
          statements.push(sql);
          return Promise.resolve();
        },
        end: () => Promise.resolve(),
      }),
    });

    const applied = await handler.apply({ action: action(), attempt: 1 });
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain(
      "ALTER PUBLICATION \"supabase_realtime\" SET (publish = 'insert,update,delete,truncate')",
    );
    expect(statements).toContain(
      'ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."old_events"',
    );
    expect(statements).toContain(
      'ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."events" ("id") WHERE (id > 0)',
    );
    expect(statements.at(-1)).toBe("COMMIT");
    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("fails before mutation when fail policy finds an extra target publication", async () => {
    const source = sourceState();
    const target = sourceState();
    target.publications.push({
      name: "target_only",
      owner: "postgres",
      allTables: false,
      publish: { insert: true, update: true, delete: true, truncate: true },
    });
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
      handler.apply({ action: action(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(createClient).not.toHaveBeenCalled();
  });
});
