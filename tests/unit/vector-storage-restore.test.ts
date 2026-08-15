import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function vector(key: string, value: number): VectorValue {
  return {
    key,
    data: { float32: [value, value + 1, value + 2] },
    metadata: { ordinal: value },
  };
}

interface SourceFixture {
  root: string;
  bucketName: string;
  indexName: string;
  pageArtifact?: string | undefined;
  vectors: VectorValue[];
}

async function sourceFixture(
  vectors: VectorValue[] = [vector("one", 1)],
  includeIndex = true,
): Promise<SourceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-vector-restore-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "storage"), { recursive: true });
  await mkdir(path.join(root, "secrets", "storage"), { recursive: true });
  const bucketName = "embeddings";
  const indexName = "documents";
  await writeFile(
    path.join(root, "storage", "vector-buckets.json"),
    JSON.stringify({
      schemaVersion: 1,
      buckets: [{ vectorBucketName: bucketName, creationTime: 123 }],
    }),
  );
  await writeFile(
    path.join(root, "storage", "vector-indexes.json"),
    JSON.stringify({
      schemaVersion: 1,
      indexes: includeIndex
        ? [
            {
              indexName,
              vectorBucketName: bucketName,
              dataType: "float32",
              dimension: 3,
              distanceMetric: "cosine",
              metadataConfiguration: {
                nonFilterableMetadataKeys: ["raw_text"],
              },
              creationTime: 456,
            },
          ]
        : [],
    }),
  );

  if (!includeIndex) {
    return { root, bucketName, indexName, vectors: [] };
  }

  const directory = path.join(
    root,
    "secrets",
    "storage",
    "vectors",
    stableId(bucketName, indexName),
  );
  await mkdir(directory, { recursive: true });
  const pageArtifact = `secrets/storage/vectors/${stableId(bucketName, indexName)}/00000001.json`;
  await writeFile(
    path.join(root, ...pageArtifact.split("/")),
    JSON.stringify({
      schemaVersion: 1,
      bucketName,
      indexName,
      vectors,
    }),
  );
  await writeFile(
    path.join(root, "secrets", "storage", "vector-summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      indexes: [
        {
          bucketName,
          indexName,
          vectorCount: vectors.length,
          pageCount: 1,
        },
      ],
    }),
  );
  return { root, bucketName, indexName, pageArtifact, vectors };
}

function action(
  component:
    "storage.vector_buckets" | "storage.vector_indexes" | "storage.vectors",
  artifacts: string[],
): RestoreAction {
  return {
    id: `restore.${component}`,
    component,
    phase: 12,
    operation:
      component === "storage.vector_buckets"
        ? "create_vector_buckets"
        : component === "storage.vector_indexes"
          ? "create_vector_indexes"
          : "put_vectors",
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

function bucketAction(): RestoreAction {
  return action("storage.vector_buckets", ["storage/vector-buckets.json"]);
}

function indexAction(): RestoreAction {
  return action("storage.vector_indexes", ["storage/vector-indexes.json"]);
}

function vectorsAction(fixture: SourceFixture): RestoreAction {
  return action("storage.vectors", [
    "secrets/storage/vector-summary.json",
    fixture.pageArtifact!,
  ]);
}

interface FakeIndexState {
  indexName: string;
  vectorBucketName: string;
  dataType: string;
  dimension: number;
  distanceMetric: string;
  metadataConfiguration?: unknown;
  creationTime?: number;
  vectors: Map<string, VectorValue>;
}

interface FakeBucketState {
  vectorBucketName: string;
  creationTime?: number;
  indexes: Map<string, FakeIndexState>;
}

class FakeVectorClient implements VectorMutationClient {
  readonly buckets = new Map<string, FakeBucketState>();
  readonly mutations: string[] = [];
  cycleVectorsFor?: string;

  listBuckets() {
    return Promise.resolve({
      data: {
        vectorBuckets: [...this.buckets.keys()]
          .sort((left, right) => left.localeCompare(right, "en"))
          .map((vectorBucketName) => ({ vectorBucketName })),
      },
      error: null,
    });
  }

  getBucket(bucketName: string) {
    const bucket = this.buckets.get(bucketName);
    return Promise.resolve(
      bucket === undefined
        ? { data: null, error: { status: 404 } }
        : {
            data: {
              vectorBucket: {
                vectorBucketName: bucket.vectorBucketName,
                creationTime: bucket.creationTime ?? 999,
              },
            },
            error: null,
          },
    );
  }

  createBucket(
    bucketName: string,
  ): ReturnType<VectorMutationClient["createBucket"]> {
    this.mutations.push(`create-bucket:${bucketName}`);
    this.buckets.set(bucketName, {
      vectorBucketName: bucketName,
      indexes: new Map(),
    });
    return Promise.resolve({ data: {}, error: null });
  }

  deleteBucket(bucketName: string) {
    const bucket = this.buckets.get(bucketName);
    if ((bucket?.indexes.size ?? 0) > 0) {
      return Promise.resolve({ data: null, error: { statusCode: "409" } });
    }
    this.mutations.push(`delete-bucket:${bucketName}`);
    this.buckets.delete(bucketName);
    return Promise.resolve({ data: {}, error: null });
  }

  from(bucketName: string): VectorBucketMutationClient {
    const currentBucket = (): FakeBucketState => {
      const value = this.buckets.get(bucketName);
      if (value === undefined) throw new Error(`missing bucket ${bucketName}`);
      return value;
    };
    return {
      listIndexes: () =>
        Promise.resolve({
          data: {
            indexes: [...currentBucket().indexes.keys()]
              .sort((left, right) => left.localeCompare(right, "en"))
              .map((indexName) => ({ indexName })),
          },
          error: null,
        }),
      getIndex: (indexName) => {
        const index = currentBucket().indexes.get(indexName);
        return Promise.resolve(
          index === undefined
            ? { data: null, error: { status: 404 } }
            : {
                data: {
                  index: {
                    indexName: index.indexName,
                    vectorBucketName: index.vectorBucketName,
                    dataType: index.dataType,
                    dimension: index.dimension,
                    distanceMetric: index.distanceMetric,
                    ...(index.metadataConfiguration === undefined
                      ? {}
                      : { metadataConfiguration: index.metadataConfiguration }),
                    creationTime: index.creationTime ?? 999,
                  },
                },
                error: null,
              },
        );
      },
      createIndex: (indexInput) => {
        this.mutations.push(
          `create-index:${bucketName}/${indexInput.indexName}`,
        );
        currentBucket().indexes.set(indexInput.indexName, {
          vectorBucketName: bucketName,
          indexName: indexInput.indexName,
          dataType: indexInput.dataType,
          dimension: indexInput.dimension,
          distanceMetric: indexInput.distanceMetric,
          ...(indexInput.metadataConfiguration === undefined
            ? {}
            : { metadataConfiguration: indexInput.metadataConfiguration }),
          vectors: new Map(),
        });
        return Promise.resolve({ data: {}, error: null });
      },
      deleteIndex: (indexName) => {
        this.mutations.push(`delete-index:${bucketName}/${indexName}`);
        currentBucket().indexes.delete(indexName);
        return Promise.resolve({ data: {}, error: null });
      },
      index: (indexName): VectorIndexMutationClient => {
        const currentIndex = (): FakeIndexState => {
          const value = currentBucket().indexes.get(indexName);
          if (value === undefined) {
            throw new Error(`missing index ${bucketName}/${indexName}`);
          }
          return value;
        };
        return {
          listVectors: (listOptions) => {
            const vectorIdentity = `${bucketName}\0${indexName}`;
            if (this.cycleVectorsFor === vectorIdentity) {
              return Promise.resolve({
                data: { vectors: [], nextToken: "repeat-token" },
                error: null,
              });
            }
            const values = [...currentIndex().vectors.values()].sort(
              (left, right) => left.key.localeCompare(right.key, "en"),
            );
            const offset =
              listOptions.nextToken === undefined
                ? 0
                : Number(listOptions.nextToken);
            const page = values.slice(offset, offset + listOptions.maxResults);
            const next = offset + page.length;
            return Promise.resolve({
              data: {
                vectors: page,
                ...(next < values.length ? { nextToken: String(next) } : {}),
              },
              error: null,
            });
          },
          putVectors: ({ vectors }) => {
            this.mutations.push(
              `put:${bucketName}/${indexName}:${vectors.length}`,
            );
            for (const value of vectors) {
              currentIndex().vectors.set(value.key, structuredClone(value));
            }
            return Promise.resolve({ data: {}, error: null });
          },
          deleteVectors: ({ keys }) => {
            this.mutations.push(
              `delete-vectors:${bucketName}/${indexName}:${keys.length}`,
            );
            for (const key of keys) currentIndex().vectors.delete(key);
            return Promise.resolve({ data: {}, error: null });
          },
        };
      },
    };
  }

  addBucket(name: string): FakeBucketState {
    const value: FakeBucketState = {
      vectorBucketName: name,
      creationTime: 42,
      indexes: new Map(),
    };
    this.buckets.set(name, value);
    return value;
  }

  addIndex(
    bucketName: string,
    overrides: Partial<Omit<FakeIndexState, "vectors">> = {},
  ): FakeIndexState {
    const bucket = this.buckets.get(bucketName) ?? this.addBucket(bucketName);
    const value: FakeIndexState = {
      indexName: "documents",
      vectorBucketName: bucketName,
      dataType: "float32",
      dimension: 3,
      distanceMetric: "cosine",
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["raw_text"],
      },
      creationTime: 84,
      vectors: new Map(),
      ...overrides,
    };
    bucket.indexes.set(value.indexName, value);
    return value;
  }
}

function options(
  fixture: SourceFixture,
  client: VectorMutationClient,
  conflictPolicy: "fail" | "replace",
): VectorStorageRestoreOptions {
  return {
    bundleRoot: fixture.root,
    targetProjectRef: "zyxwvutsrqponmlkjihg",
    storageKey: new SecretValue("vector-secret", new Redactor()),
    conflictPolicy,
    client,
  };
}

describe("Vector bucket restore", () => {
  it("fail policy detects extra buckets before any mutation", async () => {
    const fixture = await sourceFixture();
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addBucket("target-only");
    const handler = createVectorBucketRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(client.mutations).toEqual([]);
  });

  it("replace recursively removes extra bucket indexes before deleting the bucket", async () => {
    const fixture = await sourceFixture();
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addBucket("target-only");
    client.addIndex("target-only", { indexName: "old-index" });
    const handler = createVectorBucketRestoreHandler(
      options(fixture, client, "replace"),
    );

    const applied = await handler.apply({ action: bucketAction(), attempt: 1 });
    expect(client.mutations).toEqual([
      "delete-index:target-only/old-index",
      "delete-bucket:target-only",
    ]);
    await expect(
      handler.verify({
        action: bucketAction(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("handles a source bucket with no indexes so a skipped index action cannot hide target state", async () => {
    const fixture = await sourceFixture([], false);
    const failClient = new FakeVectorClient();
    failClient.addBucket(fixture.bucketName);
    failClient.addIndex(fixture.bucketName, { indexName: "unexpected" });
    const failHandler = createVectorBucketRestoreHandler(
      options(fixture, failClient, "fail"),
    );
    await expect(
      failHandler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(failClient.mutations).toEqual([]);

    const replaceClient = new FakeVectorClient();
    replaceClient.addBucket(fixture.bucketName);
    replaceClient.addIndex(fixture.bucketName, { indexName: "unexpected" });
    const replaceHandler = createVectorBucketRestoreHandler(
      options(fixture, replaceClient, "replace"),
    );
    await replaceHandler.apply({ action: bucketAction(), attempt: 1 });
    expect(replaceClient.mutations).toEqual([
      `delete-index:${fixture.bucketName}/unexpected`,
    ]);
    await expect(
      replaceHandler.verify({ action: bucketAction() }),
    ).resolves.toBe(true);
  });

  it("normalizes Vector API mutation failures", async () => {
    const fixture = await sourceFixture();
    const client = new FakeVectorClient();
    client.createBucket = vi.fn<VectorMutationClient["createBucket"]>(() =>
      Promise.resolve({
        data: null,
        error: { statusCode: "503", message: "provider detail" },
      }),
    );
    const handler = createVectorBucketRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: bucketAction(), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "STORAGE_SPECIALIZED_RESTORE_FAILED",
      category: "storage",
    });
  });
});

describe("Vector index restore", () => {
  it("fail policy rejects immutable index drift without deleting or creating anything", async () => {
    const fixture = await sourceFixture();
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addIndex(fixture.bucketName, { dimension: 4 });
    const handler = createVectorIndexRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: indexAction(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(client.mutations).toEqual([]);
  });

  it("replace deletes conflicting and extra indexes, then recreates source configuration", async () => {
    const fixture = await sourceFixture();
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addIndex(fixture.bucketName, { dimension: 4 });
    client.addIndex(fixture.bucketName, { indexName: "target-only" });
    const handler = createVectorIndexRestoreHandler(
      options(fixture, client, "replace"),
    );

    const applied = await handler.apply({ action: indexAction(), attempt: 1 });
    expect(client.mutations).toEqual([
      `delete-index:${fixture.bucketName}/target-only`,
      `delete-index:${fixture.bucketName}/${fixture.indexName}`,
      `create-index:${fixture.bucketName}/${fixture.indexName}`,
    ]);
    await expect(
      handler.verify({
        action: indexAction(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      handler.verify({
        action: indexAction(),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });
});

describe("Vector data restore", () => {
  it("fail policy preflights extra and conflicting vectors before any put/delete mutation", async () => {
    const fixture = await sourceFixture([vector("one", 1), vector("two", 2)]);
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    const index = client.addIndex(fixture.bucketName);
    index.vectors.set("one", vector("one", 99));
    index.vectors.set("extra", vector("extra", 7));
    const handler = createVectorRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: vectorsAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(client.mutations).toEqual([]);
  });

  it("replace deletes target-only vectors and batches 501 upserts as 500 plus 1", async () => {
    const values = Array.from({ length: 501 }, (_, index) =>
      vector(`v-${String(index).padStart(4, "0")}`, index),
    );
    const fixture = await sourceFixture(values);
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    const target = client.addIndex(fixture.bucketName);
    target.vectors.set(values[0]!.key, vector(values[0]!.key, 9999));
    target.vectors.set("target-only", vector("target-only", 123));
    const handler = createVectorRestoreHandler(
      options(fixture, client, "replace"),
    );

    const applied = await handler.apply({
      action: vectorsAction(fixture),
      attempt: 1,
    });
    expect(client.mutations).toEqual([
      `delete-vectors:${fixture.bucketName}/${fixture.indexName}:1`,
      `put:${fixture.bucketName}/${fixture.indexName}:500`,
      `put:${fixture.bucketName}/${fixture.indexName}:1`,
    ]);
    await expect(
      handler.verify({
        action: vectorsAction(fixture),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("detects target state even when a source index contains zero vectors", async () => {
    const fixture = await sourceFixture([]);
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    const index = client.addIndex(fixture.bucketName);
    index.vectors.set("unexpected", vector("unexpected", 1));
    const handler = createVectorRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: vectorsAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
  });

  it("rejects summary count tampering before target mutation", async () => {
    const fixture = await sourceFixture([vector("one", 1)]);
    const summaryPath = path.join(
      fixture.root,
      "secrets",
      "storage",
      "vector-summary.json",
    );
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      indexes: { vectorCount: number }[];
    };
    summary.indexes[0]!.vectorCount = 2;
    await writeFile(summaryPath, JSON.stringify(summary));
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addIndex(fixture.bucketName);
    const handler = createVectorRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: vectorsAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(client.mutations).toEqual([]);
  });

  it("fails closed on repeated target pagination tokens", async () => {
    const fixture = await sourceFixture([]);
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addIndex(fixture.bucketName);
    client.cycleVectorsFor = `${fixture.bucketName}\0${fixture.indexName}`;
    const handler = createVectorRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({ action: vectorsAction(fixture), attempt: 1 }),
    ).rejects.toMatchObject({ code: "STORAGE_PAGINATION_CYCLE" });
  });

  it("rejects artifact substitution and checkpoint fingerprint substitution", async () => {
    const fixture = await sourceFixture([]);
    const client = new FakeVectorClient();
    client.addBucket(fixture.bucketName);
    client.addIndex(fixture.bucketName);
    const handler = createVectorRestoreHandler(
      options(fixture, client, "fail"),
    );

    await expect(
      handler.apply({
        action: action("storage.vectors", [
          "secrets/storage/vector-summary.json",
        ]),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    await expect(
      handler.verify({
        action: vectorsAction(fixture),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });
});
