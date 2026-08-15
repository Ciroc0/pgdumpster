import { createHash } from "node:crypto";

import { z } from "zod";

import type { BundleArtifactSink } from "../core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../core/bundle/schemas.js";
import { PgDumpsterError } from "../core/errors/error.js";
import type { ProtectedArtifactSink } from "../security/protected-artifact.js";

type CoverageEntry = CoverageDocument["components"][number];

interface ApiResult<T> {
  data: T | null;
  error: unknown;
}

interface VectorIndexClient {
  listVectors(options: {
    maxResults: number;
    nextToken?: string;
    returnData: true;
    returnMetadata: true;
  }): Promise<ApiResult<unknown>>;
}

interface VectorBucketClient {
  listIndexes(options: {
    maxResults: number;
    nextToken?: string;
  }): Promise<ApiResult<unknown>>;
  getIndex(indexName: string): Promise<ApiResult<unknown>>;
  index(indexName: string): VectorIndexClient;
}

interface VectorClient {
  listBuckets(options: {
    maxResults: number;
    nextToken?: string;
  }): Promise<ApiResult<unknown>>;
  getBucket(bucketName: string): Promise<ApiResult<unknown>>;
  from(bucketName: string): VectorBucketClient;
}

interface CatalogClient {
  listNamespaces(parent?: { namespace: string[] }): Promise<ApiResult<unknown>>;
  loadNamespaceMetadata(identifier: {
    namespace: string[];
  }): Promise<ApiResult<unknown>>;
  listTables(identifier: { namespace: string[] }): Promise<ApiResult<unknown>>;
  loadTable(identifier: {
    namespace: string[];
    name: string;
  }): Promise<ApiResult<unknown>>;
}

interface AnalyticsClient {
  listBuckets(options: {
    limit: number;
    offset: number;
    sortColumn: "name";
    sortOrder: "asc";
  }): Promise<ApiResult<unknown>>;
  from(bucketName: string): CatalogClient;
}

export interface SpecializedStorageClient {
  vectors: VectorClient;
  analytics: AnalyticsClient;
}

const vectorBucketNameSchema = z
  .object({ vectorBucketName: z.string().min(1) })
  .passthrough();
const vectorBucketListSchema = z
  .object({
    vectorBuckets: vectorBucketNameSchema.array(),
    nextToken: z.string().min(1).optional(),
  })
  .passthrough();
const vectorBucketSchema = z
  .object({
    vectorBucket: z
      .object({
        vectorBucketName: z.string().min(1),
        creationTime: z.number().finite().optional(),
        encryptionConfiguration: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const vectorIndexNameSchema = z
  .object({ indexName: z.string().min(1) })
  .passthrough();
const vectorIndexListSchema = z
  .object({
    indexes: vectorIndexNameSchema.array(),
    nextToken: z.string().min(1).optional(),
  })
  .passthrough();
const vectorIndexSchema = z
  .object({
    index: z
      .object({
        indexName: z.string().min(1),
        vectorBucketName: z.string().min(1),
        dataType: z.string().min(1),
        dimension: z.number().int().positive(),
        distanceMetric: z.string().min(1),
        metadataConfiguration: z.unknown().optional(),
        creationTime: z.number().finite().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const vectorSchema = z
  .object({
    key: z.string().min(1),
    data: z.object({ float32: z.number().finite().array() }).passthrough(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const vectorListSchema = z
  .object({
    vectors: vectorSchema.array(),
    nextToken: z.string().min(1).optional(),
  })
  .passthrough();
const analyticsBucketSchema = z
  .object({
    name: z.string().min(1),
    type: z.literal("ANALYTICS"),
    format: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .passthrough();
const namespaceSchema = z
  .object({ namespace: z.string().array() })
  .passthrough();
const tableIdentifierSchema = z
  .object({ namespace: z.string().array(), name: z.string().min(1) })
  .passthrough();

const VECTOR_SOURCE = {
  adapter: "storage-vector-api",
  sdk: "@supabase/storage-js@2.111.0",
  documentation:
    "https://supabase.com/docs/reference/javascript/vector-buckets",
  stability: "alpha",
} as const;
const ANALYTICS_SOURCE = {
  adapter: "storage-iceberg-api",
  sdk: "@supabase/storage-js@2.111.0",
  documentation:
    "https://supabase.com/docs/guides/storage/analytics/connecting-to-analytics-bucket",
  stability: "alpha",
} as const;
const ANALYTICS_RESTORE_LIMIT = {
  ...ANALYTICS_SOURCE,
  restoreFidelity: "not_identically_restorable",
} as const;

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const status = Reflect.get(error, "status") as unknown;
  return typeof status === "number" ? status : undefined;
}

function unwrap<T>(
  result: ApiResult<unknown>,
  schema: z.ZodType<T>,
  component: string,
): T {
  if (result.error !== null) {
    throw new PgDumpsterError({
      code: "STORAGE_SPECIALIZED_API_FAILED",
      category: "storage",
      message: "Supabase specialized Storage API request failed.",
      retryable:
        errorStatus(result.error) === 429 ||
        (errorStatus(result.error) ?? 0) >= 500,
      component,
      details: { status: errorStatus(result.error) },
    });
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw new PgDumpsterError({
      code: "STORAGE_SPECIALIZED_CONTRACT_CHANGED",
      category: "platform_contract",
      message:
        "Supabase specialized Storage API response no longer matches its current contract.",
      retryable: false,
      component,
    });
  }
  return parsed.data;
}

function nextPage(
  token: string | undefined,
  seen: Set<string>,
  component: string,
): string | undefined {
  if (token === undefined) return undefined;
  if (seen.has(token)) {
    throw new PgDumpsterError({
      code: "STORAGE_PAGINATION_CYCLE",
      category: "storage",
      message: "Supabase Storage returned a repeated pagination token.",
      retryable: false,
      component,
    });
  }
  seen.add(token);
  return token;
}

async function captureVectors(
  client: VectorClient,
  ordinary: BundleArtifactSink,
  protectedSink: ProtectedArtifactSink,
  signal?: AbortSignal,
): Promise<CoverageEntry[]> {
  const buckets: unknown[] = [];
  const seenBucketTokens = new Set<string>();
  let bucketToken: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = unwrap(
      await client.listBuckets({
        maxResults: 100,
        ...(bucketToken === undefined ? {} : { nextToken: bucketToken }),
      }),
      vectorBucketListSchema,
      "storage.vector_buckets",
    );
    for (const listed of page.vectorBuckets) {
      const detail = unwrap(
        await client.getBucket(listed.vectorBucketName),
        vectorBucketSchema,
        "storage.vector_buckets",
      );
      if (detail.vectorBucket.vectorBucketName !== listed.vectorBucketName) {
        throw new PgDumpsterError({
          code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
          category: "consistency",
          message: "Vector bucket identity changed during capture.",
          retryable: true,
          component: "storage.vector_buckets",
        });
      }
      buckets.push(detail.vectorBucket);
    }
    bucketToken = nextPage(
      page.nextToken,
      seenBucketTokens,
      "storage.vector_buckets",
    );
  } while (bucketToken !== undefined);
  buckets.sort((left, right) =>
    String(Reflect.get(left as object, "vectorBucketName")).localeCompare(
      String(Reflect.get(right as object, "vectorBucketName")),
      "en",
    ),
  );
  const bucketArtifact = "storage/vector-buckets.json";
  await ordinary.writeJson(
    bucketArtifact,
    { schemaVersion: 1, buckets },
    signal,
  );

  const indexes: unknown[] = [];
  const vectorArtifacts: string[] = [];
  const vectorSummaries: Record<string, unknown>[] = [];
  for (const bucket of vectorBucketListSchema.shape.vectorBuckets.parse(
    buckets,
  )) {
    const bucketName = bucket.vectorBucketName;
    const bucketClient = client.from(bucketName);
    const seenIndexTokens = new Set<string>();
    let indexToken: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = unwrap(
        await bucketClient.listIndexes({
          maxResults: 100,
          ...(indexToken === undefined ? {} : { nextToken: indexToken }),
        }),
        vectorIndexListSchema,
        "storage.vector_indexes",
      );
      for (const listed of page.indexes) {
        const detail = unwrap(
          await bucketClient.getIndex(listed.indexName),
          vectorIndexSchema,
          "storage.vector_indexes",
        );
        if (
          detail.index.indexName !== listed.indexName ||
          detail.index.vectorBucketName !== bucketName
        ) {
          throw new PgDumpsterError({
            code: "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
            category: "consistency",
            message: "Vector index identity changed during capture.",
            retryable: true,
            component: "storage.vector_indexes",
          });
        }
        indexes.push(detail.index);

        const indexClient = bucketClient.index(listed.indexName);
        const seenVectorTokens = new Set<string>();
        let vectorToken: string | undefined;
        let pageNumber = 0;
        let vectorCount = 0;
        do {
          signal?.throwIfAborted();
          const vectorPage = unwrap(
            await indexClient.listVectors({
              maxResults: 1000,
              returnData: true,
              returnMetadata: true,
              ...(vectorToken === undefined ? {} : { nextToken: vectorToken }),
            }),
            vectorListSchema,
            "storage.vectors",
          );
          pageNumber += 1;
          vectorCount += vectorPage.vectors.length;
          const artifact = `secrets/storage/vectors/${stableId(bucketName, listed.indexName)}/${String(pageNumber).padStart(8, "0")}.json`;
          await protectedSink.writeJson(
            artifact,
            {
              schemaVersion: 1,
              bucketName,
              indexName: listed.indexName,
              vectors: vectorPage.vectors,
            },
            signal,
          );
          vectorArtifacts.push(artifact);
          vectorToken = nextPage(
            vectorPage.nextToken,
            seenVectorTokens,
            "storage.vectors",
          );
        } while (vectorToken !== undefined);
        vectorSummaries.push({
          bucketName,
          indexName: listed.indexName,
          vectorCount,
          pageCount: pageNumber,
        });
      }
      indexToken = nextPage(
        page.nextToken,
        seenIndexTokens,
        "storage.vector_indexes",
      );
    } while (indexToken !== undefined);
  }
  indexes.sort((left, right) =>
    `${String(Reflect.get(left as object, "vectorBucketName"))}\0${String(Reflect.get(left as object, "indexName"))}`.localeCompare(
      `${String(Reflect.get(right as object, "vectorBucketName"))}\0${String(Reflect.get(right as object, "indexName"))}`,
      "en",
    ),
  );
  const indexArtifact = "storage/vector-indexes.json";
  await ordinary.writeJson(
    indexArtifact,
    { schemaVersion: 1, indexes },
    signal,
  );
  const vectorSummaryArtifact = "secrets/storage/vector-summary.json";
  await protectedSink.writeJson(
    vectorSummaryArtifact,
    { schemaVersion: 1, indexes: vectorSummaries },
    signal,
  );

  return [
    {
      id: "storage.vector_buckets",
      status: buckets.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "sensitive",
      artifacts: [bucketArtifact],
      sourceContract: VECTOR_SOURCE,
    },
    {
      id: "storage.vector_indexes",
      status: indexes.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "sensitive",
      artifacts: [indexArtifact],
      sourceContract: VECTOR_SOURCE,
    },
    {
      id: "storage.vectors",
      status: indexes.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "secret",
      artifacts: [vectorSummaryArtifact, ...vectorArtifacts],
      sourceContract: VECTOR_SOURCE,
    },
  ];
}

async function captureAnalytics(
  client: AnalyticsClient,
  ordinary: BundleArtifactSink,
  signal?: AbortSignal,
): Promise<CoverageEntry[]> {
  const buckets: z.infer<typeof analyticsBucketSchema>[] = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    signal?.throwIfAborted();
    const page = unwrap(
      await client.listBuckets({
        limit: pageSize,
        offset,
        sortColumn: "name",
        sortOrder: "asc",
      }),
      analyticsBucketSchema.array(),
      "storage.analytics_catalog",
    );
    buckets.push(...page);
    if (page.length < pageSize) break;
  }
  const bucketArtifact = "storage/analytics-buckets.json";
  await ordinary.writeJson(
    bucketArtifact,
    { schemaVersion: 1, buckets },
    signal,
  );

  const catalogArtifacts: string[] = [bucketArtifact];
  for (const bucket of buckets) {
    const catalog = client.from(bucket.name);
    const namespaces: {
      namespace: string[];
      properties: unknown;
      tables: unknown[];
    }[] = [];
    const queue: string[][] = [[]];
    const seen = new Set<string>();
    while (queue.length > 0) {
      signal?.throwIfAborted();
      const parent = queue.shift()!;
      const listed = unwrap(
        await catalog.listNamespaces(
          parent.length === 0 ? undefined : { namespace: parent },
        ),
        namespaceSchema.array(),
        "storage.analytics_catalog",
      );
      for (const item of listed) {
        const identity = JSON.stringify(item.namespace);
        if (seen.has(identity)) continue;
        seen.add(identity);
        queue.push(item.namespace);
        const properties = unwrap(
          await catalog.loadNamespaceMetadata({ namespace: item.namespace }),
          z
            .object({ properties: z.record(z.string(), z.string()) })
            .passthrough(),
          "storage.analytics_catalog",
        );
        const identifiers = unwrap(
          await catalog.listTables({ namespace: item.namespace }),
          tableIdentifierSchema.array(),
          "storage.analytics_catalog",
        );
        const tables: unknown[] = [];
        for (const identifier of identifiers) {
          tables.push(
            unwrap(
              await catalog.loadTable(identifier),
              z.record(z.string(), z.unknown()),
              "storage.analytics_catalog",
            ),
          );
        }
        namespaces.push({ namespace: item.namespace, properties, tables });
      }
    }
    namespaces.sort((left, right) =>
      JSON.stringify(left.namespace).localeCompare(
        JSON.stringify(right.namespace),
        "en",
      ),
    );
    const artifact = `storage/analytics-catalog/${stableId(bucket.name)}.json`;
    await ordinary.writeJson(
      artifact,
      { schemaVersion: 1, bucket, namespaces },
      signal,
    );
    catalogArtifacts.push(artifact);
  }

  return [
    {
      id: "storage.analytics_catalog",
      status: buckets.length === 0 ? "not_configured" : "backed_up",
      ...(buckets.length === 0
        ? {}
        : {
            reasonCode: "analytics_s3_data_export_required",
            message:
              "Iceberg catalog metadata is captured, but its referenced table-data files are unavailable without separate S3 credentials; automatic semantic restore is therefore not possible.",
          }),
      sensitivity: "sensitive",
      artifacts: catalogArtifacts,
      sourceContract:
        buckets.length === 0 ? ANALYTICS_SOURCE : ANALYTICS_RESTORE_LIMIT,
    },
    buckets.length === 0
      ? {
          id: "storage.analytics_data",
          status: "not_configured",
          sensitivity: "secret",
          artifacts: [],
          sourceContract: ANALYTICS_SOURCE,
        }
      : {
          id: "storage.analytics_data",
          status: "not_exportable",
          reasonCode: "analytics_s3_data_export_required",
          sensitivity: "secret",
          artifacts: [],
          message:
            "Iceberg catalog metadata is captured, but complete Parquet data export requires separate Supabase S3 credentials.",
          sourceContract: ANALYTICS_SOURCE,
        },
  ];
}

export async function captureSpecializedStorage(
  client: SpecializedStorageClient,
  ordinary: BundleArtifactSink,
  protectedSink: ProtectedArtifactSink,
  signal?: AbortSignal,
): Promise<{ coverage: CoverageEntry[] }> {
  const [vectors, analytics] = await Promise.all([
    captureVectors(client.vectors, ordinary, protectedSink, signal),
    captureAnalytics(client.analytics, ordinary, signal),
  ]);
  return { coverage: [...vectors, ...analytics] };
}
