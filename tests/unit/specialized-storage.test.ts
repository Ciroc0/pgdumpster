import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDirectoryArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import { createPlaintextProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import {
  captureSpecializedStorage,
  type SpecializedStorageClient,
} from "../../src/storage/specialized.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sinks() {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-specialized-"));
  temporaryDirectories.push(root);
  return {
    root,
    ordinary: await createDirectoryArtifactSink(root),
    protectedSink: await createPlaintextProtectedArtifactSink(root, {
      allowPlaintextSecrets: true,
    }),
  };
}

function emptyClient(): SpecializedStorageClient {
  return {
    vectors: {
      listBuckets: () =>
        Promise.resolve({ data: { vectorBuckets: [] }, error: null }),
      getBucket: () => Promise.reject(new Error("not expected")),
      from: () => {
        throw new Error("not expected");
      },
    },
    analytics: {
      listBuckets: () => Promise.resolve({ data: [], error: null }),
      from: () => {
        throw new Error("not expected");
      },
    },
  };
}

describe("specialized Storage capture", () => {
  it("records explicit empty Vector and Analytics inventories", async () => {
    const { root, ordinary, protectedSink } = await sinks();
    const result = await captureSpecializedStorage(
      emptyClient(),
      ordinary,
      protectedSink,
    );

    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "storage.vector_buckets", status: "not_configured" },
      { id: "storage.vector_indexes", status: "not_configured" },
      { id: "storage.vectors", status: "not_configured" },
      { id: "storage.analytics_catalog", status: "not_configured" },
      { id: "storage.analytics_data", status: "not_configured" },
    ]);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "storage", "vector-buckets.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ buckets: [] });
  });

  it("paginates and captures complete vector data and metadata in protected artifacts", async () => {
    const { root, ordinary, protectedSink } = await sinks();
    let bucketPage = 0;
    let vectorPage = 0;
    const client: SpecializedStorageClient = {
      ...emptyClient(),
      vectors: {
        listBuckets: () => {
          bucketPage += 1;
          return Promise.resolve({
            data:
              bucketPage === 1
                ? {
                    vectorBuckets: [{ vectorBucketName: "embeddings" }],
                    nextToken: "bucket-page-2",
                  }
                : { vectorBuckets: [] },
            error: null,
          });
        },
        getBucket: () =>
          Promise.resolve({
            data: {
              vectorBucket: {
                vectorBucketName: "embeddings",
                creationTime: 1,
              },
            },
            error: null,
          }),
        from: () => ({
          listIndexes: () =>
            Promise.resolve({
              data: { indexes: [{ indexName: "documents" }] },
              error: null,
            }),
          getIndex: () =>
            Promise.resolve({
              data: {
                index: {
                  vectorBucketName: "embeddings",
                  indexName: "documents",
                  dataType: "float32",
                  dimension: 2,
                  distanceMetric: "cosine",
                },
              },
              error: null,
            }),
          index: () => ({
            listVectors: () => {
              vectorPage += 1;
              return Promise.resolve({
                data:
                  vectorPage === 1
                    ? {
                        vectors: [
                          {
                            key: "one",
                            data: { float32: [0.1, 0.2] },
                            metadata: { label: "secret metadata" },
                          },
                        ],
                        nextToken: "vector-page-2",
                      }
                    : {
                        vectors: [
                          { key: "two", data: { float32: [0.3, 0.4] } },
                        ],
                      },
                error: null,
              });
            },
          }),
        }),
      },
    };

    const result = await captureSpecializedStorage(
      client,
      ordinary,
      protectedSink,
    );
    expect(result.coverage.slice(0, 3).map(({ status }) => status)).toEqual([
      "backed_up",
      "backed_up",
      "backed_up",
    ]);
    const vectorCoverage = result.coverage[2]!;
    expect(vectorCoverage.artifacts).toHaveLength(3);
    const page = vectorCoverage.artifacts.find((artifact) =>
      artifact.endsWith("00000001.json"),
    )!;
    expect(
      await readFile(path.join(root, ...page.split("/")), "utf8"),
    ).toContain("secret metadata");
  });

  it("captures the Iceberg catalog but fails full data coverage without the separate S3 export", async () => {
    const { root, ordinary, protectedSink } = await sinks();
    const client: SpecializedStorageClient = {
      ...emptyClient(),
      analytics: {
        listBuckets: () =>
          Promise.resolve({
            data: [
              {
                name: "warehouse",
                type: "ANALYTICS",
                format: "iceberg",
                created_at: "2026-08-14T00:00:00Z",
                updated_at: "2026-08-14T00:00:00Z",
              },
            ],
            error: null,
          }),
        from: () => ({
          listNamespaces: (parent) =>
            Promise.resolve({
              data: parent === undefined ? [{ namespace: ["default"] }] : [],
              error: null,
            }),
          loadNamespaceMetadata: () =>
            Promise.resolve({
              data: { properties: { owner: "data" } },
              error: null,
            }),
          listTables: () =>
            Promise.resolve({
              data: [{ namespace: ["default"], name: "events" }],
              error: null,
            }),
          loadTable: () =>
            Promise.resolve({
              data: {
                "current-snapshot-id": 123,
                location: "s3://warehouse/events",
              },
              error: null,
            }),
        }),
      },
    };

    const result = await captureSpecializedStorage(
      client,
      ordinary,
      protectedSink,
    );
    expect(result.coverage.slice(3)).toMatchObject([
      {
        id: "storage.analytics_catalog",
        status: "backed_up",
        reasonCode: "analytics_s3_data_export_required",
        sourceContract: { restoreFidelity: "not_identically_restorable" },
      },
      {
        id: "storage.analytics_data",
        status: "not_exportable",
        reasonCode: "analytics_s3_data_export_required",
      },
    ]);
    const catalogArtifact = result.coverage[3]!.artifacts[1]!;
    expect(
      await readFile(path.join(root, ...catalogArtifact.split("/")), "utf8"),
    ).toContain("current-snapshot-id");
  });

  it("rejects repeated pagination tokens", async () => {
    const { ordinary, protectedSink } = await sinks();
    const client = emptyClient();
    client.vectors.listBuckets = () =>
      Promise.resolve({
        data: { vectorBuckets: [], nextToken: "same" },
        error: null,
      });

    await expect(
      captureSpecializedStorage(client, ordinary, protectedSink),
    ).rejects.toMatchObject({ code: "STORAGE_PAGINATION_CYCLE" });
  });
});
