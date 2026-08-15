import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RestoreAction } from "../../src/core/restore/plan.js";
import {
  createFileBucketRestoreHandler,
  createFileMetadataRestoreHandler,
  createFileObjectRestoreHandler,
  type FileStorageRestoreDependencies,
  type FileStorageRestoreOptions,
  type StorageMutationClient,
  type StorageObjectEvidence,
  type StorageResult,
  type UploadStorageObjectInput,
} from "../../src/core/restore/file-storage-handlers.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type {
  FileStorageBucket,
  FileStorageCatalog,
  FileStorageObject,
} from "../../src/storage/catalog.js";

const temporaryDirectories: string[] = [];

interface BundleFixture {
  root: string;
  payload: Buffer;
  catalog: FileStorageCatalog;
  indexArtifact: string;
  objectArtifact: string;
  objectSha256: string;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function objectIdentity(bucket: string, name: string): string {
  return `${bucket}\0${name}`;
}

function objectContentId(bucket: string, name: string): string {
  return createHash("sha256")
    .update(bucket)
    .update("\0")
    .update(name)
    .digest("hex");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function bucket(
  id: string,
  overrides: Partial<FileStorageBucket> = {},
): FileStorageBucket {
  return {
    id,
    name: id,
    public: false,
    type: "STANDARD",
    fileSizeLimit: "10485760",
    allowedMimeTypes: ["text/plain"],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function object(
  id: string,
  bucketId: string,
  name: string,
  bytes: number,
  overrides: Partial<FileStorageObject> = {},
): FileStorageObject {
  return {
    id,
    bucket: bucketId,
    name,
    owner: null,
    ownerId: null,
    version: null,
    createdAt: null,
    updatedAt: null,
    lastAccessedAt: null,
    expectedBytes: bytes,
    metadata: {
      size: bytes,
      mimetype: "text/plain",
      cacheControl: "3600",
    },
    userMetadata: { fixture: "source" },
    ...overrides,
  };
}

async function createBundle(
  payload = Buffer.from("hello storage", "utf8"),
): Promise<BundleFixture> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-storage-restore-"),
  );
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "database"), { recursive: true });
  await mkdir(path.join(root, "secrets", "storage"), { recursive: true });

  const bucketId = "assets";
  const name = "folder/example.txt";
  const id = objectContentId(bucketId, name);
  const objectArtifact = `storage/file-objects/${id.slice(0, 2)}/${id}`;
  await mkdir(path.dirname(path.join(root, ...objectArtifact.split("/"))), {
    recursive: true,
  });
  await writeFile(path.join(root, ...objectArtifact.split("/")), payload);

  const catalog: FileStorageCatalog = {
    schemaVersion: 1,
    buckets: [bucket(bucketId)],
    objects: [object("source-object-id", bucketId, name, payload.length)],
  };
  await writeFile(
    path.join(root, "storage", "file-catalog.json"),
    JSON.stringify(catalog),
  );
  await writeFile(
    path.join(root, "database", "storage-metadata.sql"),
    "-- retained source evidence; restore uses upload + semantic compare\n",
  );

  const indexArtifact = "secrets/storage/file-object-index.json";
  const objectSha256 = sha256(payload);
  await writeFile(
    path.join(root, ...indexArtifact.split("/")),
    JSON.stringify({
      schemaVersion: 1,
      objects: [
        {
          bucket: bucketId,
          name,
          contentId: id,
          path: objectArtifact,
          sha256: objectSha256,
          bytes: payload.length,
          version: null,
          updatedAt: null,
        },
      ],
    }),
  );
  return {
    root,
    payload,
    catalog,
    indexArtifact,
    objectArtifact,
    objectSha256,
  };
}

function action(
  component:
    "storage.file_buckets" | "storage.file_objects" | "storage.file_metadata",
  artifacts: string[],
): RestoreAction {
  const phase = component === "storage.file_buckets" ? 10 : 11;
  return {
    id: `restore.${component}`,
    component,
    phase,
    operation:
      component === "storage.file_buckets"
        ? "create_or_update_file_buckets"
        : component === "storage.file_objects"
          ? "stream_file_objects"
          : "apply_file_metadata",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "restore",
    fidelity: component === "storage.file_objects" ? "exact" : "semantic",
    artifacts,
  };
}

function cloneCatalog(catalog: FileStorageCatalog): FileStorageCatalog {
  return structuredClone(catalog);
}

function success(): StorageResult {
  return { data: {}, error: null };
}

function mutationClient(
  target: FileStorageCatalog,
  evidence = new Map<string, StorageObjectEvidence>(),
): StorageMutationClient {
  const createBucket = vi.fn<StorageMutationClient["createBucket"]>(
    (id, options) => {
      target.buckets.push(
        bucket(id, {
          public: options.public,
          fileSizeLimit: options.fileSizeLimit,
          allowedMimeTypes: options.allowedMimeTypes,
        }),
      );
      return Promise.resolve(success());
    },
  );
  const updateBucket = vi.fn<StorageMutationClient["updateBucket"]>(
    (id, options) => {
      const current = target.buckets.find((entry) => entry.id === id);
      if (current !== undefined) {
        current.public = options.public;
        current.fileSizeLimit = options.fileSizeLimit;
        current.allowedMimeTypes = options.allowedMimeTypes;
      }
      return Promise.resolve(success());
    },
  );
  const emptyBucket = vi.fn<StorageMutationClient["emptyBucket"]>((id) => {
    target.objects = target.objects.filter((entry) => entry.bucket !== id);
    for (const key of [...evidence.keys()]) {
      if (key.startsWith(`${id}\0`)) evidence.delete(key);
    }
    return Promise.resolve(success());
  });
  const deleteBucket = vi.fn<StorageMutationClient["deleteBucket"]>((id) => {
    target.buckets = target.buckets.filter((entry) => entry.id !== id);
    return Promise.resolve(success());
  });
  const from: StorageMutationClient["from"] = (id) => ({
    remove: vi.fn<ReturnType<StorageMutationClient["from"]>["remove"]>(
      (names) => {
        const namesToRemove = new Set(names);
        target.objects = target.objects.filter(
          (entry) => entry.bucket !== id || !namesToRemove.has(entry.name),
        );
        for (const name of names) evidence.delete(objectIdentity(id, name));
        return Promise.resolve(success());
      },
    ),
  });
  return { createBucket, updateBucket, emptyBucket, deleteBucket, from };
}

function restoreOptions(
  fixture: BundleFixture,
  conflictPolicy: "fail" | "replace",
  dependencies: FileStorageRestoreDependencies,
  fetchImpl?: typeof fetch,
): FileStorageRestoreOptions {
  const redactor = new Redactor();
  return {
    bundleRoot: fixture.root,
    targetProjectRef: "zyxwvutsrqponmlkjihg",
    targetDatabaseUrl: new SecretValue(
      "postgresql://postgres:secret@db.example.invalid/postgres",
      redactor,
    ),
    storageKey: new SecretValue("storage-secret", redactor),
    conflictPolicy,
    maxConcurrency: 2,
    dependencies,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  };
}

function objectDependencies(
  target: FileStorageCatalog,
  evidence: Map<string, StorageObjectEvidence>,
): FileStorageRestoreDependencies {
  const client = mutationClient(target, evidence);
  return {
    storageClient: client,
    collectTarget: () => Promise.resolve(target),
    readTargetObject: (bucketId, name) =>
      Promise.resolve(evidence.get(objectIdentity(bucketId, name))),
    uploadObject: vi.fn(async (input: UploadStorageObjectInput) => {
      const payload = await readFile(input.sourcePath);
      const key = objectIdentity(input.bucket, input.name);
      evidence.set(key, { sha256: sha256(payload), bytes: payload.length });
      target.objects = target.objects.filter(
        (entry) => objectIdentity(entry.bucket, entry.name) !== key,
      );
      target.objects.push(
        object("target-object-id", input.bucket, input.name, payload.length, {
          metadata: {
            size: payload.length,
            ...(input.contentType === undefined
              ? {}
              : { mimetype: input.contentType }),
            ...(input.cacheControl === undefined
              ? {}
              : { cacheControl: input.cacheControl }),
          },
          userMetadata: input.userMetadata ?? null,
        }),
      );
    }),
  };
}

function bucketAction(): RestoreAction {
  return action("storage.file_buckets", ["storage/file-catalog.json"]);
}

function objectAction(fixture: BundleFixture): RestoreAction {
  return action("storage.file_objects", [
    fixture.indexArtifact,
    fixture.objectArtifact,
  ]);
}

function metadataAction(): RestoreAction {
  return action("storage.file_metadata", [
    "storage/file-catalog.json",
    "database/storage-metadata.sql",
  ]);
}

describe("File Storage bucket restore", () => {
  it("preflights fail-policy conflicts before any bucket mutation", async () => {
    const fixture = await createBundle();
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: [bucket("assets", { public: true }), bucket("target-only")],
      objects: [],
    };
    const client = mutationClient(target);
    const handler = createFileBucketRestoreHandler(
      restoreOptions(fixture, "fail", {
        storageClient: client,
        collectTarget: () => Promise.resolve(target),
      }),
    );

    await expect(
      handler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(client.createBucket).not.toHaveBeenCalled();
    expect(client.updateBucket).not.toHaveBeenCalled();
    expect(client.emptyBucket).not.toHaveBeenCalled();
    expect(client.deleteBucket).not.toHaveBeenCalled();
  });

  it("reconciles conflicting and extra buckets under replace and verifies exact parity", async () => {
    const fixture = await createBundle();
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: [
        bucket("assets", { public: true, allowedMimeTypes: null }),
        bucket("target-only"),
      ],
      objects: [],
    };
    const client = mutationClient(target);
    const handler = createFileBucketRestoreHandler(
      restoreOptions(fixture, "replace", {
        storageClient: client,
        collectTarget: () => Promise.resolve(target),
      }),
    );

    const applied = await handler.apply({ action: bucketAction(), attempt: 1 });
    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(client.updateBucket).toHaveBeenCalledOnce();
    expect(client.emptyBucket).toHaveBeenCalledWith("target-only");
    expect(client.deleteBucket).toHaveBeenCalledWith("target-only");
    await expect(
      handler.verify({
        action: bucketAction(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      handler.verify({
        action: bucketAction(),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("creates missing buckets and canonicalizes allowed MIME ordering", async () => {
    const fixture = await createBundle();
    fixture.catalog.buckets[0]!.allowedMimeTypes = ["text/plain", "image/png"];
    await writeFile(
      path.join(fixture.root, "storage", "file-catalog.json"),
      JSON.stringify(fixture.catalog),
    );
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: [],
      objects: [],
    };
    const client = mutationClient(target);
    const handler = createFileBucketRestoreHandler(
      restoreOptions(fixture, "fail", {
        storageClient: client,
        collectTarget: () => Promise.resolve(target),
      }),
    );

    await handler.apply({ action: bucketAction(), attempt: 1 });
    expect(client.createBucket).toHaveBeenCalledOnce();
    await expect(handler.verify({ action: bucketAction() })).resolves.toBe(
      true,
    );
  });

  it("normalizes Storage API failures without exposing credentials", async () => {
    const fixture = await createBundle();
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: [],
      objects: [],
    };
    const client = mutationClient(target);
    client.createBucket = vi.fn<StorageMutationClient["createBucket"]>(() =>
      Promise.resolve({
        data: null,
        error: { message: "do not surface provider detail", statusCode: "500" },
      }),
    );
    const handler = createFileBucketRestoreHandler(
      restoreOptions(fixture, "fail", {
        storageClient: client,
        collectTarget: () => Promise.resolve(target),
      }),
    );

    await expect(
      handler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "STORAGE_BUCKET_RESTORE_FAILED",
      category: "storage",
    });
  });

  it("fails closed when source bucket identity cannot be represented by the supported API", async () => {
    const fixture = await createBundle();
    fixture.catalog.buckets[0]!.name = "different-name";
    await writeFile(
      path.join(fixture.root, "storage", "file-catalog.json"),
      JSON.stringify(fixture.catalog),
    );
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: [],
      objects: [],
    };
    const handler = createFileBucketRestoreHandler(
      restoreOptions(fixture, "fail", {
        storageClient: mutationClient(target),
        collectTarget: () => Promise.resolve(target),
      }),
    );

    await expect(
      handler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_BUCKET_IDENTITY_UNSUPPORTED" });
  });
});

describe("File Storage object restore", () => {
  it("verifies source bytes before mutation and rejects same-size checksum corruption", async () => {
    const fixture = await createBundle(Buffer.from("hello storage", "utf8"));
    await writeFile(
      path.join(fixture.root, ...fixture.objectArtifact.split("/")),
      Buffer.from("HELLO STORAGE", "utf8"),
    );
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: cloneCatalog(fixture.catalog).buckets,
      objects: [],
    };
    const evidence = new Map<string, StorageObjectEvidence>();
    const dependencies = objectDependencies(target, evidence);
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "fail", dependencies),
    );

    await expect(
      handler.apply({ action: objectAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(dependencies.uploadObject).not.toHaveBeenCalled();
  });

  it("rejects malformed object index identity evidence", async () => {
    const fixture = await createBundle();
    const indexPath = path.join(
      fixture.root,
      ...fixture.indexArtifact.split("/"),
    );
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as {
      objects: { contentId: string }[];
    };
    parsed.objects[0]!.contentId = "0".repeat(64);
    await writeFile(indexPath, JSON.stringify(parsed));
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: cloneCatalog(fixture.catalog).buckets,
      objects: [],
    };
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "fail", objectDependencies(target, new Map())),
    );

    await expect(
      handler.apply({ action: objectAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("rejects extra target objects under fail before uploading missing source objects", async () => {
    const fixture = await createBundle();
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: cloneCatalog(fixture.catalog).buckets,
      objects: [object("extra", "assets", "extra.txt", 1)],
    };
    const evidence = new Map<string, StorageObjectEvidence>([
      [
        objectIdentity("assets", "extra.txt"),
        { sha256: "1".repeat(64), bytes: 1 },
      ],
    ]);
    const dependencies = objectDependencies(target, evidence);
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "fail", dependencies),
    );

    await expect(
      handler.apply({ action: objectAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(dependencies.uploadObject).not.toHaveBeenCalled();
  });

  it("rejects byte or metadata drift in an existing fail-policy object", async () => {
    const fixture = await createBundle();
    const target = cloneCatalog(fixture.catalog);
    target.objects[0]!.userMetadata = { fixture: "different" };
    const evidence = new Map<string, StorageObjectEvidence>([
      [
        objectIdentity("assets", "folder/example.txt"),
        { sha256: "f".repeat(64), bytes: fixture.payload.length },
      ],
    ]);
    const dependencies = objectDependencies(target, evidence);
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "fail", dependencies),
    );

    await expect(
      handler.apply({ action: objectAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(dependencies.uploadObject).not.toHaveBeenCalled();
  });

  it("streams a missing source object with upsert disabled and verifies byte plus metadata parity", async () => {
    const fixture = await createBundle();
    const target: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: cloneCatalog(fixture.catalog).buckets,
      objects: [],
    };
    const evidence = new Map<string, StorageObjectEvidence>();
    const dependencies = objectDependencies(target, evidence);
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "fail", dependencies),
    );

    const applied = await handler.apply({
      action: objectAction(fixture),
      attempt: 1,
    });
    expect(dependencies.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "assets",
        name: "folder/example.txt",
        upsert: false,
        contentType: "text/plain",
        cacheControl: "3600",
        userMetadata: { fixture: "source" },
      }),
      expect.any(AbortSignal),
    );
    await expect(
      handler.verify({
        action: objectAction(fixture),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      handler.verify({
        action: objectAction(fixture),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("replace removes target-only objects, upserts drift, and leaves exact source object parity", async () => {
    const fixture = await createBundle();
    const target = cloneCatalog(fixture.catalog);
    target.objects.push(object("extra", "assets", "extra.txt", 5));
    target.objects[0]!.metadata = {
      size: fixture.payload.length,
      mimetype: "application/octet-stream",
      cacheControl: "60",
    };
    const evidence = new Map<string, StorageObjectEvidence>([
      [
        objectIdentity("assets", "folder/example.txt"),
        { sha256: "f".repeat(64), bytes: fixture.payload.length },
      ],
      [
        objectIdentity("assets", "extra.txt"),
        { sha256: "e".repeat(64), bytes: 5 },
      ],
    ]);
    const dependencies = objectDependencies(target, evidence);
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "replace", dependencies),
    );

    await handler.apply({ action: objectAction(fixture), attempt: 1 });
    expect(dependencies.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({ upsert: true }),
      expect.any(AbortSignal),
    );
    expect(target.objects).toHaveLength(1);
    expect(target.objects[0]?.name).toBe("folder/example.txt");
    await expect(
      handler.verify({ action: objectAction(fixture) }),
    ).resolves.toBe(true);
  });

  it("uses the default streaming data-plane path without materializing object bytes in memory", async () => {
    const fixture = await createBundle();
    let uploaded = false;
    const emptyTarget: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: cloneCatalog(fixture.catalog).buckets,
      objects: [],
    };
    const client = mutationClient(emptyTarget);
    const seen: { method: string | undefined; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = vi.fn<typeof fetch>(
      async (_input, init) => {
        await Promise.resolve();
        seen.push({
          method: init?.method,
          headers: new Headers(init?.headers),
        });
        if (init?.method === "POST") {
          uploaded = true;
          return new Response("{}", { status: 200 });
        }
        return uploaded
          ? new Response(fixture.payload, { status: 200 })
          : new Response(null, { status: 404 });
      },
    );
    const dependencies: FileStorageRestoreDependencies = {
      storageClient: client,
      collectTarget: () =>
        Promise.resolve(uploaded ? cloneCatalog(fixture.catalog) : emptyTarget),
    };
    const handler = createFileObjectRestoreHandler(
      restoreOptions(fixture, "fail", dependencies, fetchImpl),
    );

    const applied = await handler.apply({
      action: objectAction(fixture),
      attempt: 1,
    });
    await expect(
      handler.verify({
        action: objectAction(fixture),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    const upload = seen.find(({ method }) => method === "POST");
    expect(upload).toBeDefined();
    const headers = upload?.headers ?? new Headers();
    expect(headers.get("x-upsert")).toBe("false");
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("cache-control")).toBe("max-age=3600");
    expect(headers.get("x-metadata")).not.toBeNull();
  });

  it("fails closed on data-plane upload and verification HTTP failures", async () => {
    const fixture = await createBundle();
    const emptyTarget: FileStorageCatalog = {
      schemaVersion: 1,
      buckets: cloneCatalog(fixture.catalog).buckets,
      objects: [],
    };
    const uploadFailure: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("failure", { status: 503 })),
    );
    const handler = createFileObjectRestoreHandler(
      restoreOptions(
        fixture,
        "fail",
        {
          storageClient: mutationClient(emptyTarget),
          collectTarget: () => Promise.resolve(emptyTarget),
        },
        uploadFailure,
      ),
    );
    await expect(
      handler.apply({ action: objectAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_OBJECT_RESTORE_FAILED" });

    const existing = cloneCatalog(fixture.catalog);
    const verifyFailure: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("failure", { status: 500 })),
    );
    const verifyHandler = createFileObjectRestoreHandler(
      restoreOptions(
        fixture,
        "fail",
        {
          storageClient: mutationClient(existing),
          collectTarget: () => Promise.resolve(existing),
        },
        verifyFailure,
      ),
    );
    await expect(
      verifyHandler.apply({ action: objectAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_OBJECT_VERIFY_FAILED" });
  });
});

describe("File Storage metadata restore", () => {
  it("treats platform IDs and timestamps as non-semantic while requiring supported metadata parity", async () => {
    const fixture = await createBundle();
    const target = cloneCatalog(fixture.catalog);
    target.objects[0]!.id = "different-platform-id";
    target.objects[0]!.version = "different-version";
    target.objects[0]!.createdAt = "2030-01-01T00:00:00.000Z";
    target.objects[0]!.updatedAt = "2030-01-01T00:00:01.000Z";
    const handler = createFileMetadataRestoreHandler(
      restoreOptions(fixture, "fail", {
        storageClient: mutationClient(target),
        collectTarget: () => Promise.resolve(target),
      }),
    );

    const applied = await handler.apply({
      action: metadataAction(),
      attempt: 1,
    });
    await expect(
      handler.verify({
        action: metadataAction(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);

    target.objects[0]!.userMetadata = { fixture: "drift" };
    await expect(handler.verify({ action: metadataAction() })).resolves.toBe(
      false,
    );
  });

  it("rejects action artifact substitution and metadata fingerprint substitution", async () => {
    const fixture = await createBundle();
    const target = cloneCatalog(fixture.catalog);
    const handler = createFileMetadataRestoreHandler(
      restoreOptions(fixture, "fail", {
        storageClient: mutationClient(target),
        collectTarget: () => Promise.resolve(target),
      }),
    );

    await expect(
      handler.apply({
        action: action("storage.file_metadata", ["storage/file-catalog.json"]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    await expect(
      handler.verify({
        action: metadataAction(),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });
});
