import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEdgeFunctionRestoreHandler,
  createFetchEdgeFunctionRestoreClient,
  type EdgeFunctionBody,
  type EdgeFunctionRestoreClient,
} from "../../src/core/restore/edge-function-handler.js";
import {
  createFileBucketRestoreHandler,
  createFileMetadataRestoreHandler,
  createFileObjectRestoreHandler,
  type FileStorageRestoreDependencies,
  type FileStorageRestoreOptions,
  type StorageMutationClient,
  type StorageResult,
} from "../../src/core/restore/file-storage-handlers.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
import {
  createVectorBucketRestoreHandler,
  createVectorIndexRestoreHandler,
  createVectorRestoreHandler,
  type VectorBucketMutationClient,
  type VectorIndexMutationClient,
  type VectorMutationClient,
  type VectorStorageRestoreOptions,
  type VectorValue,
} from "../../src/core/restore/vector-storage-handlers.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type {
  FileStorageBucket,
  FileStorageCatalog,
  FileStorageObject,
} from "../../src/storage/catalog.js";

const temporaryDirectories: string[] = [];

const projectRef = "zyxwvutsrqponmlkjihg";

function secret(value: string): SecretValue {
  return new SecretValue(value, new Redactor());
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function restoreAction(
  component: string,
  phase: number,
  operation: string,
  artifacts: string[],
): RestoreAction {
  return {
    id: `restore.${component}`,
    component,
    phase,
    operation,
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "restore",
    fidelity: "semantic",
    artifacts,
  };
}

interface EdgeFixture {
  root: string;
  bodyPath: string;
  body: Buffer;
  contentType: string;
  metadata: {
    id: string;
    slug: string;
    name: string;
    status: "ACTIVE";
    version: number;
    created_at: number;
    updated_at: number;
    verify_jwt: boolean;
    ezbr_sha256?: string | undefined;
  };
}

async function edgeFixture(): Promise<EdgeFixture> {
  const root = await tempRoot("pgdumpster-edge-margin-");
  const bodyPath = "functions/demo/source.multipart";
  const body = Buffer.from(
    '--fixture\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--fixture--\r\n',
    "utf8",
  );
  const contentType = "multipart/form-data; boundary=fixture";
  const metadata = {
    id: "source-id",
    slug: "demo",
    name: "Demo",
    status: "ACTIVE" as const,
    version: 1,
    created_at: 1,
    updated_at: 2,
    verify_jwt: true,
    ezbr_sha256: "a".repeat(64),
  };
  await mkdir(path.dirname(path.join(root, ...bodyPath.split("/"))), {
    recursive: true,
  });
  await writeFile(path.join(root, ...bodyPath.split("/")), body);
  await writeFile(
    path.join(root, "functions", "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      representation: "management-api-multipart",
      functions: [
        {
          metadata,
          body: {
            path: bodyPath,
            bytes: body.length,
            sha256: sha256(body),
            contentType,
          },
        },
      ],
    }),
  );
  return { root, bodyPath, body, contentType, metadata };
}

function edgeAction(fixture: EdgeFixture, artifacts?: string[]): RestoreAction {
  return restoreAction(
    "edge.functions",
    14,
    "deploy_edge_functions",
    artifacts ?? ["functions/index.json", fixture.bodyPath],
  );
}

class StaticEdgeClient implements EdgeFunctionRestoreClient {
  constructor(
    private readonly values: EdgeFixture["metadata"][] = [],
    private readonly bodyValue?: EdgeFunctionBody,
  ) {}

  list(): Promise<EdgeFixture["metadata"][]> {
    return Promise.resolve(this.values);
  }

  get(slug: string): Promise<EdgeFixture["metadata"]> {
    const value = this.values.find((entry) => entry.slug === slug);
    return value === undefined
      ? Promise.reject(new Error(`missing ${slug}`))
      : Promise.resolve(value);
  }

  body(): Promise<EdgeFunctionBody> {
    return this.bodyValue === undefined
      ? Promise.reject(new Error("missing body"))
      : Promise.resolve(this.bodyValue);
  }

  deploy(): Promise<EdgeFixture["metadata"]> {
    return Promise.reject(new Error("unexpected deploy"));
  }

  delete(): Promise<void> {
    return Promise.reject(new Error("unexpected delete"));
  }
}

describe("restore branch margin: Edge Functions", () => {
  it("classifies 429 and ordinary 4xx responses separately", async () => {
    const rateLimited = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "x-request-id": "req-rate" },
          }),
        ),
      ),
    });
    await expect(rateLimited.list()).rejects.toMatchObject({
      code: "EDGE_FUNCTION_RESTORE_FAILED",
      category: "network",
      details: { status: 429, requestId: "req-rate" },
    });

    const badRequest = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response("bad request", {
            status: 400,
            headers: { "sb-request-id": "req-bad" },
          }),
        ),
      ),
    });
    await expect(badRequest.list()).rejects.toMatchObject({
      code: "EDGE_FUNCTION_RESTORE_FAILED",
      category: "edge",
      details: { status: 400, requestId: "req-bad" },
    });
  });

  it("normalizes network failures while preserving aborts", async () => {
    const network = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() => Promise.reject(new Error("offline"))),
    });
    await expect(network.list()).rejects.toMatchObject({
      code: "EDGE_FUNCTION_RESTORE_FAILED",
      category: "network",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(network.list(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects invalid project refs, inventory contracts, metadata contracts, and empty bodies", async () => {
    const invalidRef = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: "bad-ref",
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response("[]"))),
    });
    await expect(invalidRef.list()).rejects.toMatchObject({
      code: "PROJECT_REF_INVALID",
    });

    const invalidInventory = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ unexpected: true }))),
      ),
    });
    await expect(invalidInventory.list()).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });

    const invalidMetadata = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ slug: "demo" }))),
      ),
    });
    await expect(invalidMetadata.get("demo")).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });

    const emptyBody = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response(null))),
    });
    await expect(emptyBody.body("demo")).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });
  });

  it("rejects malformed, duplicate, and non-multipart source indexes", async () => {
    const fixture = await edgeFixture();
    const client = new StaticEdgeClient();
    const handler = createEdgeFunctionRestoreHandler({
      bundleRoot: fixture.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client,
    });

    await writeFile(
      path.join(fixture.root, "functions", "index.json"),
      "not-json",
    );
    await expect(
      handler.apply({ action: edgeAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const duplicate = await edgeFixture();
    const indexPath = path.join(duplicate.root, "functions", "index.json");
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as {
      functions: unknown[];
    };
    parsed.functions.push(structuredClone(parsed.functions[0]));
    await writeFile(indexPath, JSON.stringify(parsed));
    const duplicateHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: duplicate.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client,
    });
    await expect(
      duplicateHandler.apply({
        action: edgeAction(duplicate, [
          "functions/index.json",
          duplicate.bodyPath,
          duplicate.bodyPath,
        ]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const invalidMultipart = await edgeFixture();
    const invalidIndex = path.join(
      invalidMultipart.root,
      "functions",
      "index.json",
    );
    const invalidParsed = JSON.parse(await readFile(invalidIndex, "utf8")) as {
      functions: { body: { contentType: string } }[];
    };
    invalidParsed.functions[0]!.body.contentType = "application/json";
    await writeFile(invalidIndex, JSON.stringify(invalidParsed));
    const multipartHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: invalidMultipart.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client,
    });
    await expect(
      multipartHandler.apply({
        action: edgeAction(invalidMultipart),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("rejects empty indexes and source body size drift", async () => {
    const empty = await edgeFixture();
    await writeFile(path.join(empty.root, "functions", "index.json"), "");
    const emptyHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: empty.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client: new StaticEdgeClient(),
    });
    await expect(
      emptyHandler.apply({ action: edgeAction(empty), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const drift = await edgeFixture();
    await writeFile(
      path.join(drift.root, ...drift.bodyPath.split("/")),
      Buffer.concat([drift.body, Buffer.from("x")]),
    );
    const driftHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: drift.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client: new StaticEdgeClient(),
    });
    await expect(
      driftHandler.apply({ action: edgeAction(drift), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("covers verify length, missing slug, and invalid target content type branches", async () => {
    const fixture = await edgeFixture();
    const emptyHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: fixture.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client: new StaticEdgeClient(),
    });
    await expect(
      emptyHandler.verify({ action: edgeAction(fixture) }),
    ).resolves.toBe(false);

    const wrongSlug = { ...fixture.metadata, slug: "other" };
    const wrongSlugHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: fixture.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client: new StaticEdgeClient([wrongSlug]),
    });
    await expect(
      wrongSlugHandler.verify({ action: edgeAction(fixture) }),
    ).resolves.toBe(false);

    const noEzbr = await edgeFixture();
    const indexPath = path.join(noEzbr.root, "functions", "index.json");
    const document = JSON.parse(await readFile(indexPath, "utf8")) as {
      functions: { metadata: { ezbr_sha256?: string } }[];
    };
    delete document.functions[0]!.metadata.ezbr_sha256;
    await writeFile(indexPath, JSON.stringify(document));
    const invalidContentHandler = createEdgeFunctionRestoreHandler({
      bundleRoot: noEzbr.root,
      targetProjectRef: projectRef,
      accessToken: secret("token"),
      conflictPolicy: "fail",
      client: new StaticEdgeClient(
        [{ ...noEzbr.metadata, ezbr_sha256: undefined }],
        {
          body: new Response(noEzbr.body).body!,
          contentType: "application/octet-stream",
        },
      ),
    });
    await expect(
      invalidContentHandler.verify({ action: edgeAction(noEzbr) }),
    ).resolves.toBe(false);
  });
});

function fileBucket(
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

function fileObject(
  id: string,
  bucket: string,
  name: string,
  bytes: number,
  overrides: Partial<FileStorageObject> = {},
): FileStorageObject {
  return {
    id,
    bucket,
    name,
    owner: null,
    ownerId: null,
    version: null,
    createdAt: null,
    updatedAt: null,
    lastAccessedAt: null,
    expectedBytes: bytes,
    metadata: { size: bytes, mimetype: "text/plain", cacheControl: "3600" },
    userMetadata: { source: true },
    ...overrides,
  };
}

interface FileFixture {
  root: string;
  payload: Buffer;
  objectArtifact: string;
  contentId: string;
  catalog: FileStorageCatalog;
}

async function fileFixture(): Promise<FileFixture> {
  const root = await tempRoot("pgdumpster-file-margin-");
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "database"), { recursive: true });
  await mkdir(path.join(root, "secrets", "storage"), { recursive: true });
  const payload = Buffer.from("storage payload", "utf8");
  const bucket = "assets";
  const name = "folder/file.txt";
  const contentId = createHash("sha256")
    .update(bucket)
    .update("\0")
    .update(name)
    .digest("hex");
  const objectArtifact = `storage/file-objects/${contentId.slice(0, 2)}/${contentId}`;
  await mkdir(path.dirname(path.join(root, ...objectArtifact.split("/"))), {
    recursive: true,
  });
  await writeFile(path.join(root, ...objectArtifact.split("/")), payload);
  const catalog: FileStorageCatalog = {
    schemaVersion: 1,
    buckets: [fileBucket(bucket)],
    objects: [fileObject("source-id", bucket, name, payload.length)],
  };
  await writeFile(
    path.join(root, "storage", "file-catalog.json"),
    JSON.stringify(catalog),
  );
  await writeFile(
    path.join(root, "database", "storage-metadata.sql"),
    "-- metadata evidence\n",
  );
  await writeFile(
    path.join(root, "secrets", "storage", "file-object-index.json"),
    JSON.stringify({
      schemaVersion: 1,
      objects: [
        {
          bucket,
          name,
          contentId,
          path: objectArtifact,
          sha256: sha256(payload),
          bytes: payload.length,
          version: null,
          updatedAt: null,
        },
      ],
    }),
  );
  return { root, payload, objectArtifact, contentId, catalog };
}

function storageSuccess(): Promise<StorageResult> {
  return Promise.resolve({ data: {}, error: null });
}

function inertStorageClient(): StorageMutationClient {
  return {
    createBucket: () => storageSuccess(),
    updateBucket: () => storageSuccess(),
    emptyBucket: () => storageSuccess(),
    deleteBucket: () => storageSuccess(),
    from: () => ({ remove: () => storageSuccess() }),
  };
}

function fileOptions(
  fixture: FileFixture,
  dependencies: FileStorageRestoreDependencies,
  overrides: Partial<FileStorageRestoreOptions> = {},
): FileStorageRestoreOptions {
  return {
    bundleRoot: fixture.root,
    targetProjectRef: projectRef,
    targetDatabaseUrl: secret(
      "postgresql://postgres:secret@example.invalid/postgres",
    ),
    storageKey: secret("storage-key"),
    conflictPolicy: "fail",
    dependencies,
    ...overrides,
  };
}

function fileBucketAction(): RestoreAction {
  return restoreAction(
    "storage.file_buckets",
    10,
    "create_or_update_file_buckets",
    ["storage/file-catalog.json"],
  );
}

function fileObjectAction(fixture: FileFixture): RestoreAction {
  return restoreAction("storage.file_objects", 11, "stream_file_objects", [
    "secrets/storage/file-object-index.json",
    fixture.objectArtifact,
  ]);
}

function fileMetadataAction(): RestoreAction {
  return restoreAction("storage.file_metadata", 12, "verify_file_metadata", [
    "storage/file-catalog.json",
    "database/storage-metadata.sql",
  ]);
}

describe("restore branch margin: File Storage", () => {
  it("rejects duplicate buckets and unsupported bucket identity", async () => {
    const duplicate = await fileFixture();
    const duplicateCatalog = structuredClone(duplicate.catalog);
    duplicateCatalog.buckets.push(
      structuredClone(duplicateCatalog.buckets[0]!),
    );
    await writeFile(
      path.join(duplicate.root, "storage", "file-catalog.json"),
      JSON.stringify(duplicateCatalog),
    );
    const duplicateHandler = createFileBucketRestoreHandler(
      fileOptions(duplicate, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      duplicateHandler.apply({ action: fileBucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const identity = await fileFixture();
    const identityCatalog = structuredClone(identity.catalog);
    identityCatalog.buckets[0]!.name = "different";
    await writeFile(
      path.join(identity.root, "storage", "file-catalog.json"),
      JSON.stringify(identityCatalog),
    );
    const identityHandler = createFileBucketRestoreHandler(
      fileOptions(identity, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      identityHandler.apply({ action: fileBucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_BUCKET_IDENTITY_UNSUPPORTED" });
  });

  it("rejects invalid, orphaned, and duplicate catalog object identities", async () => {
    for (const mode of ["invalid-name", "orphan", "duplicate"] as const) {
      const fixture = await fileFixture();
      const catalog = structuredClone(fixture.catalog);
      if (mode === "invalid-name") catalog.objects[0]!.name = "../escape";
      if (mode === "orphan") catalog.objects[0]!.bucket = "missing";
      if (mode === "duplicate")
        catalog.objects.push(structuredClone(catalog.objects[0]!));
      await writeFile(
        path.join(fixture.root, "storage", "file-catalog.json"),
        JSON.stringify(catalog),
      );
      const handler = createFileBucketRestoreHandler(
        fileOptions(fixture, {
          storageClient: inertStorageClient(),
          collectTarget: () =>
            Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
        }),
      );
      await expect(
        handler.apply({ action: fileBucketAction(), attempt: 1 }),
      ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    }
  });

  it("rejects index identity drift and index/catalog cardinality drift", async () => {
    const invalidId = await fileFixture();
    const indexPath = path.join(
      invalidId.root,
      "secrets",
      "storage",
      "file-object-index.json",
    );
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      objects: { contentId: string; path: string }[];
    };
    index.objects[0]!.contentId = "0".repeat(64);
    await writeFile(indexPath, JSON.stringify(index));
    const invalidHandler = createFileObjectRestoreHandler(
      fileOptions(invalidId, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      invalidHandler.apply({ action: fileObjectAction(invalidId), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const missing = await fileFixture();
    await writeFile(
      path.join(missing.root, "secrets", "storage", "file-object-index.json"),
      JSON.stringify({ schemaVersion: 1, objects: [] }),
    );
    const missingHandler = createFileObjectRestoreHandler(
      fileOptions(missing, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      missingHandler.apply({
        action: restoreAction(
          "storage.file_objects",
          11,
          "stream_file_objects",
          ["secrets/storage/file-object-index.json"],
        ),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("rejects source payload size and checksum drift", async () => {
    const size = await fileFixture();
    await writeFile(
      path.join(size.root, ...size.objectArtifact.split("/")),
      Buffer.concat([size.payload, Buffer.from("x")]),
    );
    const sizeHandler = createFileObjectRestoreHandler(
      fileOptions(size, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      sizeHandler.apply({ action: fileObjectAction(size), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const checksum = await fileFixture();
    await writeFile(
      path.join(checksum.root, ...checksum.objectArtifact.split("/")),
      Buffer.alloc(checksum.payload.length, 0x78),
    );
    const checksumHandler = createFileObjectRestoreHandler(
      fileOptions(checksum, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      checksumHandler.apply({ action: fileObjectAction(checksum), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("covers default 404 and transport-failure object verification", async () => {
    const notFound = await fileFixture();
    const target = structuredClone(notFound.catalog);
    const notFoundHandler = createFileObjectRestoreHandler(
      fileOptions(
        notFound,
        {
          storageClient: inertStorageClient(),
          collectTarget: () => Promise.resolve(target),
          uploadObject: () => Promise.resolve(),
        },
        {
          fetch: vi.fn<typeof fetch>(() =>
            Promise.resolve(new Response(null, { status: 404 })),
          ),
        },
      ),
    );
    await expect(
      notFoundHandler.apply({ action: fileObjectAction(notFound), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });

    const transport = await fileFixture();
    const transportHandler = createFileObjectRestoreHandler(
      fileOptions(
        transport,
        {
          storageClient: inertStorageClient(),
          collectTarget: () =>
            Promise.resolve(structuredClone(transport.catalog)),
          uploadObject: () => Promise.resolve(),
        },
        {
          fetch: vi.fn<typeof fetch>(() =>
            Promise.reject(new Error("offline")),
          ),
        },
      ),
    );
    await expect(
      transportHandler.apply({
        action: fileObjectAction(transport),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_OBJECT_VERIFY_FAILED" });
  });

  it("covers metadata cardinality and missing-object verification branches", async () => {
    const fixture = await fileFixture();
    const emptyHandler = createFileMetadataRestoreHandler(
      fileOptions(fixture, {
        storageClient: inertStorageClient(),
        collectTarget: () =>
          Promise.resolve({
            schemaVersion: 1,
            buckets: fixture.catalog.buckets,
            objects: [],
          }),
      }),
    );
    await expect(
      emptyHandler.verify({ action: fileMetadataAction() }),
    ).resolves.toBe(false);

    const wrongTarget = structuredClone(fixture.catalog);
    wrongTarget.objects[0]!.name = "other.txt";
    const missingHandler = createFileMetadataRestoreHandler(
      fileOptions(fixture, {
        storageClient: inertStorageClient(),
        collectTarget: () => Promise.resolve(wrongTarget),
      }),
    );
    await expect(
      missingHandler.verify({ action: fileMetadataAction() }),
    ).resolves.toBe(false);
  });
});

function stableVectorId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function vectorValue(key: string, value = 1): VectorValue {
  return {
    key,
    data: { float32: [value, value + 1, value + 2] },
    metadata: { value },
  };
}

interface VectorFixture {
  root: string;
  bucketName: string;
  indexName: string;
  pageArtifact: string;
}

async function vectorFixture(): Promise<VectorFixture> {
  const root = await tempRoot("pgdumpster-vector-margin-");
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "secrets", "storage"), { recursive: true });
  const bucketName = "embeddings";
  const indexName = "documents";
  await writeFile(
    path.join(root, "storage", "vector-buckets.json"),
    JSON.stringify({
      schemaVersion: 1,
      buckets: [{ vectorBucketName: bucketName, creationTime: 1 }],
    }),
  );
  await writeFile(
    path.join(root, "storage", "vector-indexes.json"),
    JSON.stringify({
      schemaVersion: 1,
      indexes: [
        {
          indexName,
          vectorBucketName: bucketName,
          dataType: "float32",
          dimension: 3,
          distanceMetric: "cosine",
          creationTime: 2,
        },
      ],
    }),
  );
  const directoryId = stableVectorId(bucketName, indexName);
  const pageArtifact = `secrets/storage/vectors/${directoryId}/00000001.json`;
  await mkdir(path.dirname(path.join(root, ...pageArtifact.split("/"))), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ...pageArtifact.split("/")),
    JSON.stringify({
      schemaVersion: 1,
      bucketName,
      indexName,
      vectors: [vectorValue("one")],
    }),
  );
  await writeFile(
    path.join(root, "secrets", "storage", "vector-summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      indexes: [{ bucketName, indexName, vectorCount: 1, pageCount: 1 }],
    }),
  );
  return { root, bucketName, indexName, pageArtifact };
}

function vectorOptions(
  fixture: VectorFixture,
  client: VectorMutationClient,
): VectorStorageRestoreOptions {
  return {
    bundleRoot: fixture.root,
    targetProjectRef: projectRef,
    storageKey: secret("vector-key"),
    conflictPolicy: "fail",
    client,
  };
}

function emptyVectorIndexClient(): VectorIndexMutationClient {
  return {
    listVectors: () => Promise.resolve({ data: { vectors: [] }, error: null }),
    putVectors: () => Promise.resolve({ data: {}, error: null }),
    deleteVectors: () => Promise.resolve({ data: {}, error: null }),
  };
}

function emptyVectorBucketClient(): VectorBucketMutationClient {
  return {
    listIndexes: () => Promise.resolve({ data: { indexes: [] }, error: null }),
    getIndex: () => Promise.resolve({ data: null, error: { status: 404 } }),
    createIndex: () => Promise.resolve({ data: {}, error: null }),
    deleteIndex: () => Promise.resolve({ data: {}, error: null }),
    index: () => emptyVectorIndexClient(),
  };
}

function vectorClient(
  overrides: Partial<VectorMutationClient> = {},
  bucketFactory: () => VectorBucketMutationClient = emptyVectorBucketClient,
): VectorMutationClient {
  return {
    listBuckets: () =>
      Promise.resolve({ data: { vectorBuckets: [] }, error: null }),
    getBucket: (bucketName) =>
      Promise.resolve({
        data: { vectorBucket: { vectorBucketName: bucketName } },
        error: null,
      }),
    createBucket: () => Promise.resolve({ data: {}, error: null }),
    deleteBucket: () => Promise.resolve({ data: {}, error: null }),
    from: () => bucketFactory(),
    ...overrides,
  };
}

function vectorBucketAction(): RestoreAction {
  return restoreAction("storage.vector_buckets", 12, "create_vector_buckets", [
    "storage/vector-buckets.json",
  ]);
}

function vectorIndexAction(): RestoreAction {
  return restoreAction("storage.vector_indexes", 12, "create_vector_indexes", [
    "storage/vector-indexes.json",
  ]);
}

function vectorsAction(
  fixture: VectorFixture,
  artifacts?: string[],
): RestoreAction {
  return restoreAction(
    "storage.vectors",
    12,
    "put_vectors",
    artifacts ?? ["secrets/storage/vector-summary.json", fixture.pageArtifact],
  );
}

describe("restore branch margin: Vector Storage", () => {
  it("rejects duplicate source bucket and index identities", async () => {
    const buckets = await vectorFixture();
    await writeFile(
      path.join(buckets.root, "storage", "vector-buckets.json"),
      JSON.stringify({
        schemaVersion: 1,
        buckets: [
          { vectorBucketName: buckets.bucketName },
          { vectorBucketName: buckets.bucketName },
        ],
      }),
    );
    const bucketHandler = createVectorBucketRestoreHandler(
      vectorOptions(buckets, vectorClient()),
    );
    await expect(
      bucketHandler.apply({ action: vectorBucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const indexes = await vectorFixture();
    const indexPath = path.join(indexes.root, "storage", "vector-indexes.json");
    const indexDocument = JSON.parse(await readFile(indexPath, "utf8")) as {
      indexes: unknown[];
    };
    indexDocument.indexes.push(structuredClone(indexDocument.indexes[0]));
    await writeFile(indexPath, JSON.stringify(indexDocument));
    const indexHandler = createVectorIndexRestoreHandler(
      vectorOptions(indexes, vectorClient()),
    );
    await expect(
      indexHandler.apply({ action: vectorIndexAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("rejects duplicate summaries, page identity drift, duplicate keys, and count drift", async () => {
    const duplicateSummary = await vectorFixture();
    const summaryPath = path.join(
      duplicateSummary.root,
      "secrets",
      "storage",
      "vector-summary.json",
    );
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      indexes: unknown[];
    };
    summary.indexes.push(structuredClone(summary.indexes[0]));
    await writeFile(summaryPath, JSON.stringify(summary));
    const duplicateHandler = createVectorRestoreHandler(
      vectorOptions(duplicateSummary, vectorClient()),
    );
    await expect(
      duplicateHandler.apply({
        action: vectorsAction(duplicateSummary, [
          "secrets/storage/vector-summary.json",
          duplicateSummary.pageArtifact,
          duplicateSummary.pageArtifact,
        ]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const identity = await vectorFixture();
    const identityPage = path.join(
      identity.root,
      ...identity.pageArtifact.split("/"),
    );
    const pageDocument = JSON.parse(await readFile(identityPage, "utf8")) as {
      bucketName: string;
    };
    pageDocument.bucketName = "other";
    await writeFile(identityPage, JSON.stringify(pageDocument));
    const identityHandler = createVectorRestoreHandler(
      vectorOptions(identity, vectorClient()),
    );
    await expect(
      identityHandler.apply({ action: vectorsAction(identity), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const duplicateKey = await vectorFixture();
    const duplicatePage = path.join(
      duplicateKey.root,
      ...duplicateKey.pageArtifact.split("/"),
    );
    const duplicateDocument = JSON.parse(
      await readFile(duplicatePage, "utf8"),
    ) as {
      vectors: VectorValue[];
    };
    duplicateDocument.vectors.push(
      structuredClone(duplicateDocument.vectors[0]!),
    );
    await writeFile(duplicatePage, JSON.stringify(duplicateDocument));
    const duplicateKeyHandler = createVectorRestoreHandler(
      vectorOptions(duplicateKey, vectorClient()),
    );
    await expect(
      duplicateKeyHandler.apply({
        action: vectorsAction(duplicateKey),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const count = await vectorFixture();
    const countSummaryPath = path.join(
      count.root,
      "secrets",
      "storage",
      "vector-summary.json",
    );
    const countSummary = JSON.parse(
      await readFile(countSummaryPath, "utf8"),
    ) as {
      indexes: { vectorCount: number }[];
    };
    countSummary.indexes[0]!.vectorCount = 2;
    await writeFile(countSummaryPath, JSON.stringify(countSummary));
    const countHandler = createVectorRestoreHandler(
      vectorOptions(count, vectorClient()),
    );
    await expect(
      countHandler.apply({ action: vectorsAction(count), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });

  it("covers bucket API error, contract drift, duplicate identities, detail drift, and pagination cycles", async () => {
    const apiError = await vectorFixture();
    const errorHandler = createVectorBucketRestoreHandler(
      vectorOptions(
        apiError,
        vectorClient({
          listBuckets: () =>
            Promise.resolve({ data: null, error: { statusCode: 503 } }),
        }),
      ),
    );
    await expect(
      errorHandler.verify({ action: vectorBucketAction() }),
    ).rejects.toMatchObject({
      code: "STORAGE_SPECIALIZED_RESTORE_FAILED",
      details: { status: 503 },
    });

    const invalid = await vectorFixture();
    const invalidHandler = createVectorBucketRestoreHandler(
      vectorOptions(
        invalid,
        vectorClient({
          listBuckets: () =>
            Promise.resolve({ data: { wrong: [] }, error: null }),
        }),
      ),
    );
    await expect(
      invalidHandler.verify({ action: vectorBucketAction() }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_CONTRACT_CHANGED" });

    const duplicate = await vectorFixture();
    const duplicateClient = vectorClient({
      listBuckets: () =>
        Promise.resolve({
          data: {
            vectorBuckets: [
              { vectorBucketName: duplicate.bucketName },
              { vectorBucketName: duplicate.bucketName },
            ],
          },
          error: null,
        }),
    });
    const duplicateTargetHandler = createVectorBucketRestoreHandler(
      vectorOptions(duplicate, duplicateClient),
    );
    await expect(
      duplicateTargetHandler.verify({ action: vectorBucketAction() }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT" });

    const drift = await vectorFixture();
    const driftHandler = createVectorBucketRestoreHandler(
      vectorOptions(
        drift,
        vectorClient({
          listBuckets: () =>
            Promise.resolve({
              data: { vectorBuckets: [{ vectorBucketName: drift.bucketName }] },
              error: null,
            }),
          getBucket: () =>
            Promise.resolve({
              data: { vectorBucket: { vectorBucketName: "changed" } },
              error: null,
            }),
        }),
      ),
    );
    await expect(
      driftHandler.verify({ action: vectorBucketAction() }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT" });

    const cycle = await vectorFixture();
    const cycleHandler = createVectorBucketRestoreHandler(
      vectorOptions(
        cycle,
        vectorClient({
          listBuckets: () =>
            Promise.resolve({
              data: { vectorBuckets: [], nextToken: "repeat" },
              error: null,
            }),
        }),
      ),
    );
    await expect(
      cycleHandler.verify({ action: vectorBucketAction() }),
    ).rejects.toMatchObject({ code: "STORAGE_PAGINATION_CYCLE" });
  });

  it("covers index identity drift and vector pagination cycles", async () => {
    const indexDrift = await vectorFixture();
    const bucketFactory = (): VectorBucketMutationClient => ({
      listIndexes: () =>
        Promise.resolve({
          data: { indexes: [{ indexName: indexDrift.indexName }] },
          error: null,
        }),
      getIndex: () =>
        Promise.resolve({
          data: {
            index: {
              indexName: "changed",
              vectorBucketName: indexDrift.bucketName,
              dataType: "float32",
              dimension: 3,
              distanceMetric: "cosine",
            },
          },
          error: null,
        }),
      createIndex: () => Promise.resolve({ data: {}, error: null }),
      deleteIndex: () => Promise.resolve({ data: {}, error: null }),
      index: () => emptyVectorIndexClient(),
    });
    const indexHandler = createVectorIndexRestoreHandler(
      vectorOptions(indexDrift, vectorClient({}, bucketFactory)),
    );
    await expect(
      indexHandler.verify({ action: vectorIndexAction() }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT" });

    const vectorCycle = await vectorFixture();
    const cycleBucketFactory = (): VectorBucketMutationClient => ({
      ...emptyVectorBucketClient(),
      index: () => ({
        ...emptyVectorIndexClient(),
        listVectors: () =>
          Promise.resolve({
            data: { vectors: [], nextToken: "repeat" },
            error: null,
          }),
      }),
    });
    const vectorHandler = createVectorRestoreHandler(
      vectorOptions(vectorCycle, vectorClient({}, cycleBucketFactory)),
    );
    await expect(
      vectorHandler.verify({ action: vectorsAction(vectorCycle) }),
    ).rejects.toMatchObject({ code: "STORAGE_PAGINATION_CYCLE" });
  });
});
