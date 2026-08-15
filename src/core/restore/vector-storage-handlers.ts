import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { StorageClient } from "@supabase/storage-js";
import { z } from "zod";

import type { SecretValue } from "../../security/secret-value.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

type VectorRestoreComponent =
  "storage.vector_buckets" | "storage.vector_indexes" | "storage.vectors";

interface ApiResult<T = unknown> {
  data: T | null;
  error: unknown;
}

export interface VectorValue {
  key: string;
  data: { float32: number[] };
  metadata?: Record<string, unknown> | undefined;
}

export interface VectorIndexMutationClient {
  listVectors(options: {
    maxResults: number;
    nextToken?: string | undefined;
    returnData: true;
    returnMetadata: true;
  }): Promise<ApiResult>;
  putVectors(options: { vectors: VectorValue[] }): Promise<ApiResult>;
  deleteVectors(options: { keys: string[] }): Promise<ApiResult>;
}

export interface VectorBucketMutationClient {
  listIndexes(options: {
    maxResults: number;
    nextToken?: string | undefined;
  }): Promise<ApiResult>;
  getIndex(indexName: string): Promise<ApiResult>;
  createIndex(options: {
    indexName: string;
    dataType: string;
    dimension: number;
    distanceMetric: string;
    metadataConfiguration?: unknown;
  }): Promise<ApiResult>;
  deleteIndex(indexName: string): Promise<ApiResult>;
  index(indexName: string): VectorIndexMutationClient;
}

export interface VectorMutationClient {
  listBuckets(options: {
    maxResults: number;
    nextToken?: string | undefined;
  }): Promise<ApiResult>;
  getBucket(bucketName: string): Promise<ApiResult>;
  createBucket(bucketName: string): Promise<ApiResult>;
  deleteBucket(bucketName: string): Promise<ApiResult>;
  from(bucketName: string): VectorBucketMutationClient;
}

export interface VectorStorageRestoreOptions {
  bundleRoot: string;
  targetProjectRef: string;
  storageKey: SecretValue;
  conflictPolicy: "fail" | "replace";
  client?: VectorMutationClient | undefined;
}

const BUCKET_ARTIFACT = "storage/vector-buckets.json";
const INDEX_ARTIFACT = "storage/vector-indexes.json";
const SUMMARY_ARTIFACT = "secrets/storage/vector-summary.json";
const MUTATION_BATCH_SIZE = 500;
const MAX_ARTIFACT_BYTES = 67_108_864;

const bucketSchema = z
  .object({
    vectorBucketName: z.string().min(1),
    creationTime: z.number().finite().optional(),
    encryptionConfiguration: z.unknown().optional(),
  })
  .passthrough();
const bucketDocumentSchema = z
  .object({ schemaVersion: z.literal(1), buckets: z.array(bucketSchema) })
  .strict();
const bucketListSchema = z
  .object({
    vectorBuckets: z.array(
      z.object({ vectorBucketName: z.string().min(1) }).passthrough(),
    ),
    nextToken: z.string().min(1).optional(),
  })
  .passthrough();
const bucketDetailSchema = z
  .object({ vectorBucket: bucketSchema })
  .passthrough();

const indexSchema = z
  .object({
    indexName: z.string().min(1),
    vectorBucketName: z.string().min(1),
    dataType: z.string().min(1),
    dimension: z.number().int().positive(),
    distanceMetric: z.string().min(1),
    metadataConfiguration: z.unknown().optional(),
    creationTime: z.number().finite().optional(),
  })
  .passthrough();
const indexDocumentSchema = z
  .object({ schemaVersion: z.literal(1), indexes: z.array(indexSchema) })
  .strict();
const indexListSchema = z
  .object({
    indexes: z.array(z.object({ indexName: z.string().min(1) }).passthrough()),
    nextToken: z.string().min(1).optional(),
  })
  .passthrough();
const indexDetailSchema = z.object({ index: indexSchema }).passthrough();

const vectorSchema = z
  .object({
    key: z.string().min(1),
    data: z.object({ float32: z.array(z.number().finite()) }).passthrough(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const vectorListSchema = z
  .object({
    vectors: z.array(vectorSchema),
    nextToken: z.string().min(1).optional(),
  })
  .passthrough();
const summarySchema = z
  .object({
    schemaVersion: z.literal(1),
    indexes: z.array(
      z
        .object({
          bucketName: z.string().min(1),
          indexName: z.string().min(1),
          vectorCount: z.number().int().nonnegative(),
          pageCount: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
const vectorPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    bucketName: z.string().min(1),
    indexName: z.string().min(1),
    vectors: z.array(vectorSchema),
  })
  .strict();

type VectorBucket = z.infer<typeof bucketSchema>;
type VectorIndex = z.infer<typeof indexSchema>;
type VectorSummary = z.infer<typeof summarySchema>;

interface IndexedVector extends VectorValue {
  bucketName: string;
  indexName: string;
}

interface SourceVectorBundle {
  indexes: VectorSummary["indexes"];
  vectors: IndexedVector[];
}

function restoreError(
  code: string,
  category: "restore_policy" | "integrity" | "storage" | "platform_contract",
  message: string,
  component: VectorRestoreComponent,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category,
    message,
    retryable: false,
    component,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const status = Reflect.get(error, "status") as unknown;
  if (typeof status === "number") return status;
  const statusCode = Reflect.get(error, "statusCode") as unknown;
  if (typeof statusCode === "number") return statusCode;
  if (typeof statusCode === "string" && /^[1-5][0-9]{2}$/u.test(statusCode))
    return Number(statusCode);
  return undefined;
}

function unwrap<T>(
  result: ApiResult,
  schema: z.ZodType<T>,
  component: VectorRestoreComponent,
): T {
  if (result.error !== null) {
    throw restoreError(
      "STORAGE_SPECIALIZED_RESTORE_FAILED",
      "storage",
      "Supabase Vector Storage restore API request failed.",
      component,
      { status: errorStatus(result.error) },
    );
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw restoreError(
      "STORAGE_SPECIALIZED_CONTRACT_CHANGED",
      "platform_contract",
      "Supabase Vector Storage API response no longer matches the expected contract.",
      component,
    );
  }
  return parsed.data;
}

function requireSuccess(
  result: ApiResult,
  component: VectorRestoreComponent,
): void {
  if (result.error !== null) {
    throw restoreError(
      "STORAGE_SPECIALIZED_RESTORE_FAILED",
      "storage",
      "Supabase Vector Storage restore mutation failed.",
      component,
      { status: errorStatus(result.error) },
    );
  }
}

function defaultClient(
  options: VectorStorageRestoreOptions,
): VectorMutationClient {
  const key = options.storageKey.expose();
  const storage = new StorageClient(
    `https://${options.targetProjectRef}.supabase.co/storage/v1`,
    { apikey: key, authorization: `Bearer ${key}` },
  );
  return storage.vectors as unknown as VectorMutationClient;
}

async function readJson<T>(
  options: VectorStorageRestoreOptions,
  artifact: string,
  schema: z.ZodType<T>,
  component: VectorRestoreComponent,
): Promise<T> {
  const filename = await resolveBundleArtifact(options.bundleRoot, artifact);
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0 ||
    stat.size > MAX_ARTIFACT_BYTES
  ) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Vector restore artifact is not a bounded regular file.",
      component,
    );
  }
  try {
    return schema.parse(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Vector restore artifact failed validation.",
      component,
      undefined,
      error,
    );
  }
}

function assertArtifacts(
  actual: readonly string[],
  expected: readonly string[],
  component: VectorRestoreComponent,
): void {
  if (
    canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())
  ) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "restore_policy",
      "Restore action artifacts do not match the Vector Storage component.",
      component,
    );
  }
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function nextToken(
  token: string | undefined,
  seen: Set<string>,
  component: VectorRestoreComponent,
): string | undefined {
  if (token === undefined) return undefined;
  if (seen.has(token)) {
    throw restoreError(
      "STORAGE_PAGINATION_CYCLE",
      "storage",
      "Supabase Vector Storage returned a repeated pagination token.",
      component,
    );
  }
  seen.add(token);
  return token;
}

function normalizedIndex(index: VectorIndex) {
  return {
    vectorBucketName: index.vectorBucketName,
    indexName: index.indexName,
    dataType: index.dataType,
    dimension: index.dimension,
    distanceMetric: index.distanceMetric,
    ...(index.metadataConfiguration === undefined
      ? {}
      : { metadataConfiguration: index.metadataConfiguration }),
  };
}

function indexIdentity(index: VectorIndex): string {
  return `${index.vectorBucketName}\0${index.indexName}`;
}

function indexEqual(left: VectorIndex, right: VectorIndex): boolean {
  return (
    canonicalJson(normalizedIndex(left)) ===
    canonicalJson(normalizedIndex(right))
  );
}

function normalizedVector(vector: VectorValue): VectorValue {
  return {
    key: vector.key,
    data: { float32: vector.data.float32 },
    ...(vector.metadata === undefined ? {} : { metadata: vector.metadata }),
  };
}

function vectorIdentity(vector: IndexedVector): string {
  return `${vector.bucketName}\0${vector.indexName}\0${vector.key}`;
}

function vectorEqual(left: VectorValue, right: VectorValue): boolean {
  return (
    canonicalJson(normalizedVector(left)) ===
    canonicalJson(normalizedVector(right))
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function readBucketDocument(
  options: VectorStorageRestoreOptions,
): Promise<VectorBucket[]> {
  const document = await readJson(
    options,
    BUCKET_ARTIFACT,
    bucketDocumentSchema,
    "storage.vector_buckets",
  );
  const names = new Set<string>();
  for (const bucket of document.buckets) {
    if (names.has(bucket.vectorBucketName)) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Vector bucket artifact contains duplicate identities.",
        "storage.vector_buckets",
      );
    }
    names.add(bucket.vectorBucketName);
  }
  return document.buckets;
}

async function readSourceBuckets(
  options: VectorStorageRestoreOptions,
  artifacts: readonly string[],
): Promise<VectorBucket[]> {
  assertArtifacts(artifacts, [BUCKET_ARTIFACT], "storage.vector_buckets");
  return readBucketDocument(options);
}

async function readIndexDocument(
  options: VectorStorageRestoreOptions,
): Promise<VectorIndex[]> {
  const document = await readJson(
    options,
    INDEX_ARTIFACT,
    indexDocumentSchema,
    "storage.vector_indexes",
  );
  const identities = new Set<string>();
  for (const index of document.indexes) {
    const id = indexIdentity(index);
    if (identities.has(id)) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Vector index artifact contains duplicate identities.",
        "storage.vector_indexes",
      );
    }
    identities.add(id);
  }
  return document.indexes;
}

async function readSourceIndexes(
  options: VectorStorageRestoreOptions,
  artifacts: readonly string[],
): Promise<VectorIndex[]> {
  assertArtifacts(artifacts, [INDEX_ARTIFACT], "storage.vector_indexes");
  return readIndexDocument(options);
}

async function listTargetBuckets(
  client: VectorMutationClient,
): Promise<VectorBucket[]> {
  const buckets: VectorBucket[] = [];
  const seen = new Set<string>();
  const identities = new Set<string>();
  let token: string | undefined;
  do {
    const page = unwrap(
      await client.listBuckets({
        maxResults: 100,
        ...(token === undefined ? {} : { nextToken: token }),
      }),
      bucketListSchema,
      "storage.vector_buckets",
    );
    for (const listed of page.vectorBuckets) {
      if (identities.has(listed.vectorBucketName)) {
        throw restoreError(
          "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
          "storage",
          "Target Vector Storage returned a duplicate bucket identity.",
          "storage.vector_buckets",
        );
      }
      identities.add(listed.vectorBucketName);
      const detail = unwrap(
        await client.getBucket(listed.vectorBucketName),
        bucketDetailSchema,
        "storage.vector_buckets",
      ).vectorBucket;
      if (detail.vectorBucketName !== listed.vectorBucketName) {
        throw restoreError(
          "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
          "storage",
          "Vector bucket identity changed while reading target state.",
          "storage.vector_buckets",
        );
      }
      buckets.push(detail);
    }
    token = nextToken(page.nextToken, seen, "storage.vector_buckets");
  } while (token !== undefined);
  return buckets.sort((left, right) =>
    left.vectorBucketName.localeCompare(right.vectorBucketName, "en"),
  );
}

async function listTargetIndexes(
  client: VectorMutationClient,
  bucketNames: readonly string[],
): Promise<VectorIndex[]> {
  const indexes: VectorIndex[] = [];
  const identities = new Set<string>();
  for (const bucketName of [...bucketNames].sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    const bucket = client.from(bucketName);
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const page = unwrap(
        await bucket.listIndexes({
          maxResults: 100,
          ...(token === undefined ? {} : { nextToken: token }),
        }),
        indexListSchema,
        "storage.vector_indexes",
      );
      for (const listed of page.indexes) {
        const detail = unwrap(
          await bucket.getIndex(listed.indexName),
          indexDetailSchema,
          "storage.vector_indexes",
        ).index;
        const id = indexIdentity(detail);
        if (
          detail.indexName !== listed.indexName ||
          detail.vectorBucketName !== bucketName ||
          identities.has(id)
        ) {
          throw restoreError(
            "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
            "storage",
            "Vector index identity changed while reading target state.",
            "storage.vector_indexes",
          );
        }
        identities.add(id);
        indexes.push(detail);
      }
      token = nextToken(page.nextToken, seen, "storage.vector_indexes");
    } while (token !== undefined);
  }
  return indexes.sort((left, right) =>
    indexIdentity(left).localeCompare(indexIdentity(right), "en"),
  );
}

async function deleteBucketRecursively(
  client: VectorMutationClient,
  bucketName: string,
): Promise<void> {
  const indexes = await listTargetIndexes(client, [bucketName]);
  const bucket = client.from(bucketName);
  for (const index of indexes)
    requireSuccess(
      await bucket.deleteIndex(index.indexName),
      "storage.vector_indexes",
    );
  requireSuccess(
    await client.deleteBucket(bucketName),
    "storage.vector_buckets",
  );
}

function bucketFingerprint(buckets: readonly VectorBucket[]): string {
  return fingerprint(
    buckets
      .map(({ vectorBucketName }) => vectorBucketName)
      .sort((left, right) => left.localeCompare(right, "en")),
  );
}

function indexesFingerprint(indexes: readonly VectorIndex[]): string {
  return fingerprint(
    indexes
      .map(normalizedIndex)
      .sort((left, right) =>
        `${left.vectorBucketName}\0${left.indexName}`.localeCompare(
          `${right.vectorBucketName}\0${right.indexName}`,
          "en",
        ),
      ),
  );
}

export function createVectorBucketRestoreHandler(
  options: VectorStorageRestoreOptions,
): RestoreActionHandler {
  const client = options.client ?? defaultClient(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await readSourceBuckets(options, context.action.artifacts);
      const sourceIndexes = await readIndexDocument(options);
      const target = await listTargetBuckets(client);
      const sourceNames = new Set(
        source.map(({ vectorBucketName }) => vectorBucketName),
      );
      const targetNames = new Set(
        target.map(({ vectorBucketName }) => vectorBucketName),
      );
      const extra = target.filter(
        ({ vectorBucketName }) => !sourceNames.has(vectorBucketName),
      );
      let unexpectedIndexes: VectorIndex[] = [];
      if (sourceIndexes.length === 0) {
        unexpectedIndexes = await listTargetIndexes(
          client,
          target
            .filter(({ vectorBucketName }) => sourceNames.has(vectorBucketName))
            .map(({ vectorBucketName }) => vectorBucketName),
        );
      }
      if (
        options.conflictPolicy === "fail" &&
        (extra.length > 0 || unexpectedIndexes.length > 0)
      ) {
        throw restoreError(
          "RESTORE_TARGET_CONFLICT",
          "restore_policy",
          "Target Vector bucket state differs from the source backup.",
          "storage.vector_buckets",
          {
            extraBuckets: extra.length,
            unexpectedIndexes: unexpectedIndexes.length,
          },
        );
      }
      if (options.conflictPolicy === "replace") {
        for (const bucket of extra)
          await deleteBucketRecursively(client, bucket.vectorBucketName);
        for (const index of unexpectedIndexes)
          requireSuccess(
            await client
              .from(index.vectorBucketName)
              .deleteIndex(index.indexName),
            "storage.vector_indexes",
          );
      }
      for (const bucket of source) {
        if (targetNames.has(bucket.vectorBucketName)) continue;
        requireSuccess(
          await client.createBucket(bucket.vectorBucketName),
          "storage.vector_buckets",
        );
      }
      return { fingerprint: bucketFingerprint(source) };
    },
    async verify(context): Promise<boolean> {
      const source = await readSourceBuckets(options, context.action.artifacts);
      const expected = bucketFingerprint(source);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      )
        return false;
      if (bucketFingerprint(await listTargetBuckets(client)) !== expected)
        return false;
      const sourceIndexes = await readIndexDocument(options);
      if (sourceIndexes.length > 0) return true;
      return (
        (
          await listTargetIndexes(
            client,
            source.map(({ vectorBucketName }) => vectorBucketName),
          )
        ).length === 0
      );
    },
  };
}

function indexCreateInput(index: VectorIndex) {
  return {
    indexName: index.indexName,
    dataType: index.dataType,
    dimension: index.dimension,
    distanceMetric: index.distanceMetric,
    ...(index.metadataConfiguration === undefined
      ? {}
      : { metadataConfiguration: index.metadataConfiguration }),
  };
}

export function createVectorIndexRestoreHandler(
  options: VectorStorageRestoreOptions,
): RestoreActionHandler {
  const client = options.client ?? defaultClient(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await readSourceIndexes(options, context.action.artifacts);
      const sourceBuckets = await readBucketDocument(options);
      const bucketNames = sourceBuckets.map(
        ({ vectorBucketName }) => vectorBucketName,
      );
      const target = await listTargetIndexes(client, bucketNames);
      const sourceById = new Map(
        source.map((index) => [indexIdentity(index), index]),
      );
      const targetById = new Map(
        target.map((index) => [indexIdentity(index), index]),
      );
      const extra = target.filter(
        (index) => !sourceById.has(indexIdentity(index)),
      );
      const conflicts = source.filter((index) => {
        const current = targetById.get(indexIdentity(index));
        return current !== undefined && !indexEqual(index, current);
      });
      if (
        options.conflictPolicy === "fail" &&
        (extra.length > 0 || conflicts.length > 0)
      ) {
        throw restoreError(
          "RESTORE_TARGET_CONFLICT",
          "restore_policy",
          "Target Vector index state differs from the source backup.",
          "storage.vector_indexes",
          { extraIndexes: extra.length, conflictingIndexes: conflicts.length },
        );
      }
      if (options.conflictPolicy === "replace") {
        for (const index of [...extra, ...conflicts])
          requireSuccess(
            await client
              .from(index.vectorBucketName)
              .deleteIndex(index.indexName),
            "storage.vector_indexes",
          );
      }
      const recreate = new Set(conflicts.map(indexIdentity));
      for (const index of source) {
        const id = indexIdentity(index);
        if (targetById.has(id) && !recreate.has(id)) continue;
        requireSuccess(
          await client
            .from(index.vectorBucketName)
            .createIndex(indexCreateInput(index)),
          "storage.vector_indexes",
        );
      }
      return { fingerprint: indexesFingerprint(source) };
    },
    async verify(context): Promise<boolean> {
      const source = await readSourceIndexes(options, context.action.artifacts);
      const expected = indexesFingerprint(source);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      )
        return false;
      const sourceBuckets = await readBucketDocument(options);
      const target = await listTargetIndexes(
        client,
        sourceBuckets.map(({ vectorBucketName }) => vectorBucketName),
      );
      return indexesFingerprint(target) === expected;
    },
  };
}

async function readSourceVectors(
  options: VectorStorageRestoreOptions,
  artifacts: readonly string[],
): Promise<SourceVectorBundle> {
  const summary = await readJson(
    options,
    SUMMARY_ARTIFACT,
    summarySchema,
    "storage.vectors",
  );
  const summaryIds = new Set<string>();
  const expectedArtifacts = [SUMMARY_ARTIFACT];
  const vectors: IndexedVector[] = [];
  const vectorIds = new Set<string>();
  for (const entry of summary.indexes) {
    const indexId = `${entry.bucketName}\0${entry.indexName}`;
    if (summaryIds.has(indexId)) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Vector summary contains duplicate index identities.",
        "storage.vectors",
      );
    }
    summaryIds.add(indexId);
    let count = 0;
    for (let page = 1; page <= entry.pageCount; page += 1) {
      const artifact = `secrets/storage/vectors/${stableId(entry.bucketName, entry.indexName)}/${String(page).padStart(8, "0")}.json`;
      expectedArtifacts.push(artifact);
      const document = await readJson(
        options,
        artifact,
        vectorPageSchema,
        "storage.vectors",
      );
      if (
        document.bucketName !== entry.bucketName ||
        document.indexName !== entry.indexName
      ) {
        throw restoreError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Vector page identity does not match its summary.",
          "storage.vectors",
        );
      }
      count += document.vectors.length;
      for (const vector of document.vectors) {
        const indexed: IndexedVector = {
          bucketName: entry.bucketName,
          indexName: entry.indexName,
          ...normalizedVector(vector),
        };
        const id = vectorIdentity(indexed);
        if (vectorIds.has(id)) {
          throw restoreError(
            "RESTORE_ARTIFACT_INVALID",
            "integrity",
            "Vector restore artifacts contain duplicate vector keys.",
            "storage.vectors",
          );
        }
        vectorIds.add(id);
        vectors.push(indexed);
      }
    }
    if (count !== entry.vectorCount) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Vector summary count does not match its page artifacts.",
        "storage.vectors",
        { expected: entry.vectorCount, actual: count },
      );
    }
  }
  assertArtifacts(artifacts, expectedArtifacts, "storage.vectors");
  vectors.sort((left, right) =>
    vectorIdentity(left).localeCompare(vectorIdentity(right), "en"),
  );
  return { indexes: summary.indexes, vectors };
}

async function listTargetVectors(
  client: VectorMutationClient,
  bucketName: string,
  indexName: string,
): Promise<VectorValue[]> {
  const values: VectorValue[] = [];
  const seenTokens = new Set<string>();
  const seenKeys = new Set<string>();
  let token: string | undefined;
  const index = client.from(bucketName).index(indexName);
  do {
    const page = unwrap(
      await index.listVectors({
        maxResults: MUTATION_BATCH_SIZE,
        returnData: true,
        returnMetadata: true,
        ...(token === undefined ? {} : { nextToken: token }),
      }),
      vectorListSchema,
      "storage.vectors",
    );
    for (const vector of page.vectors) {
      if (seenKeys.has(vector.key)) {
        throw restoreError(
          "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
          "storage",
          "Target Vector Storage returned a duplicate vector key.",
          "storage.vectors",
        );
      }
      seenKeys.add(vector.key);
      values.push(normalizedVector(vector));
    }
    token = nextToken(page.nextToken, seenTokens, "storage.vectors");
  } while (token !== undefined);
  return values.sort((left, right) => left.key.localeCompare(right.key, "en"));
}

function groupedVectors(bundle: SourceVectorBundle) {
  const groups = new Map<string, IndexedVector[]>();
  for (const index of bundle.indexes)
    groups.set(`${index.bucketName}\0${index.indexName}`, []);
  for (const vector of bundle.vectors) {
    const id = `${vector.bucketName}\0${vector.indexName}`;
    const group = groups.get(id);
    if (group === undefined) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Vector page references an index absent from the summary.",
        "storage.vectors",
      );
    }
    group.push(vector);
  }
  return groups;
}

function vectorsFingerprint(bundle: SourceVectorBundle): string {
  return fingerprint({
    indexes: bundle.indexes
      .map(({ bucketName, indexName }) => ({ bucketName, indexName }))
      .sort((left, right) =>
        `${left.bucketName}\0${left.indexName}`.localeCompare(
          `${right.bucketName}\0${right.indexName}`,
          "en",
        ),
      ),
    vectors: bundle.vectors.map((vector) => ({
      bucketName: vector.bucketName,
      indexName: vector.indexName,
      ...normalizedVector(vector),
    })),
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size)
    result.push(values.slice(offset, offset + size));
  return result;
}

export function createVectorRestoreHandler(
  options: VectorStorageRestoreOptions,
): RestoreActionHandler {
  const client = options.client ?? defaultClient(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await readSourceVectors(options, context.action.artifacts);
      const conflicts: IndexedVector[] = [];
      const missing: IndexedVector[] = [];
      const extra: { bucketName: string; indexName: string; key: string }[] =
        [];

      for (const [groupId, sourceVectors] of groupedVectors(source)) {
        const [bucketName, indexName] = groupId.split("\0") as [string, string];
        const target = await listTargetVectors(client, bucketName, indexName);
        const sourceByKey = new Map(
          sourceVectors.map((vector) => [vector.key, vector]),
        );
        const targetByKey = new Map(
          target.map((vector) => [vector.key, vector]),
        );
        for (const targetVector of target) {
          if (!sourceByKey.has(targetVector.key))
            extra.push({ bucketName, indexName, key: targetVector.key });
        }
        for (const sourceVector of sourceVectors) {
          const targetVector = targetByKey.get(sourceVector.key);
          if (targetVector === undefined) missing.push(sourceVector);
          else if (!vectorEqual(sourceVector, targetVector))
            conflicts.push(sourceVector);
        }
      }

      if (
        options.conflictPolicy === "fail" &&
        (extra.length > 0 || conflicts.length > 0)
      ) {
        throw restoreError(
          "RESTORE_TARGET_CONFLICT",
          "restore_policy",
          "Target Vector data differs from the source backup.",
          "storage.vectors",
          { extraVectors: extra.length, conflictingVectors: conflicts.length },
        );
      }

      if (options.conflictPolicy === "replace") {
        const deletions = new Map<string, string[]>();
        for (const value of extra) {
          const id = `${value.bucketName}\0${value.indexName}`;
          const keys = deletions.get(id) ?? [];
          keys.push(value.key);
          deletions.set(id, keys);
        }
        for (const [groupId, keys] of deletions) {
          const [bucketName, indexName] = groupId.split("\0") as [
            string,
            string,
          ];
          const index = client.from(bucketName).index(indexName);
          for (const batch of chunks(keys, MUTATION_BATCH_SIZE))
            requireSuccess(
              await index.deleteVectors({ keys: batch }),
              "storage.vectors",
            );
        }
      }

      const writes =
        options.conflictPolicy === "replace"
          ? [...missing, ...conflicts]
          : missing;
      const writesByGroup = new Map<string, IndexedVector[]>();
      for (const vector of writes) {
        const id = `${vector.bucketName}\0${vector.indexName}`;
        const group = writesByGroup.get(id) ?? [];
        group.push(vector);
        writesByGroup.set(id, group);
      }
      for (const [groupId, values] of writesByGroup) {
        const [bucketName, indexName] = groupId.split("\0") as [string, string];
        const index = client.from(bucketName).index(indexName);
        for (const batch of chunks(values, MUTATION_BATCH_SIZE))
          requireSuccess(
            await index.putVectors({ vectors: batch.map(normalizedVector) }),
            "storage.vectors",
          );
      }
      return { fingerprint: vectorsFingerprint(source) };
    },
    async verify(context): Promise<boolean> {
      const source = await readSourceVectors(options, context.action.artifacts);
      const expected = vectorsFingerprint(source);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      )
        return false;
      for (const [groupId, sourceVectors] of groupedVectors(source)) {
        const [bucketName, indexName] = groupId.split("\0") as [string, string];
        const target = await listTargetVectors(client, bucketName, indexName);
        if (target.length !== sourceVectors.length) return false;
        for (let index = 0; index < sourceVectors.length; index += 1) {
          const sourceVector = sourceVectors[index]!;
          const targetVector = target[index]!;
          if (
            sourceVector.key !== targetVector.key ||
            !vectorEqual(sourceVector, targetVector)
          )
            return false;
        }
      }
      return true;
    },
  };
}

export function createVectorStorageRestoreHandlers(
  options: VectorStorageRestoreOptions,
): Readonly<Record<VectorRestoreComponent, RestoreActionHandler>> {
  return {
    "storage.vector_buckets": createVectorBucketRestoreHandler(options),
    "storage.vector_indexes": createVectorIndexRestoreHandler(options),
    "storage.vectors": createVectorRestoreHandler(options),
  };
}
