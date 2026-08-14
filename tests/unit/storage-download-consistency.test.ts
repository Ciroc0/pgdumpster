import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { downloadStorageObject } from "../../src/storage/download.js";

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
    path.join(tmpdir(), "pgdumpster-storage-download-consistency-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function storageKey(): SecretValue {
  return new SecretValue("service-role-test-key", new Redactor());
}

describe("File Storage download consistency evidence", () => {
  it("accepts matching catalog and response ETags while hashing bytes", async () => {
    const root = await workspace();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("stable", {
        status: 200,
        headers: { etag: 'W/"etag-1"' },
      }),
    );

    await expect(
      downloadStorageObject(
        {
          bucket: "files",
          name: "stable.txt",
          expectedBytes: 6,
          etag: '"etag-1"',
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
        },
      ),
    ).resolves.toMatchObject({ bytes: 6 });
  });

  it("fails before committing bytes when the response ETag drifted", async () => {
    const root = await workspace();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("changed", {
        status: 200,
        headers: { etag: '"etag-2"' },
      }),
    );

    await expect(
      downloadStorageObject(
        {
          bucket: "files",
          name: "changed.txt",
          expectedBytes: 7,
          etag: '"etag-1"',
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
        },
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_OBJECT_CHANGED_DURING_COPY",
      category: "consistency",
      component: "storage.file_objects",
    });
  });

  it("falls back to byte evidence when Storage omits an ETag", async () => {
    const root = await workspace();

    await expect(
      downloadStorageObject(
        {
          bucket: "files",
          name: "size-drift.txt",
          expectedBytes: 99,
          etag: '"catalog-etag"',
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: () => Promise.resolve(new Response("short", { status: 200 })),
        },
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_OBJECT_CHANGED_DURING_COPY",
      category: "consistency",
    });
  });
});
