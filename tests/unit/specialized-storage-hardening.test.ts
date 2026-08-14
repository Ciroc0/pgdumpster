import { describe, expect, it } from "vitest";

import type { BundleArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import {
  captureSpecializedStorage,
  type SpecializedStorageClient,
} from "../../src/storage/specialized.js";

const ZERO_SHA = "0".repeat(64);

function memorySinks() {
  const ordinaryValues = new Map<string, Readonly<Record<string, unknown>>>();
  const protectedValues = new Map<string, Readonly<Record<string, unknown>>>();

  const ordinary: BundleArtifactSink = {
    writeJson(relativePath, value) {
      ordinaryValues.set(relativePath, value);
      return Promise.resolve({
        bytes: 0,
        sha256: ZERO_SHA,
      });
    },
    writeStream() {
      return Promise.resolve({
        bytes: 0,
        sha256: ZERO_SHA,
      });
    },
  };

  const protectedSink: ProtectedArtifactSink = {
    writeJson(relativePath, value) {
      protectedValues.set(relativePath, value);
      return Promise.resolve();
    },
  };

  return {
    ordinary,
    protectedSink,
    ordinaryValues,
    protectedValues,
  };
}

function emptyClient(): SpecializedStorageClient {
  return {
    vectors: {
      listBuckets: () =>
        Promise.resolve({
          data: { vectorBuckets: [] },
          error: null,
        }),
      getBucket: () => Promise.reject(new Error("not expected")),
      from: () => {
        throw new Error("not expected");
      },
    },
    analytics: {
      listBuckets: () =>
        Promise.resolve({
          data: [],
          error: null,
        }),
      from: () => {
        throw new Error("not expected");
      },
    },
  };
}

function analyticsBucket(name: string) {
  return {
    name,
    type: "ANALYTICS" as const,
    format: "iceberg",
    created_at: "2026-08-14T00:00:00Z",
    updated_at: "2026-08-14T00:00:00Z",
  };
}

describe("specialized Storage hardening", () => {
  it("classifies API failures by retryability without trusting malformed status values", async () => {
    const cases: {
      error: unknown;
      retryable: boolean;
    }[] = [
      {
        error: { status: 429 },
        retryable: true,
      },
      {
        error: { status: 503 },
        retryable: true,
      },
      {
        error: { status: 400 },
        retryable: false,
      },
      {
        error: "opaque-error",
        retryable: false,
      },
      {
        error: { status: "503" },
        retryable: false,
      },
    ];

    for (const testCase of cases) {
      const { ordinary, protectedSink } = memorySinks();
      const client = emptyClient();

      client.vectors.listBuckets = () =>
        Promise.resolve({
          data: null,
          error: testCase.error,
        });

      await expect(
        captureSpecializedStorage(client, ordinary, protectedSink),
      ).rejects.toMatchObject({
        code: "STORAGE_SPECIALIZED_API_FAILED",
        component: "storage.vector_buckets",
        retryable: testCase.retryable,
      });
    }
  });

  it("fails closed when a specialized API response violates its contract", async () => {
    const { ordinary, protectedSink } = memorySinks();
    const client = emptyClient();

    client.vectors.listBuckets = () =>
      Promise.resolve({
        data: {
          vectorBuckets: "not-an-array",
        },
        error: null,
      });

    await expect(
      captureSpecializedStorage(client, ordinary, protectedSink),
    ).rejects.toMatchObject({
      code: "STORAGE_SPECIALIZED_CONTRACT_CHANGED",
      component: "storage.vector_buckets",
      retryable: false,
    });
  });

  it("detects vector bucket identity drift during capture", async () => {
    const { ordinary, protectedSink } = memorySinks();
    const client = emptyClient();

    client.vectors.listBuckets = () =>
      Promise.resolve({
        data: {
          vectorBuckets: [
            {
              vectorBucketName: "expected",
            },
          ],
        },
        error: null,
      });

    client.vectors.getBucket = () =>
      Promise.resolve({
        data: {
          vectorBucket: {
            vectorBucketName: "changed",
          },
        },
        error: null,
      });

    await expect(
      captureSpecializedStorage(client, ordinary, protectedSink),
    ).rejects.toMatchObject({
      code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
      component: "storage.vector_buckets",
      retryable: true,
    });
  });

  it("detects either vector index name or bucket identity drift", async () => {
    const cases = [
      {
        indexName: "renamed",
        vectorBucketName: "bucket",
      },
      {
        indexName: "documents",
        vectorBucketName: "other-bucket",
      },
    ];

    for (const driftedIndex of cases) {
      const { ordinary, protectedSink } = memorySinks();
      const client = emptyClient();

      client.vectors.listBuckets = () =>
        Promise.resolve({
          data: {
            vectorBuckets: [
              {
                vectorBucketName: "bucket",
              },
            ],
          },
          error: null,
        });

      client.vectors.getBucket = () =>
        Promise.resolve({
          data: {
            vectorBucket: {
              vectorBucketName: "bucket",
            },
          },
          error: null,
        });

      client.vectors.from = () => ({
        listIndexes: () =>
          Promise.resolve({
            data: {
              indexes: [
                {
                  indexName: "documents",
                },
              ],
            },
            error: null,
          }),
        getIndex: () =>
          Promise.resolve({
            data: {
              index: {
                ...driftedIndex,
                dataType: "float32",
                dimension: 2,
                distanceMetric: "cosine",
              },
            },
            error: null,
          }),
        index: () => {
          throw new Error("not expected");
        },
      });

      await expect(
        captureSpecializedStorage(client, ordinary, protectedSink),
      ).rejects.toMatchObject({
        code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
        component: "storage.vector_indexes",
        retryable: true,
      });
    }
  });

  it("detects repeated vector-index pagination tokens", async () => {
    const { ordinary, protectedSink } = memorySinks();
    const client = emptyClient();

    client.vectors.listBuckets = () =>
      Promise.resolve({
        data: {
          vectorBuckets: [
            {
              vectorBucketName: "bucket",
            },
          ],
        },
        error: null,
      });

    client.vectors.getBucket = () =>
      Promise.resolve({
        data: {
          vectorBucket: {
            vectorBucketName: "bucket",
          },
        },
        error: null,
      });

    client.vectors.from = () => ({
      listIndexes: () =>
        Promise.resolve({
          data: {
            indexes: [],
            nextToken: "same-index-token",
          },
          error: null,
        }),
      getIndex: () => Promise.reject(new Error("not expected")),
      index: () => {
        throw new Error("not expected");
      },
    });

    await expect(
      captureSpecializedStorage(client, ordinary, protectedSink),
    ).rejects.toMatchObject({
      code: "STORAGE_PAGINATION_CYCLE",
      component: "storage.vector_indexes",
    });
  });

  it("detects repeated vector-data pagination tokens", async () => {
    const { ordinary, protectedSink } = memorySinks();
    const client = emptyClient();

    client.vectors.listBuckets = () =>
      Promise.resolve({
        data: {
          vectorBuckets: [
            {
              vectorBucketName: "bucket",
            },
          ],
        },
        error: null,
      });

    client.vectors.getBucket = () =>
      Promise.resolve({
        data: {
          vectorBucket: {
            vectorBucketName: "bucket",
          },
        },
        error: null,
      });

    client.vectors.from = () => ({
      listIndexes: () =>
        Promise.resolve({
          data: {
            indexes: [
              {
                indexName: "documents",
              },
            ],
          },
          error: null,
        }),
      getIndex: () =>
        Promise.resolve({
          data: {
            index: {
              indexName: "documents",
              vectorBucketName: "bucket",
              dataType: "float32",
              dimension: 2,
              distanceMetric: "cosine",
            },
          },
          error: null,
        }),
      index: () => ({
        listVectors: () =>
          Promise.resolve({
            data: {
              vectors: [],
              nextToken: "same-vector-token",
            },
            error: null,
          }),
      }),
    });

    await expect(
      captureSpecializedStorage(client, ordinary, protectedSink),
    ).rejects.toMatchObject({
      code: "STORAGE_PAGINATION_CYCLE",
      component: "storage.vectors",
    });
  });

  it("sorts captured vector buckets and indexes deterministically", async () => {
    const { ordinary, protectedSink, ordinaryValues } = memorySinks();

    const client = emptyClient();

    client.vectors.listBuckets = () =>
      Promise.resolve({
        data: {
          vectorBuckets: [
            {
              vectorBucketName: "bucket-z",
            },
            {
              vectorBucketName: "bucket-a",
            },
          ],
        },
        error: null,
      });

    client.vectors.getBucket = (bucketName) =>
      Promise.resolve({
        data: {
          vectorBucket: {
            vectorBucketName: bucketName,
          },
        },
        error: null,
      });

    client.vectors.from = (bucketName) => ({
      listIndexes: () =>
        Promise.resolve({
          data: {
            indexes:
              bucketName === "bucket-a"
                ? [
                    {
                      indexName: "index-z",
                    },
                    {
                      indexName: "index-a",
                    },
                  ]
                : [
                    {
                      indexName: "index-m",
                    },
                  ],
          },
          error: null,
        }),
      getIndex: (indexName) =>
        Promise.resolve({
          data: {
            index: {
              indexName,
              vectorBucketName: bucketName,
              dataType: "float32",
              dimension: 2,
              distanceMetric: "cosine",
            },
          },
          error: null,
        }),
      index: () => ({
        listVectors: () =>
          Promise.resolve({
            data: {
              vectors: [],
            },
            error: null,
          }),
      }),
    });

    await captureSpecializedStorage(client, ordinary, protectedSink);

    const buckets = ordinaryValues.get("storage/vector-buckets.json") as {
      buckets: {
        vectorBucketName: string;
      }[];
    };

    expect(
      buckets.buckets.map(({ vectorBucketName }) => vectorBucketName),
    ).toEqual(["bucket-a", "bucket-z"]);

    const indexes = ordinaryValues.get("storage/vector-indexes.json") as {
      indexes: {
        vectorBucketName: string;
        indexName: string;
      }[];
    };

    expect(
      indexes.indexes.map(
        ({ vectorBucketName, indexName }) => `${vectorBucketName}/${indexName}`,
      ),
    ).toEqual(["bucket-a/index-a", "bucket-a/index-z", "bucket-z/index-m"]);
  });

  it("deduplicates and deterministically sorts Analytics namespaces", async () => {
    const { ordinary, protectedSink, ordinaryValues } = memorySinks();

    const client = emptyClient();

    client.analytics.listBuckets = () =>
      Promise.resolve({
        data: [analyticsBucket("warehouse")],
        error: null,
      });

    client.analytics.from = () => ({
      listNamespaces: (parent) =>
        Promise.resolve({
          data:
            parent === undefined
              ? [
                  {
                    namespace: ["zeta"],
                  },
                  {
                    namespace: ["alpha"],
                  },
                  {
                    namespace: ["zeta"],
                  },
                ]
              : [],
          error: null,
        }),
      loadNamespaceMetadata: () =>
        Promise.resolve({
          data: {
            properties: {},
          },
          error: null,
        }),
      listTables: () =>
        Promise.resolve({
          data: [],
          error: null,
        }),
      loadTable: () => Promise.reject(new Error("not expected")),
    });

    const result = await captureSpecializedStorage(
      client,
      ordinary,
      protectedSink,
    );

    const catalogArtifact = result.coverage[3]!.artifacts.find((artifact) =>
      artifact.startsWith("storage/analytics-catalog/"),
    );

    expect(catalogArtifact).toBeDefined();

    const catalog = ordinaryValues.get(catalogArtifact!) as {
      namespaces: {
        namespace: string[];
      }[];
    };

    expect(catalog.namespaces.map(({ namespace }) => namespace)).toEqual([
      ["alpha"],
      ["zeta"],
    ]);
  });

  it("continues Analytics pagination after a full page", async () => {
    const { ordinary, protectedSink } = memorySinks();
    const client = emptyClient();

    const offsets: number[] = [];

    client.analytics.listBuckets = (options) => {
      offsets.push(options.offset);

      return Promise.resolve({
        data:
          options.offset === 0
            ? Array.from({ length: 100 }, (_, index) =>
                analyticsBucket(`warehouse-${String(index).padStart(3, "0")}`),
              )
            : [analyticsBucket("warehouse-final")],
        error: null,
      });
    };

    client.analytics.from = () => ({
      listNamespaces: () =>
        Promise.resolve({
          data: [],
          error: null,
        }),
      loadNamespaceMetadata: () => Promise.reject(new Error("not expected")),
      listTables: () => Promise.reject(new Error("not expected")),
      loadTable: () => Promise.reject(new Error("not expected")),
    });

    const result = await captureSpecializedStorage(
      client,
      ordinary,
      protectedSink,
    );

    expect(offsets).toEqual([0, 100]);

    expect(result.coverage[3]).toMatchObject({
      id: "storage.analytics_catalog",
      status: "backed_up",
    });

    expect(result.coverage[3]!.artifacts).toHaveLength(102);
  });

  it("honors an already-aborted signal before specialized API access", async () => {
    const { ordinary, protectedSink } = memorySinks();

    let vectorCalls = 0;
    let analyticsCalls = 0;

    const client = emptyClient();

    client.vectors.listBuckets = () => {
      vectorCalls += 1;

      return Promise.resolve({
        data: {
          vectorBuckets: [],
        },
        error: null,
      });
    };

    client.analytics.listBuckets = () => {
      analyticsCalls += 1;

      return Promise.resolve({
        data: [],
        error: null,
      });
    };

    const controller = new AbortController();
    controller.abort();

    await expect(
      captureSpecializedStorage(
        client,
        ordinary,
        protectedSink,
        controller.signal,
      ),
    ).rejects.toBeDefined();

    expect(vectorCalls).toBe(0);
    expect(analyticsCalls).toBe(0);
  });
});
