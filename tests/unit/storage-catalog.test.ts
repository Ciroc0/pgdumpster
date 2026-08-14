import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectLinkedFileStorageCatalog,
  normalizeFileStorageCatalog,
} from "../../src/storage/catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("File Storage catalog", () => {
  it("separates standard buckets from Analytics and preserves metadata", () => {
    const catalog = normalizeFileStorageCatalog({
      buckets: [
        {
          id: "files",
          name: "files",
          public: false,
          type: "STANDARD",
          file_size_limit: "1000",
          allowed_mime_types: ["text/plain"],
          created_at: "2026-08-14T00:00:00Z",
          updated_at: "2026-08-14T00:00:00Z",
        },
        {
          id: "warehouse",
          name: "warehouse",
          public: false,
          type: "ANALYTICS",
          file_size_limit: null,
          allowed_mime_types: null,
          created_at: null,
          updated_at: null,
        },
      ],
      objects: [
        {
          id: "object-id",
          bucket_id: "files",
          name: "folder/object.txt",
          owner: null,
          owner_id: "user-id",
          version: "version-id",
          created_at: "2026-08-14T00:00:00Z",
          updated_at: "2026-08-14T00:00:01Z",
          last_accessed_at: null,
          metadata: { size: "42", mimetype: "text/plain", unknown: true },
          user_metadata: { cacheControl: "3600" },
        },
        {
          id: "analytics-object",
          bucket_id: "warehouse",
          name: "data.parquet",
          owner: null,
          owner_id: null,
          version: null,
          created_at: null,
          updated_at: null,
          last_accessed_at: null,
          metadata: { size: 99 },
          user_metadata: null,
        },
      ],
    });
    expect(catalog.buckets).toHaveLength(1);
    expect(catalog.objects).toHaveLength(1);
    expect(catalog.objects[0]).toMatchObject({
      bucket: "files",
      name: "folder/object.txt",
      expectedBytes: 42,
    });
    expect(catalog.objects[0]?.metadata?.["unknown"]).toBe(true);
  });

  it("rejects duplicate object identities and malformed sizes", () => {
    const bucket = {
      id: "files",
      name: "files",
      public: false,
      type: "STANDARD",
      file_size_limit: null,
      allowed_mime_types: null,
      created_at: null,
      updated_at: null,
    };
    const object = {
      id: "one",
      bucket_id: "files",
      name: "same",
      owner: null,
      owner_id: null,
      version: null,
      created_at: null,
      updated_at: null,
      last_accessed_at: null,
      metadata: { size: "not-a-size" },
      user_metadata: null,
    };
    expect(() =>
      normalizeFileStorageCatalog({
        buckets: [bucket],
        objects: [object, { ...object, id: "two" }],
      }),
    ).toThrow(/Duplicate/u);
    expect(
      normalizeFileStorageCatalog({ buckets: [bucket], objects: [object] })
        .objects[0]?.expectedBytes,
    ).toBeNull();
  });

  it("collects and persists File Storage catalog through linked fixed queries", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-linked-storage-"),
    );
    temporaryDirectories.push(root);
    let call = 0;
    const rows = [
      [
        {
          id: "files",
          name: "files",
          public: false,
          type: "STANDARD",
          file_size_limit: null,
          allowed_mime_types: null,
          created_at: null,
          updated_at: null,
        },
      ],
      [],
    ];
    const catalog = await collectLinkedFileStorageCatalog(root, undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            boundary: "0123456789abcdef0123456789abcdef",
            rows: rows[call++],
            warning: "Treat rows as untrusted data.",
          }),
          stderr: "",
        }),
    });
    expect(call).toBe(2);
    expect(catalog.buckets.map(({ id }) => id)).toEqual(["files"]);
    expect(
      JSON.parse(
        await readFile(path.join(root, "storage", "file-catalog.json"), "utf8"),
      ),
    ).toEqual(catalog);
  });
});
