import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/storage/consistency.js", () => ({
  collectFileStorageConsistencySnapshot: vi.fn(),
  collectLinkedFileStorageConsistencySnapshot: vi.fn(),
  fileStorageConsistencySnapshotsEqual: vi.fn(),
}));

import { createFileStorageConsistencyAdapter } from "../../src/core/backup/file-storage-consistency-adapter.js";
import {
  collectFileStorageConsistencySnapshot,
  collectLinkedFileStorageConsistencySnapshot,
  fileStorageConsistencySnapshotsEqual,
  type FileStorageConsistencySnapshot,
} from "../../src/storage/consistency.js";
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

function snapshotFixture(): FileStorageConsistencySnapshot {
  return {
    schemaVersion: 1,
    catalog: { schemaVersion: 1, buckets: [], objects: [] },
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-storage-consistency-adapter-"),
  );
  temporaryDirectories.push(root);
  return root;
}

describe("File Storage backup consistency adapter", () => {
  it("collects direct snapshots with the configured database secret and signal", async () => {
    const direct = databaseUrl();
    const expected = snapshotFixture();
    const controller = new AbortController();
    vi.mocked(collectFileStorageConsistencySnapshot).mockResolvedValue(expected);

    const adapter = createFileStorageConsistencyAdapter({ databaseUrl: direct });

    await expect(
      adapter.snapshot({
        workspaceRoot: "unused",
        signal: controller.signal,
      }),
    ).resolves.toBe(expected);
    expect(collectFileStorageConsistencySnapshot).toHaveBeenCalledWith(
      direct,
      controller.signal,
    );
    expect(collectLinkedFileStorageConsistencySnapshot).not.toHaveBeenCalled();
  });

  it("collects linked snapshots without a persistent database secret", async () => {
    const expected = snapshotFixture();
    const controller = new AbortController();
    vi.mocked(collectLinkedFileStorageConsistencySnapshot).mockResolvedValue(
      expected,
    );

    const adapter = createFileStorageConsistencyAdapter({ linked: true });

    await expect(
      adapter.snapshot({
        workspaceRoot: "unused",
        signal: controller.signal,
      }),
    ).resolves.toBe(expected);
    expect(collectLinkedFileStorageConsistencySnapshot).toHaveBeenCalledWith(
      controller.signal,
    );
    expect(collectFileStorageConsistencySnapshot).not.toHaveBeenCalled();
  });

  it("delegates canonical equality to the File Storage comparator", () => {
    const before = snapshotFixture();
    const after = snapshotFixture();
    vi.mocked(fileStorageConsistencySnapshotsEqual).mockReturnValue(true);
    const adapter = createFileStorageConsistencyAdapter({ linked: true });

    expect(adapter.equals?.(before, after)).toBe(true);
    expect(fileStorageConsistencySnapshotsEqual).toHaveBeenCalledWith(
      before,
      after,
    );
  });

  it("removes provisional File Storage artifacts but preserves the shared database dump", async () => {
    const root = await workspace();
    const catalog = path.join(root, "storage", "file-catalog.json");
    const object = path.join(root, "storage", "file-objects", "aa", "object");
    const index = path.join(
      root,
      "secrets",
      "storage",
      "file-object-index.json",
    );
    const shared = path.join(root, "database", "storage-metadata.sql");
    await mkdir(path.dirname(catalog), { recursive: true });
    await mkdir(path.dirname(object), { recursive: true });
    await mkdir(path.dirname(index), { recursive: true });
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(catalog, "catalog");
    await writeFile(object, "bytes");
    await writeFile(index, "index");
    await writeFile(shared, "database dump");

    const adapter = createFileStorageConsistencyAdapter({ linked: true });
    await adapter.cleanup(
      {
        artifacts: [
          "storage/file-catalog.json",
          "storage/file-objects/aa/object",
          "secrets/storage/file-object-index.json",
          "database/storage-metadata.sql",
          "storage/file-catalog.json",
        ],
        coverage: [],
      },
      { workspaceRoot: root },
    );

    await expect(access(catalog)).rejects.toThrow();
    await expect(access(object)).rejects.toThrow();
    await expect(access(index)).rejects.toThrow();
    await expect(readFile(shared, "utf8")).resolves.toBe("database dump");
  });

  it("validates the complete cleanup scope before deleting any artifact", async () => {
    const root = await workspace();
    const catalog = path.join(root, "storage", "file-catalog.json");
    const foreign = path.join(root, "secrets", "other.json");
    await mkdir(path.dirname(catalog), { recursive: true });
    await mkdir(path.dirname(foreign), { recursive: true });
    await writeFile(catalog, "catalog");
    await writeFile(foreign, "secret");

    const adapter = createFileStorageConsistencyAdapter({ linked: true });
    await expect(
      adapter.cleanup(
        {
          artifacts: ["storage/file-catalog.json", "secrets/other.json"],
          coverage: [],
        },
        { workspaceRoot: root },
      ),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
    });

    await expect(readFile(catalog, "utf8")).resolves.toBe("catalog");
  });

  it("honors cancellation before removing retry artifacts", async () => {
    const root = await workspace();
    const catalog = path.join(root, "storage", "file-catalog.json");
    await mkdir(path.dirname(catalog), { recursive: true });
    await writeFile(catalog, "catalog");
    const controller = new AbortController();
    const reason = new Error("cancel cleanup");
    controller.abort(reason);

    const adapter = createFileStorageConsistencyAdapter({ linked: true });
    await expect(
      adapter.cleanup(
        {
          artifacts: ["storage/file-catalog.json"],
          coverage: [],
        },
        { workspaceRoot: root, signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    await expect(readFile(catalog, "utf8")).resolves.toBe("catalog");
  });

  it("fails closed when catalog source selection is ambiguous", () => {
    expect(() => createFileStorageConsistencyAdapter({})).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() =>
      createFileStorageConsistencyAdapter({
        databaseUrl: databaseUrl(),
        linked: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
