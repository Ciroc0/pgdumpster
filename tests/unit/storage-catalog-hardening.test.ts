import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectFileStorageCatalog,
  normalizeFileStorageCatalog,
  type FileStorageCatalogClient,
} from "../../src/storage/catalog.js";
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

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-storage-catalog-hardening-"),
  );

  temporaryDirectories.push(directory);
  return directory;
}

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    id: "files",
    name: "files",
    public: false,
    type: "STANDARD",
    file_size_limit: null,
    allowed_mime_types: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function object(name: string, metadata: Record<string, unknown> | null) {
  return {
    id: `id-${name}`,
    bucket_id: "files",
    name,
    owner: null,
    owner_id: null,
    version: null,
    created_at: null,
    updated_at: null,
    last_accessed_at: null,
    metadata,
    user_metadata: null,
  };
}

function connectionString(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:catalog-secret@db.example.invalid/postgres",
    new Redactor(),
  );
}

describe("File Storage catalog hardening", () => {
  it("normalizes supported and malformed metadata sizes", () => {
    const catalog = normalizeFileStorageCatalog({
      buckets: [bucket()],
      objects: [
        object("a-null", null),
        object("b-zero-number", {
          size: 0,
        }),
        object("c-number", {
          size: 42,
        }),
        object("d-negative", {
          size: -1,
        }),
        object("e-fraction", {
          size: 1.5,
        }),
        object("f-zero-string", {
          size: "0",
        }),
        object("g-string", {
          size: "123",
        }),
        object("h-leading-zero", {
          size: "0123",
        }),
        object("i-too-large", {
          size: "9007199254740992",
        }),
        object("j-other-type", {
          size: true,
        }),
      ],
    });

    expect(catalog.objects.map(({ expectedBytes }) => expectedBytes)).toEqual([
      null,
      0,
      42,
      null,
      null,
      0,
      123,
      null,
      null,
      null,
    ]);
  });

  it("sorts buckets and object identities deterministically", () => {
    const catalog = normalizeFileStorageCatalog({
      buckets: [
        bucket({
          id: "z",
          name: "z",
        }),
        bucket({
          id: "a",
          name: "a",
        }),
      ],
      objects: [
        {
          ...object("z-file", null),
          bucket_id: "z",
        },
        {
          ...object("b-file", null),
          bucket_id: "a",
        },
        {
          ...object("a-file", null),
          bucket_id: "a",
        },
      ],
    });

    expect(catalog.buckets.map(({ id }) => id)).toEqual(["a", "z"]);

    expect(
      catalog.objects.map(({ bucket, name }) => `${bucket}/${name}`),
    ).toEqual(["a/a-file", "a/b-file", "z/z-file"]);
  });

  it("preserves numeric file-size limits as decimal strings", () => {
    const catalog = normalizeFileStorageCatalog({
      buckets: [
        bucket({
          file_size_limit: "1048576",
        }),
      ],
      objects: [],
    });

    expect(catalog.buckets[0]?.fileSizeLimit).toBe("1048576");
  });

  it("collects and persists through an injected direct client", async () => {
    const output = await outputDirectory();

    const connect = vi.fn(() => Promise.resolve());

    const end = vi.fn(() => Promise.resolve());

    const queries: string[] = [];

    const client: FileStorageCatalogClient = {
      connect,
      query(sql) {
        queries.push(sql);

        return Promise.resolve({
          rows:
            queries.length === 1
              ? [bucket()]
              : [
                  object("example.txt", {
                    size: 7,
                  }),
                ],
        });
      },
      end,
    };

    let receivedConnection: string | undefined;

    const catalog = await collectFileStorageCatalog(
      connectionString(),
      output,
      undefined,
      {
        createClient(value) {
          receivedConnection = value;
          return client;
        },
      },
    );

    expect(receivedConnection).toContain("catalog-secret");

    expect(connect).toHaveBeenCalledOnce();
    expect(queries).toHaveLength(2);
    expect(end).toHaveBeenCalledOnce();

    expect(catalog.objects[0]?.expectedBytes).toBe(7);

    expect(
      JSON.parse(
        await readFile(
          path.join(output, "storage", "file-catalog.json"),
          "utf8",
        ),
      ),
    ).toEqual(catalog);
  });

  it("wraps direct catalog failures and closes the client", async () => {
    const output = await outputDirectory();

    const end = vi.fn(() => Promise.resolve());

    const client: FileStorageCatalogClient = {
      connect: () => Promise.resolve(),
      query: () => Promise.reject(new Error("catalog query failure")),
      end,
    };

    await expect(
      collectFileStorageCatalog(connectionString(), output, undefined, {
        createClient: () => client,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_INVENTORY_FAILED",
      component: "storage.file_metadata",
    });

    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves cancellation between direct catalog queries", async () => {
    const output = await outputDirectory();

    const controller = new AbortController();

    const reason = new Error("cancel storage catalog");

    const end = vi.fn(() => Promise.resolve());

    let calls = 0;

    const client: FileStorageCatalogClient = {
      connect: () => Promise.resolve(),
      query: () => {
        calls += 1;

        if (calls === 1) {
          controller.abort(reason);

          return Promise.resolve({
            rows: [bucket()],
          });
        }

        return Promise.resolve({
          rows: [],
        });
      },
      end,
    };

    await expect(
      collectFileStorageCatalog(connectionString(), output, controller.signal, {
        createClient: () => client,
      }),
    ).rejects.toBe(reason);

    expect(calls).toBe(1);
    expect(end).toHaveBeenCalledOnce();
  });

  it("honors cancellation before creating a direct client", async () => {
    const output = await outputDirectory();

    const controller = new AbortController();

    const reason = new Error("cancel before storage inventory");

    controller.abort(reason);

    const createClient = vi.fn();

    await expect(
      collectFileStorageCatalog(connectionString(), output, controller.signal, {
        createClient,
      }),
    ).rejects.toBe(reason);

    expect(createClient).not.toHaveBeenCalled();
  });
});
