import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/database/consistency.js", () => ({
  collectDatabaseConsistencySnapshot: vi.fn(),
  collectLinkedDatabaseConsistencySnapshot: vi.fn(),
  databaseConsistencySnapshotsEqual: vi.fn(),
}));

import { createDatabaseConsistencyAdapter } from "../../src/core/backup/database-consistency-adapter.js";
import {
  collectDatabaseConsistencySnapshot,
  collectLinkedDatabaseConsistencySnapshot,
  databaseConsistencySnapshotsEqual,
  type DatabaseConsistencySnapshot,
} from "../../src/database/consistency.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

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

function databaseUrl(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:secret@example.invalid/postgres",
    new Redactor(),
  );
}

function snapshotFixture(): DatabaseConsistencySnapshot {
  return {
    schemaVersion: 1,
    inventory: {
      schemaVersion: 1,
      extensions: [],
      schemas: [],
      unclassifiedPersistentSchemas: [],
    },
    catalog: {
      schemaVersion: 1,
      publications: [],
      publicationTables: [],
      webhooks: [],
    },
    mutation: {
      marker: {
        txidXmin: "1",
        txidXmax: "2",
        walLsn: "0/1",
        statsReset: null,
      },
      tables: [],
      sequences: [],
    },
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-db-consistency-adapter-"),
  );
  temporaryDirectories.push(root);
  return root;
}

describe("database backup consistency adapter", () => {
  it("collects direct snapshots with the configured database secret and signal", async () => {
    const direct = databaseUrl();
    const expected = snapshotFixture();
    const controller = new AbortController();
    vi.mocked(collectDatabaseConsistencySnapshot).mockResolvedValue(expected);

    const adapter = createDatabaseConsistencyAdapter({ databaseUrl: direct });

    await expect(
      adapter.snapshot({
        workspaceRoot: "unused",
        signal: controller.signal,
      }),
    ).resolves.toBe(expected);
    expect(collectDatabaseConsistencySnapshot).toHaveBeenCalledWith(
      direct,
      controller.signal,
    );
    expect(collectLinkedDatabaseConsistencySnapshot).not.toHaveBeenCalled();
  });

  it("collects linked snapshots without a persistent database secret", async () => {
    const expected = snapshotFixture();
    const controller = new AbortController();
    vi.mocked(collectLinkedDatabaseConsistencySnapshot).mockResolvedValue(
      expected,
    );

    const adapter = createDatabaseConsistencyAdapter({ linked: true });

    await expect(
      adapter.snapshot({
        workspaceRoot: "unused",
        signal: controller.signal,
      }),
    ).resolves.toBe(expected);
    expect(collectLinkedDatabaseConsistencySnapshot).toHaveBeenCalledWith(
      controller.signal,
    );
    expect(collectDatabaseConsistencySnapshot).not.toHaveBeenCalled();
  });

  it("delegates canonical equality to the database snapshot comparator", () => {
    const before = snapshotFixture();
    const after = snapshotFixture();
    vi.mocked(databaseConsistencySnapshotsEqual).mockReturnValue(true);
    const adapter = createDatabaseConsistencyAdapter({ linked: true });

    expect(adapter.equals?.(before, after)).toBe(true);
    expect(databaseConsistencySnapshotsEqual).toHaveBeenCalledWith(
      before,
      after,
    );
  });

  it("removes only returned database artifacts during a drift retry", async () => {
    const root = await workspace();
    const databaseDirectory = path.join(root, "database");
    await mkdir(databaseDirectory, { recursive: true });
    const metadata = path.join(databaseDirectory, "metadata.json");
    const roles = path.join(databaseDirectory, "roles.sql");
    const unrelated = path.join(root, "keep.txt");
    await writeFile(metadata, "metadata");
    await writeFile(roles, "roles");
    await writeFile(unrelated, "keep");

    const adapter = createDatabaseConsistencyAdapter({ linked: true });
    await adapter.cleanup(
      {
        artifacts: [
          "database/metadata.json",
          "database/roles.sql",
          "database/metadata.json",
        ],
        coverage: [],
      },
      { workspaceRoot: root },
    );

    await expect(access(metadata)).rejects.toThrow();
    await expect(access(roles)).rejects.toThrow();
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
  });

  it("validates the complete cleanup scope before deleting any artifact", async () => {
    const root = await workspace();
    const databaseDirectory = path.join(root, "database");
    const secretsDirectory = path.join(root, "secrets");
    await mkdir(databaseDirectory, { recursive: true });
    await mkdir(secretsDirectory, { recursive: true });
    const metadata = path.join(databaseDirectory, "metadata.json");
    await writeFile(metadata, "metadata");
    await writeFile(path.join(secretsDirectory, "other.json"), "secret");

    const adapter = createDatabaseConsistencyAdapter({ linked: true });
    await expect(
      adapter.cleanup(
        {
          artifacts: ["database/metadata.json", "secrets/other.json"],
          coverage: [],
        },
        { workspaceRoot: root },
      ),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
    });

    await expect(readFile(metadata, "utf8")).resolves.toBe("metadata");
  });

  it("honors cancellation before removing retry artifacts", async () => {
    const root = await workspace();
    const databaseDirectory = path.join(root, "database");
    await mkdir(databaseDirectory, { recursive: true });
    const metadata = path.join(databaseDirectory, "metadata.json");
    await writeFile(metadata, "metadata");
    const controller = new AbortController();
    const reason = new Error("cancel cleanup");
    controller.abort(reason);

    const adapter = createDatabaseConsistencyAdapter({ linked: true });
    await expect(
      adapter.cleanup(
        {
          artifacts: ["database/metadata.json"],
          coverage: [],
        },
        { workspaceRoot: root, signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    await expect(readFile(metadata, "utf8")).resolves.toBe("metadata");
  });

  it("fails closed when database source selection is ambiguous", () => {
    expect(() => createDatabaseConsistencyAdapter({})).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() =>
      createDatabaseConsistencyAdapter({ databaseUrl: databaseUrl(), linked: true }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
