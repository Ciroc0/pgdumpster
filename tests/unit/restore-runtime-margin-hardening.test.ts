import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatabaseCatalogState } from "../../src/database/catalog-state.js";
import {
  createDatabaseSupplementRestoreHandlers,
  type DatabaseSupplementRestoreDependencies,
} from "../../src/core/restore/database-supplement-handlers.js";
import {
  createFileBucketRestoreHandler,
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

function action(
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

function webhook(
  name: string,
  enabled: "O" | "D" | "R" | "A",
): DatabaseCatalogState["webhooks"][number] {
  return {
    schema: "public",
    table: "events",
    name,
    enabled,
    functionSchema: "supabase_functions",
    functionName: "http_request",
    definition: `CREATE TRIGGER ${name} AFTER INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://example.invalid','POST','{}','{}','1000')`,
  };
}

function catalog(
  webhooks: DatabaseCatalogState["webhooks"] = [],
): DatabaseCatalogState {
  return {
    schemaVersion: 1,
    publications: [],
    publicationTables: [],
    webhooks,
  };
}

async function webhookRoot(source: DatabaseCatalogState): Promise<string> {
  const root = await tempRoot("pgdumpster-webhook-margin-");
  await mkdir(path.join(root, "database"), { recursive: true });
  await writeFile(
    path.join(root, "database", "catalog-state.json"),
    JSON.stringify(source),
  );
  return root;
}

function webhookAction(): RestoreAction {
  return action("database.webhooks", 7, "apply_logical_database_state", [
    "database/catalog-state.json",
  ]);
}

describe("restore runtime margin: database webhooks", () => {
  it("emits disabled, replica, and always trigger enablement under replace", async () => {
    const source = catalog([
      webhook("disabled_hook", "D"),
      webhook("replica_hook", "R"),
      webhook("always_hook", "A"),
    ]);
    const root = await webhookRoot(source);
    const queries: string[] = [];
    const dependencies: DatabaseSupplementRestoreDependencies = {
      collectDatabaseCatalogState: () => Promise.resolve(catalog()),
      createWebhookClient: () => ({
        connect: () => Promise.resolve(),
        query: (sql) => {
          queries.push(sql);
          return Promise.resolve({});
        },
        end: () => Promise.resolve(),
      }),
    };
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: secret(
        "postgresql://postgres:secret@example.invalid/postgres",
      ),
      conflictPolicy: "replace",
      dependencies,
    })["database.webhooks"];

    await handler.apply({ action: webhookAction(), attempt: 1 });
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
    expect(queries.some((sql) => sql.includes("DISABLE TRIGGER"))).toBe(true);
    expect(queries.some((sql) => sql.includes("ENABLE REPLICA TRIGGER"))).toBe(
      true,
    );
    expect(queries.some((sql) => sql.includes("ENABLE ALWAYS TRIGGER"))).toBe(
      true,
    );
  });

  it("uses the normal ENABLE TRIGGER fallback when a matching trigger should return to origin mode", async () => {
    const sourceWebhook = webhook('quoted"hook', "O");
    const targetWebhook = { ...sourceWebhook, enabled: "D" as const };
    const root = await webhookRoot(catalog([sourceWebhook]));
    const queries: string[] = [];
    const handler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: root,
      targetDatabaseUrl: secret(
        "postgresql://postgres:secret@example.invalid/postgres",
      ),
      conflictPolicy: "replace",
      dependencies: {
        collectDatabaseCatalogState: () =>
          Promise.resolve(catalog([targetWebhook])),
        createWebhookClient: () => ({
          connect: () => Promise.resolve(),
          query: (sql) => {
            queries.push(sql);
            return Promise.resolve({});
          },
          end: () => Promise.resolve(),
        }),
      },
    })["database.webhooks"];

    await handler.apply({ action: webhookAction(), attempt: 1 });
    expect(
      queries.some(
        (sql) => sql.includes("ENABLE TRIGGER") && sql.includes('quoted""hook'),
      ),
    ).toBe(true);
  });

  it("rejects invalid webhook contracts and malformed catalog JSON", async () => {
    const invalidWebhook = webhook("bad_hook", "O");
    invalidWebhook.functionName = "other_function";
    const invalidRoot = await webhookRoot(catalog([invalidWebhook]));
    const invalidHandler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: invalidRoot,
      targetDatabaseUrl: secret(
        "postgresql://postgres:secret@example.invalid/postgres",
      ),
      conflictPolicy: "replace",
      dependencies: {
        collectDatabaseCatalogState: () => Promise.resolve(catalog()),
      },
    })["database.webhooks"];
    await expect(
      invalidHandler.apply({ action: webhookAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const malformedRoot = await webhookRoot(catalog());
    await writeFile(
      path.join(malformedRoot, "database", "catalog-state.json"),
      "not-json",
    );
    const malformedHandler = createDatabaseSupplementRestoreHandlers({
      bundleRoot: malformedRoot,
      targetDatabaseUrl: secret(
        "postgresql://postgres:secret@example.invalid/postgres",
      ),
      conflictPolicy: "fail",
      dependencies: {
        collectDatabaseCatalogState: () => Promise.resolve(catalog()),
      },
    })["database.webhooks"];
    await expect(
      malformedHandler.verify({ action: webhookAction() }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
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
    fileSizeLimit: null,
    allowedMimeTypes: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function fileObject(
  bucket: string,
  name: string,
  bytes: number,
  overrides: Partial<FileStorageObject> = {},
): FileStorageObject {
  return {
    id: "source-id",
    bucket,
    name,
    owner: null,
    ownerId: null,
    version: null,
    createdAt: null,
    updatedAt: null,
    lastAccessedAt: null,
    expectedBytes: bytes,
    metadata: null,
    userMetadata: null,
    ...overrides,
  };
}

interface FileFixture {
  root: string;
  payload: Buffer;
  objectArtifact: string;
  catalog: FileStorageCatalog;
}

async function fileFixture(): Promise<FileFixture> {
  const root = await tempRoot("pgdumpster-file-runtime-margin-");
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "database"), { recursive: true });
  await mkdir(path.join(root, "secrets", "storage"), { recursive: true });
  const payload = Buffer.from("payload", "utf8");
  const bucket = "assets";
  const name = "plain.bin";
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
  const catalogValue: FileStorageCatalog = {
    schemaVersion: 1,
    buckets: [fileBucket(bucket)],
    objects: [fileObject(bucket, name, payload.length)],
  };
  await writeFile(
    path.join(root, "storage", "file-catalog.json"),
    JSON.stringify(catalogValue),
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
          sha256: createHash("sha256").update(payload).digest("hex"),
          bytes: payload.length,
        },
      ],
    }),
  );
  return { root, payload, objectArtifact, catalog: catalogValue };
}

function success(): Promise<StorageResult> {
  return Promise.resolve({ data: {}, error: null });
}

function storageClient(
  overrides: Partial<StorageMutationClient> = {},
): StorageMutationClient {
  return {
    createBucket: () => success(),
    updateBucket: () => success(),
    emptyBucket: () => success(),
    deleteBucket: () => success(),
    from: () => ({ remove: () => success() }),
    ...overrides,
  };
}

function fileOptions(
  fixture: FileFixture,
  dependencies: FileStorageRestoreDependencies,
  conflictPolicy: "fail" | "replace" = "fail",
  fetchImpl?: typeof fetch,
): FileStorageRestoreOptions {
  return {
    bundleRoot: fixture.root,
    targetProjectRef: projectRef,
    targetDatabaseUrl: secret(
      "postgresql://postgres:secret@example.invalid/postgres",
    ),
    storageKey: secret("storage-key"),
    conflictPolicy,
    dependencies,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  };
}

function bucketAction(): RestoreAction {
  return action("storage.file_buckets", 10, "create_or_update_file_buckets", [
    "storage/file-catalog.json",
  ]);
}

function objectAction(fixture: FileFixture): RestoreAction {
  return action("storage.file_objects", 11, "stream_file_objects", [
    "secrets/storage/file-object-index.json",
    fixture.objectArtifact,
  ]);
}

describe("restore runtime margin: File Storage", () => {
  it("normalizes create, delete, and update bucket mutation failures", async () => {
    const createFixture = await fileFixture();
    const createHandler = createFileBucketRestoreHandler(
      fileOptions(createFixture, {
        storageClient: storageClient({
          createBucket: () =>
            Promise.resolve({
              data: null,
              error: { message: "create", status: 500 },
            }),
        }),
        collectTarget: () =>
          Promise.resolve({ schemaVersion: 1, buckets: [], objects: [] }),
      }),
    );
    await expect(
      createHandler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_BUCKET_RESTORE_FAILED" });

    const deleteFixture = await fileFixture();
    const extra = fileBucket("extra");
    const deleteHandler = createFileBucketRestoreHandler(
      fileOptions(
        deleteFixture,
        {
          storageClient: storageClient({
            deleteBucket: () =>
              Promise.resolve({
                data: null,
                error: { message: "delete", statusCode: "503" },
              }),
          }),
          collectTarget: () =>
            Promise.resolve({
              schemaVersion: 1,
              buckets: [
                structuredClone(deleteFixture.catalog.buckets[0]!),
                extra,
              ],
              objects: [],
            }),
        },
        "replace",
      ),
    );
    await expect(
      deleteHandler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_BUCKET_RESTORE_FAILED" });

    const updateFixture = await fileFixture();
    const drifted = fileBucket("assets", { public: true });
    const updateHandler = createFileBucketRestoreHandler(
      fileOptions(
        updateFixture,
        {
          storageClient: storageClient({
            updateBucket: () =>
              Promise.resolve({ data: null, error: { message: "update" } }),
          }),
          collectTarget: () =>
            Promise.resolve({
              schemaVersion: 1,
              buckets: [drifted],
              objects: [],
            }),
        },
        "replace",
      ),
    );
    await expect(
      updateHandler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_BUCKET_RESTORE_FAILED" });
  });

  it("uses default upload with optional metadata headers omitted", async () => {
    const fixture = await fileFixture();
    const requests: { method: string | undefined; headers: Headers }[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      requests.push({
        method: init?.method,
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const handler = createFileObjectRestoreHandler(
      fileOptions(
        fixture,
        {
          storageClient: storageClient(),
          collectTarget: () =>
            Promise.resolve({
              schemaVersion: 1,
              buckets: structuredClone(fixture.catalog.buckets),
              objects: [],
            }),
        },
        "fail",
        fetchImpl,
      ),
    );

    await handler.apply({ action: objectAction(fixture), attempt: 1 });
    const post = requests.find(({ method }) => method === "POST");
    expect(post).toBeDefined();
    expect(post?.headers.has("content-type")).toBe(false);
    expect(post?.headers.has("cache-control")).toBe(false);
    expect(post?.headers.has("x-metadata")).toBe(false);
    expect(post?.headers.get("x-upsert")).toBe("false");
  });

  it("returns false for extra targets, metadata drift, and byte-evidence drift", async () => {
    const extraFixture = await fileFixture();
    const extraTarget = structuredClone(extraFixture.catalog);
    extraTarget.objects.push(
      fileObject("assets", "extra.bin", 1, { id: "extra" }),
    );
    const extraHandler = createFileObjectRestoreHandler(
      fileOptions(extraFixture, {
        storageClient: storageClient(),
        collectTarget: () => Promise.resolve(extraTarget),
        readTargetObject: () =>
          Promise.resolve({
            sha256: createHash("sha256")
              .update(extraFixture.payload)
              .digest("hex"),
            bytes: extraFixture.payload.length,
          }),
      }),
    );
    await expect(
      extraHandler.verify({ action: objectAction(extraFixture) }),
    ).resolves.toBe(false);

    const metadataFixture = await fileFixture();
    const metadataTarget = structuredClone(metadataFixture.catalog);
    metadataTarget.objects[0]!.expectedBytes =
      metadataFixture.payload.length + 1;
    const metadataHandler = createFileObjectRestoreHandler(
      fileOptions(metadataFixture, {
        storageClient: storageClient(),
        collectTarget: () => Promise.resolve(metadataTarget),
        readTargetObject: () =>
          Promise.resolve({
            sha256: createHash("sha256")
              .update(metadataFixture.payload)
              .digest("hex"),
            bytes: metadataFixture.payload.length,
          }),
      }),
    );
    await expect(
      metadataHandler.verify({ action: objectAction(metadataFixture) }),
    ).resolves.toBe(false);

    const evidenceFixture = await fileFixture();
    const evidenceHandler = createFileObjectRestoreHandler(
      fileOptions(evidenceFixture, {
        storageClient: storageClient(),
        collectTarget: () =>
          Promise.resolve(structuredClone(evidenceFixture.catalog)),
        readTargetObject: () =>
          Promise.resolve({
            sha256: "f".repeat(64),
            bytes: evidenceFixture.payload.length + 1,
          }),
      }),
    );
    await expect(
      evidenceHandler.verify({ action: objectAction(evidenceFixture) }),
    ).resolves.toBe(false);
  });
});

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function vector(key: string, value: number): VectorValue {
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
  const root = await tempRoot("pgdumpster-vector-runtime-margin-");
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "secrets", "storage"), { recursive: true });
  const bucketName = "embeddings";
  const indexName = "documents";
  await writeFile(
    path.join(root, "storage", "vector-buckets.json"),
    JSON.stringify({
      schemaVersion: 1,
      buckets: [{ vectorBucketName: bucketName }],
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
        },
      ],
    }),
  );
  const pageArtifact = `secrets/storage/vectors/${stableId(bucketName, indexName)}/00000001.json`;
  await mkdir(path.dirname(path.join(root, ...pageArtifact.split("/"))), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ...pageArtifact.split("/")),
    JSON.stringify({
      schemaVersion: 1,
      bucketName,
      indexName,
      vectors: [vector("one", 1)],
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

function vectorAction(
  component:
    "storage.vector_buckets" | "storage.vector_indexes" | "storage.vectors",
  fixture: VectorFixture,
): RestoreAction {
  const artifacts =
    component === "storage.vector_buckets"
      ? ["storage/vector-buckets.json"]
      : component === "storage.vector_indexes"
        ? ["storage/vector-indexes.json"]
        : ["secrets/storage/vector-summary.json", fixture.pageArtifact];
  return action(component, 12, "restore_vector_state", artifacts);
}

function emptyIndexClient(): VectorIndexMutationClient {
  return {
    listVectors: () => Promise.resolve({ data: { vectors: [] }, error: null }),
    putVectors: () => Promise.resolve({ data: {}, error: null }),
    deleteVectors: () => Promise.resolve({ data: {}, error: null }),
  };
}

function bucketClient(
  overrides: Partial<VectorBucketMutationClient> = {},
  indexFactory: () => VectorIndexMutationClient = emptyIndexClient,
): VectorBucketMutationClient {
  return {
    listIndexes: () => Promise.resolve({ data: { indexes: [] }, error: null }),
    getIndex: () => Promise.resolve({ data: null, error: { status: 404 } }),
    createIndex: () => Promise.resolve({ data: {}, error: null }),
    deleteIndex: () => Promise.resolve({ data: {}, error: null }),
    index: () => indexFactory(),
    ...overrides,
  };
}

function client(
  fixture: VectorFixture,
  overrides: Partial<VectorMutationClient> = {},
  bucketFactory: () => VectorBucketMutationClient = bucketClient,
): VectorMutationClient {
  void fixture;
  return {
    listBuckets: () =>
      Promise.resolve({ data: { vectorBuckets: [] }, error: null }),
    getBucket: (name) =>
      Promise.resolve({
        data: { vectorBucket: { vectorBucketName: name } },
        error: null,
      }),
    createBucket: () => Promise.resolve({ data: {}, error: null }),
    deleteBucket: () => Promise.resolve({ data: {}, error: null }),
    from: () => bucketFactory(),
    ...overrides,
  };
}

function vectorOptions(
  fixture: VectorFixture,
  vectorClient: VectorMutationClient,
  conflictPolicy: "fail" | "replace" = "fail",
): VectorStorageRestoreOptions {
  return {
    bundleRoot: fixture.root,
    targetProjectRef: projectRef,
    storageKey: secret("vector-key"),
    conflictPolicy,
    client: vectorClient,
  };
}

describe("restore runtime margin: Vector Storage", () => {
  it("normalizes bucket and index mutation failures", async () => {
    const bucketFixture = await vectorFixture();
    const bucketHandler = createVectorBucketRestoreHandler(
      vectorOptions(
        bucketFixture,
        client(bucketFixture, {
          createBucket: () =>
            Promise.resolve({ data: null, error: { status: 503 } }),
        }),
      ),
    );
    await expect(
      bucketHandler.apply({
        action: vectorAction("storage.vector_buckets", bucketFixture),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_SPECIALIZED_RESTORE_FAILED",
      details: { status: 503 },
    });

    const indexFixture = await vectorFixture();
    const failingBucket = (): VectorBucketMutationClient =>
      bucketClient({
        createIndex: () =>
          Promise.resolve({ data: null, error: { statusCode: "502" } }),
      });
    const indexHandler = createVectorIndexRestoreHandler(
      vectorOptions(indexFixture, client(indexFixture, {}, failingBucket)),
    );
    await expect(
      indexHandler.apply({
        action: vectorAction("storage.vector_indexes", indexFixture),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "STORAGE_SPECIALIZED_RESTORE_FAILED",
      details: { status: 502 },
    });
  });

  it("normalizes vector put and delete failures", async () => {
    const putFixture = await vectorFixture();
    const putIndex = (): VectorIndexMutationClient => ({
      listVectors: () =>
        Promise.resolve({ data: { vectors: [] }, error: null }),
      putVectors: () =>
        Promise.resolve({ data: null, error: { statusCode: "500" } }),
      deleteVectors: () => Promise.resolve({ data: {}, error: null }),
    });
    const putHandler = createVectorRestoreHandler(
      vectorOptions(
        putFixture,
        client(putFixture, {}, () => bucketClient({}, putIndex)),
      ),
    );
    await expect(
      putHandler.apply({
        action: vectorAction("storage.vectors", putFixture),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_RESTORE_FAILED" });

    const deleteFixture = await vectorFixture();
    const deleteIndex = (): VectorIndexMutationClient => ({
      listVectors: () =>
        Promise.resolve({
          data: { vectors: [vector("extra", 9)] },
          error: null,
        }),
      putVectors: () => Promise.resolve({ data: {}, error: null }),
      deleteVectors: () =>
        Promise.resolve({ data: null, error: { statusCode: "500" } }),
    });
    const deleteHandler = createVectorRestoreHandler(
      vectorOptions(
        deleteFixture,
        client(deleteFixture, {}, () => bucketClient({}, deleteIndex)),
        "replace",
      ),
    );
    await expect(
      deleteHandler.apply({
        action: vectorAction("storage.vectors", deleteFixture),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_RESTORE_FAILED" });
  });

  it("detects duplicate target vector keys", async () => {
    const fixture = await vectorFixture();
    const duplicateIndex = (): VectorIndexMutationClient => ({
      listVectors: () =>
        Promise.resolve({
          data: { vectors: [vector("same", 1), vector("same", 1)] },
          error: null,
        }),
      putVectors: () => Promise.resolve({ data: {}, error: null }),
      deleteVectors: () => Promise.resolve({ data: {}, error: null }),
    });
    const handler = createVectorRestoreHandler(
      vectorOptions(
        fixture,
        client(fixture, {}, () => bucketClient({}, duplicateIndex)),
      ),
    );
    await expect(
      handler.verify({ action: vectorAction("storage.vectors", fixture) }),
    ).rejects.toMatchObject({ code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT" });
  });

  it("returns false for vector length, key, and value drift", async () => {
    const lengthFixture = await vectorFixture();
    const lengthHandler = createVectorRestoreHandler(
      vectorOptions(lengthFixture, client(lengthFixture)),
    );
    await expect(
      lengthHandler.verify({
        action: vectorAction("storage.vectors", lengthFixture),
      }),
    ).resolves.toBe(false);

    const keyFixture = await vectorFixture();
    const keyIndex = (): VectorIndexMutationClient => ({
      listVectors: () =>
        Promise.resolve({ data: { vectors: [vector("two", 1)] }, error: null }),
      putVectors: () => Promise.resolve({ data: {}, error: null }),
      deleteVectors: () => Promise.resolve({ data: {}, error: null }),
    });
    const keyHandler = createVectorRestoreHandler(
      vectorOptions(
        keyFixture,
        client(keyFixture, {}, () => bucketClient({}, keyIndex)),
      ),
    );
    await expect(
      keyHandler.verify({
        action: vectorAction("storage.vectors", keyFixture),
      }),
    ).resolves.toBe(false);

    const valueFixture = await vectorFixture();
    const valueIndex = (): VectorIndexMutationClient => ({
      listVectors: () =>
        Promise.resolve({
          data: { vectors: [vector("one", 99)] },
          error: null,
        }),
      putVectors: () => Promise.resolve({ data: {}, error: null }),
      deleteVectors: () => Promise.resolve({ data: {}, error: null }),
    });
    const valueHandler = createVectorRestoreHandler(
      vectorOptions(
        valueFixture,
        client(valueFixture, {}, () => bucketClient({}, valueIndex)),
      ),
    );
    await expect(
      valueHandler.verify({
        action: vectorAction("storage.vectors", valueFixture),
      }),
    ).resolves.toBe(false);
  });

  it("detects index pagination cycles", async () => {
    const fixture = await vectorFixture();
    const cyclingBucket = (): VectorBucketMutationClient =>
      bucketClient({
        listIndexes: () =>
          Promise.resolve({
            data: { indexes: [], nextToken: "repeat" },
            error: null,
          }),
      });
    const handler = createVectorIndexRestoreHandler(
      vectorOptions(fixture, client(fixture, {}, cyclingBucket)),
    );
    await expect(
      handler.verify({
        action: vectorAction("storage.vector_indexes", fixture),
      }),
    ).rejects.toMatchObject({ code: "STORAGE_PAGINATION_CYCLE" });
  });
});
