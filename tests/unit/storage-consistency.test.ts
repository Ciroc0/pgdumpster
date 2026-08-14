import { lstat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  collectFileStorageConsistencySnapshot,
  collectLinkedFileStorageConsistencySnapshot,
  fileStorageConsistencySnapshotsEqual,
  storageObjectEtag,
  type FileStorageConsistencySnapshot,
} from "../../src/storage/consistency.js";
import type { FileStorageCatalog } from "../../src/storage/catalog.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const catalog: FileStorageCatalog = {
  schemaVersion: 1,
  buckets: [
    {
      id: "files",
      name: "files",
      public: false,
      type: "STANDARD",
      fileSizeLimit: null,
      allowedMimeTypes: null,
      createdAt: "2026-08-15T00:00:00Z",
      updatedAt: "2026-08-15T00:00:00Z",
    },
  ],
  objects: [
    {
      id: "one",
      bucket: "files",
      name: "one.txt",
      owner: null,
      ownerId: null,
      version: "version-1",
      createdAt: "2026-08-15T00:00:00Z",
      updatedAt: "2026-08-15T00:00:00Z",
      lastAccessedAt: "2026-08-15T00:00:00Z",
      expectedBytes: 3,
      metadata: { size: 3, eTag: '"etag-1"' },
      userMetadata: { purpose: "test" },
    },
  ],
};

function snapshot(
  catalogOverride: FileStorageCatalog = catalog,
): FileStorageConsistencySnapshot {
  return { schemaVersion: 1, catalog: catalogOverride };
}

function databaseUrl(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:secret@example.invalid/postgres",
    new Redactor(),
  );
}

describe("File Storage consistency snapshots", () => {
  it("ignores last-access timestamps caused by pgDumpster reads", () => {
    const changed: FileStorageCatalog = {
      ...catalog,
      objects: catalog.objects.map((object) => ({
        ...object,
        lastAccessedAt: "2026-08-15T00:05:00Z",
      })),
    };

    expect(
      fileStorageConsistencySnapshotsEqual(snapshot(), snapshot(changed)),
    ).toBe(true);
  });

  it("detects bucket, object metadata and version drift", () => {
    const bucketChanged: FileStorageCatalog = {
      ...catalog,
      buckets: catalog.buckets.map((bucket) => ({ ...bucket, public: true })),
    };
    const objectChanged: FileStorageCatalog = {
      ...catalog,
      objects: catalog.objects.map((object) => ({
        ...object,
        version: "version-2",
        expectedBytes: 4,
        metadata: { size: 4, eTag: '"etag-2"' },
      })),
    };

    expect(
      fileStorageConsistencySnapshotsEqual(snapshot(), snapshot(bucketChanged)),
    ).toBe(false);
    expect(
      fileStorageConsistencySnapshotsEqual(snapshot(), snapshot(objectChanged)),
    ).toBe(false);
  });

  it("detects object creation and deletion", () => {
    expect(
      fileStorageConsistencySnapshotsEqual(
        snapshot(),
        snapshot({ ...catalog, objects: [] }),
      ),
    ).toBe(false);
  });

  it("extracts the strongest available Storage etag spelling", () => {
    expect(storageObjectEtag({ eTag: '"primary"', etag: "secondary" })).toBe(
      '"primary"',
    );
    expect(storageObjectEtag({ etag: " secondary " })).toBe("secondary");
    expect(storageObjectEtag({ ETag: "third" })).toBe("third");
    expect(storageObjectEtag({ eTag: 123 })).toBeUndefined();
    expect(storageObjectEtag(null)).toBeUndefined();
  });

  it("collects direct snapshots in disposable storage and removes it", async () => {
    let temporaryRoot: string | undefined;
    const collected = await collectFileStorageConsistencySnapshot(
      databaseUrl(),
      undefined,
      {
        collectCatalog: (root) => {
          temporaryRoot = root;
          return Promise.resolve(catalog);
        },
      },
    );

    expect(collected).toEqual(snapshot());
    expect(temporaryRoot).toBeDefined();
    await expect(lstat(temporaryRoot!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("collects linked snapshots through the same disposable contract", async () => {
    let temporaryRoot: string | undefined;
    const collected = await collectLinkedFileStorageConsistencySnapshot(
      undefined,
      {
        collectCatalog: (root) => {
          temporaryRoot = root;
          return Promise.resolve(catalog);
        },
      },
    );

    expect(collected.catalog.objects).toHaveLength(1);
    expect(temporaryRoot).toBeDefined();
    await expect(lstat(temporaryRoot!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("wraps inventory failures and preserves cancellation semantics", async () => {
    await expect(
      collectFileStorageConsistencySnapshot(databaseUrl(), undefined, {
        collectCatalog: () => Promise.reject(new Error("catalog failed")),
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      component: "storage.file_objects",
    });

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      collectLinkedFileStorageConsistencySnapshot(controller.signal, {
        collectCatalog: () => Promise.resolve(catalog),
      }),
    ).rejects.toThrow("stop");
  });
});
