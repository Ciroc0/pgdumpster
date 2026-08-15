import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { StorageClient } from "@supabase/storage-js";
import { z } from "zod";

import {
  collectFileStorageCatalog,
  type FileStorageBucket,
  type FileStorageCatalog,
  type FileStorageObject,
} from "../../storage/catalog.js";
import type { SecretValue } from "../../security/secret-value.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { mapBounded } from "../../utils/bounded-concurrency.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

type FileStorageRestoreComponent =
  "storage.file_buckets" | "storage.file_objects" | "storage.file_metadata";

export interface StorageErrorLike {
  message: string;
  status?: number | undefined;
  statusCode?: number | string | undefined;
}

export interface StorageResult {
  data: unknown;
  error: StorageErrorLike | null;
}

export interface StorageBucketMutationOptions {
  public: boolean;
  fileSizeLimit: string | null;
  allowedMimeTypes: string[] | null;
}

export interface StorageMutationClient {
  createBucket: (
    id: string,
    options: StorageBucketMutationOptions,
  ) => Promise<StorageResult>;
  updateBucket: (
    id: string,
    options: StorageBucketMutationOptions,
  ) => Promise<StorageResult>;
  emptyBucket: (id: string) => Promise<StorageResult>;
  deleteBucket: (id: string) => Promise<StorageResult>;
  from: (id: string) => {
    remove: (paths: string[]) => Promise<StorageResult>;
  };
}

export interface StorageObjectEvidence {
  sha256: string;
  bytes: number;
}

export interface UploadStorageObjectInput {
  bucket: string;
  name: string;
  sourcePath: string;
  upsert: boolean;
  contentType?: string | undefined;
  cacheControl?: string | undefined;
  userMetadata?: Record<string, unknown> | undefined;
}

export interface FileStorageRestoreDependencies {
  collectTarget?: (signal?: AbortSignal) => Promise<FileStorageCatalog>;
  storageClient?: StorageMutationClient;
  uploadObject?: (
    input: UploadStorageObjectInput,
    signal?: AbortSignal,
  ) => Promise<void>;
  readTargetObject?: (
    bucket: string,
    name: string,
    signal?: AbortSignal,
  ) => Promise<StorageObjectEvidence | undefined>;
  removeObjects?: (
    bucket: string,
    names: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface FileStorageRestoreOptions {
  bundleRoot: string;
  targetProjectRef: string;
  targetDatabaseUrl: SecretValue;
  storageKey: SecretValue;
  conflictPolicy: "fail" | "replace";
  maxConcurrency?: number | undefined;
  fetch?: typeof fetch | undefined;
  dependencies?: FileStorageRestoreDependencies | undefined;
}

const CATALOG_ARTIFACT = "storage/file-catalog.json";
const METADATA_SQL_ARTIFACT = "database/storage-metadata.sql";
const INDEX_ARTIFACT = "secrets/storage/file-object-index.json";
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger);

const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    buckets: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          public: z.boolean(),
          type: z.literal("STANDARD"),
          fileSizeLimit: z
            .string()
            .regex(/^(0|[1-9][0-9]*)$/u)
            .nullable(),
          allowedMimeTypes: z.array(z.string()).nullable(),
          createdAt: z.string().nullable(),
          updatedAt: z.string().nullable(),
        })
        .strict(),
    ),
    objects: z.array(
      z
        .object({
          id: z.string().min(1),
          bucket: z.string().min(1),
          name: z.string().min(1),
          owner: z.string().nullable(),
          ownerId: z.string().nullable(),
          version: z.string().nullable(),
          createdAt: z.string().nullable(),
          updatedAt: z.string().nullable(),
          lastAccessedAt: z.string().nullable(),
          expectedBytes: safeIntegerSchema.nullable(),
          metadata: z.record(z.string(), z.unknown()).nullable(),
          userMetadata: z.record(z.string(), z.unknown()).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const indexObjectSchema = z
  .object({
    bucket: z.string().min(1),
    name: z.string().min(1),
    contentId: sha256Schema,
    path: z.string().min(1),
    sha256: sha256Schema,
    bytes: safeIntegerSchema,
    version: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .strict();

const indexSchema = z
  .object({
    schemaVersion: z.literal(1),
    objects: z.array(indexObjectSchema),
  })
  .strict();

type SourceIndex = z.infer<typeof indexSchema>;
type SourceIndexObject = z.infer<typeof indexObjectSchema>;

function restoreError(
  code: string,
  category:
    | "restore_policy"
    | "integrity"
    | "security"
    | "storage"
    | "platform_contract",
  message: string,
  component: FileStorageRestoreComponent,
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

function identity(bucket: string, name: string): string {
  return `${bucket}\0${name}`;
}

function contentId(bucket: string, name: string): string {
  return createHash("sha256")
    .update(bucket)
    .update("\0")
    .update(name)
    .digest("hex");
}

function assertObjectName(
  bucket: string,
  name: string,
  component: FileStorageRestoreComponent,
): void {
  const segments = name.split("/");
  if (
    bucket.includes("\0") ||
    name.includes("\0") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "File Storage object identity is invalid.",
      component,
    );
  }
}

async function readJsonArtifact<T>(
  options: FileStorageRestoreOptions,
  artifact: string,
  maxBytes: number,
  schema: z.ZodType<T>,
  component: FileStorageRestoreComponent,
): Promise<T> {
  const filename = await resolveBundleArtifact(options.bundleRoot, artifact);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "File Storage restore artifact is not a bounded regular file.",
      component,
    );
  }
  try {
    return schema.parse(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "File Storage restore artifact failed validation.",
      component,
      undefined,
      error,
    );
  }
}

async function readSourceCatalog(
  options: FileStorageRestoreOptions,
  component: FileStorageRestoreComponent,
): Promise<FileStorageCatalog> {
  const catalog = await readJsonArtifact(
    options,
    CATALOG_ARTIFACT,
    67_108_864,
    catalogSchema,
    component,
  );
  const bucketIds = new Set<string>();
  for (const bucket of catalog.buckets) {
    if (bucketIds.has(bucket.id)) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "File Storage catalog contains a duplicate bucket identity.",
        component,
      );
    }
    if (bucket.id !== bucket.name) {
      throw restoreError(
        "STORAGE_BUCKET_IDENTITY_UNSUPPORTED",
        "platform_contract",
        "File Storage bucket identity cannot be recreated through the supported Storage API.",
        component,
        { bucket: bucket.id },
      );
    }
    bucketIds.add(bucket.id);
  }
  const objectIds = new Set<string>();
  for (const object of catalog.objects) {
    assertObjectName(object.bucket, object.name, component);
    const key = identity(object.bucket, object.name);
    if (!bucketIds.has(object.bucket) || objectIds.has(key)) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "File Storage catalog contains an invalid or duplicate object identity.",
        component,
      );
    }
    objectIds.add(key);
  }
  return catalog;
}

function assertArtifacts(
  actual: readonly string[],
  expected: readonly string[],
  component: FileStorageRestoreComponent,
): void {
  if (
    canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())
  ) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "restore_policy",
      "Restore action artifacts do not match the File Storage component.",
      component,
    );
  }
}

function validateIndexAgainstCatalog(
  catalog: FileStorageCatalog,
  index: SourceIndex,
  component: FileStorageRestoreComponent,
): void {
  const seen = new Set<string>();
  for (const object of index.objects) {
    assertObjectName(object.bucket, object.name, component);
    const expectedId = contentId(object.bucket, object.name);
    const expectedPath = `storage/file-objects/${expectedId.slice(0, 2)}/${expectedId}`;
    const key = identity(object.bucket, object.name);
    if (
      object.contentId !== expectedId ||
      object.path !== expectedPath ||
      seen.has(key)
    ) {
      throw restoreError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "File Storage object index contains invalid identity evidence.",
        component,
      );
    }
    seen.add(key);
  }
  const catalogIds = new Set(
    catalog.objects.map((object) => identity(object.bucket, object.name)),
  );
  if (
    canonicalJson([...seen].sort()) !== canonicalJson([...catalogIds].sort())
  ) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "File Storage object index does not match the catalog.",
      component,
    );
  }
}

async function readSourceIndex(
  options: FileStorageRestoreOptions,
  actionArtifacts: readonly string[],
): Promise<{ catalog: FileStorageCatalog; index: SourceIndex }> {
  const component = "storage.file_objects" as const;
  const catalog = await readSourceCatalog(options, component);
  const index = await readJsonArtifact(
    options,
    INDEX_ARTIFACT,
    67_108_864,
    indexSchema,
    component,
  );
  validateIndexAgainstCatalog(catalog, index, component);
  assertArtifacts(
    actionArtifacts,
    [
      INDEX_ARTIFACT,
      ...index.objects.map(({ path: objectPath }) => objectPath),
    ],
    component,
  );
  return { catalog, index };
}

function normalizedBucket(bucket: FileStorageBucket) {
  return {
    id: bucket.id,
    name: bucket.name,
    public: bucket.public,
    fileSizeLimit: bucket.fileSizeLimit,
    allowedMimeTypes:
      bucket.allowedMimeTypes === null
        ? null
        : [...bucket.allowedMimeTypes].sort((left, right) =>
            left.localeCompare(right, "en"),
          ),
  };
}

function bucketsFingerprint(catalog: FileStorageCatalog): string {
  const normalized = catalog.buckets
    .map(normalizedBucket)
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function bucketEqual(
  source: FileStorageBucket,
  target: FileStorageBucket,
): boolean {
  return (
    canonicalJson(normalizedBucket(source)) ===
    canonicalJson(normalizedBucket(target))
  );
}

function normalizeUserMetadata(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value !== null && Object.keys(value).length > 0 ? value : null;
}

function stringMetadata(
  value: Record<string, unknown> | null,
  ...keys: readonly string[]
): string | null {
  if (value === null) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function normalizeCacheControl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("max-age=")
    ? trimmed.slice("max-age=".length)
    : trimmed;
}

function objectMetadata(object: FileStorageObject, bytes: number) {
  return {
    bucket: object.bucket,
    name: object.name,
    bytes,
    contentType: stringMetadata(
      object.metadata,
      "mimetype",
      "contentType",
      "content-type",
    ),
    cacheControl: normalizeCacheControl(
      stringMetadata(object.metadata, "cacheControl", "cache-control"),
    ),
    userMetadata: normalizeUserMetadata(object.userMetadata),
  };
}

function metadataMatches(
  source: ReturnType<typeof objectMetadata>,
  target: FileStorageObject,
): boolean {
  if (target.expectedBytes !== source.bytes) return false;
  const targetMetadata = objectMetadata(target, source.bytes);
  if (
    source.contentType !== null &&
    targetMetadata.contentType !== source.contentType
  )
    return false;
  if (
    source.cacheControl !== null &&
    targetMetadata.cacheControl !== source.cacheControl
  )
    return false;
  return (
    canonicalJson(targetMetadata.userMetadata) ===
    canonicalJson(source.userMetadata)
  );
}

function metadataFingerprint(
  catalog: FileStorageCatalog,
  index: SourceIndex,
): string {
  const byId = new Map(
    catalog.objects.map((object) => [
      identity(object.bucket, object.name),
      object,
    ]),
  );
  const values = index.objects
    .map((entry) =>
      objectMetadata(
        byId.get(identity(entry.bucket, entry.name))!,
        entry.bytes,
      ),
    )
    .sort((left, right) =>
      identity(left.bucket, left.name).localeCompare(
        identity(right.bucket, right.name),
        "en",
      ),
    );
  return createHash("sha256").update(canonicalJson(values)).digest("hex");
}

function objectFingerprint(index: SourceIndex): string {
  const values = index.objects
    .map(({ bucket, name, sha256, bytes }) => ({ bucket, name, sha256, bytes }))
    .sort((left, right) =>
      identity(left.bucket, left.name).localeCompare(
        identity(right.bucket, right.name),
        "en",
      ),
    );
  return createHash("sha256").update(canonicalJson(values)).digest("hex");
}

async function sourceEvidence(
  options: FileStorageRestoreOptions,
  object: SourceIndexObject,
): Promise<StorageObjectEvidence> {
  const filename = await resolveBundleArtifact(options.bundleRoot, object.path);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== object.bytes) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "File Storage object payload size does not match its verified index.",
      "storage.file_objects",
    );
  }
  const hash = createHash("sha256");
  const stream = createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const sha256 = hash.digest("hex");
  if (sha256 !== object.sha256) {
    throw restoreError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "File Storage object payload checksum does not match its verified index.",
      "storage.file_objects",
    );
  }
  return { sha256, bytes: stat.size };
}

function objectUrl(projectRef: string, bucket: string, name: string): string {
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) {
    throw restoreError(
      "PROJECT_REF_INVALID",
      "platform_contract",
      "Target project ref is invalid for File Storage restore.",
      "storage.file_objects",
    );
  }
  assertObjectName(bucket, name, "storage.file_objects");
  return `https://${projectRef}.supabase.co/storage/v1/object/${encodeURIComponent(bucket)}/${name
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function storageFailure(
  code: string,
  message: string,
  component: FileStorageRestoreComponent,
  error?: StorageErrorLike,
): PgDumpsterError {
  return restoreError(
    code,
    "storage",
    message,
    component,
    error === undefined
      ? undefined
      : { status: error.status, statusCode: error.statusCode },
  );
}

function requireStorageSuccess(
  result: StorageResult,
  code: string,
  message: string,
  component: FileStorageRestoreComponent,
): void {
  if (result.error !== null)
    throw storageFailure(code, message, component, result.error);
}

function defaultStorageClient(
  options: FileStorageRestoreOptions,
): StorageMutationClient {
  const key = options.storageKey.expose();
  return new StorageClient(
    `https://${options.targetProjectRef}.supabase.co/storage/v1`,
    { apikey: key, authorization: `Bearer ${key}` },
  );
}

async function defaultCollectTarget(
  options: FileStorageRestoreOptions,
  signal?: AbortSignal,
): Promise<FileStorageCatalog> {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-storage-restore-target-"),
  );
  try {
    return await collectFileStorageCatalog(
      options.targetDatabaseUrl,
      outputDirectory,
      signal,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function defaultReadTargetObject(
  options: FileStorageRestoreOptions,
  bucket: string,
  name: string,
  signal?: AbortSignal,
): Promise<StorageObjectEvidence | undefined> {
  const key = options.storageKey.expose();
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      objectUrl(options.targetProjectRef, bucket, name),
      {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, apikey: key },
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    signal?.throwIfAborted();
    throw restoreError(
      "STORAGE_OBJECT_VERIFY_FAILED",
      "storage",
      "Target File Storage object could not be read for verification.",
      "storage.file_objects",
      undefined,
      error,
    );
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw restoreError(
      "STORAGE_OBJECT_VERIFY_FAILED",
      "storage",
      "Target File Storage object verification request failed.",
      "storage.file_objects",
      { httpStatus: response.status },
    );
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function defaultUploadObject(
  options: FileStorageRestoreOptions,
  input: UploadStorageObjectInput,
  signal?: AbortSignal,
): Promise<void> {
  const key = options.storageKey.expose();
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    apikey: key,
    "x-upsert": String(input.upsert),
  };
  if (input.contentType !== undefined)
    headers["content-type"] = input.contentType;
  if (input.cacheControl !== undefined)
    headers["cache-control"] = `max-age=${input.cacheControl}`;
  if (input.userMetadata !== undefined)
    headers["x-metadata"] = Buffer.from(
      JSON.stringify(input.userMetadata),
      "utf8",
    ).toString("base64");
  const body = createReadStream(input.sourcePath);
  try {
    const request: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body,
      duplex: "half",
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await (options.fetch ?? globalThis.fetch)(
      objectUrl(options.targetProjectRef, input.bucket, input.name),
      request,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw restoreError(
        "STORAGE_OBJECT_RESTORE_FAILED",
        "storage",
        "File Storage object upload failed.",
        "storage.file_objects",
        { httpStatus: response.status },
      );
    }
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PgDumpsterError) throw error;
    throw restoreError(
      "STORAGE_OBJECT_RESTORE_FAILED",
      "storage",
      "File Storage object upload failed.",
      "storage.file_objects",
      undefined,
      error,
    );
  } finally {
    body.destroy();
  }
}

function dependencies(options: FileStorageRestoreOptions) {
  const client =
    options.dependencies?.storageClient ?? defaultStorageClient(options);
  return {
    client,
    collectTarget:
      options.dependencies?.collectTarget ??
      ((signal?: AbortSignal) => defaultCollectTarget(options, signal)),
    uploadObject:
      options.dependencies?.uploadObject ??
      ((input: UploadStorageObjectInput, signal?: AbortSignal) =>
        defaultUploadObject(options, input, signal)),
    readTargetObject:
      options.dependencies?.readTargetObject ??
      ((bucket: string, name: string, signal?: AbortSignal) =>
        defaultReadTargetObject(options, bucket, name, signal)),
    removeObjects:
      options.dependencies?.removeObjects ??
      (async (bucket: string, names: readonly string[]) => {
        for (let offset = 0; offset < names.length; offset += 1000) {
          const result = await client
            .from(bucket)
            .remove(names.slice(offset, offset + 1000));
          requireStorageSuccess(
            result,
            "STORAGE_OBJECT_RESTORE_FAILED",
            "Extra target File Storage objects could not be removed.",
            "storage.file_objects",
          );
        }
      }),
  };
}

function targetByIdentity(catalog: FileStorageCatalog) {
  return new Map(
    catalog.objects.map((object) => [
      identity(object.bucket, object.name),
      object,
    ]),
  );
}

export function createFileBucketRestoreHandler(
  options: FileStorageRestoreOptions,
): RestoreActionHandler {
  const runtime = dependencies(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      assertArtifacts(
        context.action.artifacts,
        [CATALOG_ARTIFACT],
        "storage.file_buckets",
      );
      const source = await readSourceCatalog(options, "storage.file_buckets");
      const target = await runtime.collectTarget(context.signal);
      const sourceById = new Map(
        source.buckets.map((bucket) => [bucket.id, bucket]),
      );
      const targetById = new Map(
        target.buckets.map((bucket) => [bucket.id, bucket]),
      );
      const extra = target.buckets.filter(
        (bucket) => !sourceById.has(bucket.id),
      );
      const conflicts = source.buckets.filter((bucket) => {
        const current = targetById.get(bucket.id);
        return current !== undefined && !bucketEqual(bucket, current);
      });
      if (
        options.conflictPolicy === "fail" &&
        (extra.length > 0 || conflicts.length > 0)
      ) {
        throw restoreError(
          "RESTORE_TARGET_CONFLICT",
          "restore_policy",
          "Target File Storage bucket state differs from the source.",
          "storage.file_buckets",
          { extraBuckets: extra.length, conflictingBuckets: conflicts.length },
        );
      }
      if (options.conflictPolicy === "replace") {
        for (const bucket of extra) {
          requireStorageSuccess(
            await runtime.client.emptyBucket(bucket.id),
            "STORAGE_BUCKET_RESTORE_FAILED",
            "Extra target File Storage bucket could not be emptied.",
            "storage.file_buckets",
          );
          requireStorageSuccess(
            await runtime.client.deleteBucket(bucket.id),
            "STORAGE_BUCKET_RESTORE_FAILED",
            "Extra target File Storage bucket could not be deleted.",
            "storage.file_buckets",
          );
        }
      }
      for (const bucket of source.buckets) {
        const current = targetById.get(bucket.id);
        const bucketOptions: StorageBucketMutationOptions = {
          public: bucket.public,
          fileSizeLimit: bucket.fileSizeLimit,
          allowedMimeTypes: bucket.allowedMimeTypes,
        };
        if (current === undefined) {
          requireStorageSuccess(
            await runtime.client.createBucket(bucket.id, bucketOptions),
            "STORAGE_BUCKET_RESTORE_FAILED",
            "File Storage bucket creation failed.",
            "storage.file_buckets",
          );
        } else if (
          options.conflictPolicy === "replace" &&
          !bucketEqual(bucket, current)
        ) {
          requireStorageSuccess(
            await runtime.client.updateBucket(bucket.id, bucketOptions),
            "STORAGE_BUCKET_RESTORE_FAILED",
            "File Storage bucket update failed.",
            "storage.file_buckets",
          );
        }
      }
      return { fingerprint: bucketsFingerprint(source) };
    },
    async verify(context): Promise<boolean> {
      assertArtifacts(
        context.action.artifacts,
        [CATALOG_ARTIFACT],
        "storage.file_buckets",
      );
      const source = await readSourceCatalog(options, "storage.file_buckets");
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== bucketsFingerprint(source)
      )
        return false;
      return (
        bucketsFingerprint(await runtime.collectTarget(context.signal)) ===
        bucketsFingerprint(source)
      );
    },
  };
}

async function verifyObjectSet(
  options: FileStorageRestoreOptions,
  runtime: ReturnType<typeof dependencies>,
  catalog: FileStorageCatalog,
  index: SourceIndex,
  signal?: AbortSignal,
): Promise<boolean> {
  const target = await runtime.collectTarget(signal);
  const sourceIds = new Set(
    index.objects.map((object) => identity(object.bucket, object.name)),
  );
  if (
    target.objects.some(
      (object) => !sourceIds.has(identity(object.bucket, object.name)),
    )
  )
    return false;
  const targetMap = targetByIdentity(target);
  const sourceCatalogMap = targetByIdentity(catalog);
  const concurrency = options.maxConcurrency ?? 8;
  const results = await mapBounded(
    index.objects,
    concurrency,
    async (entry, _index, workerSignal) => {
      const targetObject = targetMap.get(identity(entry.bucket, entry.name));
      const sourceObject = sourceCatalogMap.get(
        identity(entry.bucket, entry.name),
      )!;
      if (
        targetObject === undefined ||
        !metadataMatches(
          objectMetadata(sourceObject, entry.bytes),
          targetObject,
        )
      )
        return false;
      const evidence = await runtime.readTargetObject(
        entry.bucket,
        entry.name,
        workerSignal,
      );
      return (
        evidence?.sha256 === entry.sha256 && evidence.bytes === entry.bytes
      );
    },
    signal,
  );
  return results.every(Boolean);
}

export function createFileObjectRestoreHandler(
  options: FileStorageRestoreOptions,
): RestoreActionHandler {
  const runtime = dependencies(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      const { catalog, index } = await readSourceIndex(
        options,
        context.action.artifacts,
      );
      const concurrency = options.maxConcurrency ?? 8;
      await mapBounded(
        index.objects,
        concurrency,
        (entry) => sourceEvidence(options, entry),
        context.signal,
      );
      const target = await runtime.collectTarget(context.signal);
      const targetMap = targetByIdentity(target);
      const sourceMap = targetByIdentity(catalog);
      const sourceIds = new Set(
        index.objects.map((entry) => identity(entry.bucket, entry.name)),
      );
      const extras = target.objects.filter(
        (object) => !sourceIds.has(identity(object.bucket, object.name)),
      );

      if (options.conflictPolicy === "fail") {
        if (extras.length > 0) {
          throw restoreError(
            "RESTORE_TARGET_CONFLICT",
            "restore_policy",
            "Target File Storage contains objects absent from the source.",
            "storage.file_objects",
            { extraObjects: extras.length },
          );
        }
        const conflicts = await mapBounded(
          index.objects.filter((entry) =>
            targetMap.has(identity(entry.bucket, entry.name)),
          ),
          concurrency,
          async (entry, _index, workerSignal) => {
            const sourceObject = sourceMap.get(
              identity(entry.bucket, entry.name),
            )!;
            const targetObject = targetMap.get(
              identity(entry.bucket, entry.name),
            )!;
            const evidence = await runtime.readTargetObject(
              entry.bucket,
              entry.name,
              workerSignal,
            );
            return (
              evidence?.sha256 !== entry.sha256 ||
              evidence.bytes !== entry.bytes ||
              !metadataMatches(
                objectMetadata(sourceObject, entry.bytes),
                targetObject,
              )
            );
          },
          context.signal,
        );
        if (conflicts.some(Boolean)) {
          throw restoreError(
            "RESTORE_TARGET_CONFLICT",
            "restore_policy",
            "Existing target File Storage object differs from the source.",
            "storage.file_objects",
          );
        }
      } else if (extras.length > 0) {
        const byBucket = new Map<string, string[]>();
        for (const object of extras) {
          const names = byBucket.get(object.bucket) ?? [];
          names.push(object.name);
          byBucket.set(object.bucket, names);
        }
        for (const [bucket, names] of byBucket)
          await runtime.removeObjects(bucket, names, context.signal);
      }

      await mapBounded(
        index.objects,
        concurrency,
        async (entry, _index, workerSignal) => {
          const key = identity(entry.bucket, entry.name);
          const targetObject = targetMap.get(key);
          const sourceObject = sourceMap.get(key)!;
          if (targetObject !== undefined) {
            const evidence = await runtime.readTargetObject(
              entry.bucket,
              entry.name,
              workerSignal,
            );
            if (
              evidence?.sha256 === entry.sha256 &&
              evidence.bytes === entry.bytes &&
              metadataMatches(
                objectMetadata(sourceObject, entry.bytes),
                targetObject,
              )
            )
              return;
          }
          const sourcePath = await resolveBundleArtifact(
            options.bundleRoot,
            entry.path,
          );
          const metadata = objectMetadata(sourceObject, entry.bytes);
          await runtime.uploadObject(
            {
              bucket: entry.bucket,
              name: entry.name,
              sourcePath,
              upsert: options.conflictPolicy === "replace",
              ...(metadata.contentType === null
                ? {}
                : { contentType: metadata.contentType }),
              ...(metadata.cacheControl === null
                ? {}
                : { cacheControl: metadata.cacheControl }),
              ...(metadata.userMetadata === null
                ? {}
                : { userMetadata: metadata.userMetadata }),
            },
            workerSignal,
          );
        },
        context.signal,
      );
      return { fingerprint: objectFingerprint(index) };
    },
    async verify(context): Promise<boolean> {
      const { catalog, index } = await readSourceIndex(
        options,
        context.action.artifacts,
      );
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== objectFingerprint(index)
      )
        return false;
      return verifyObjectSet(options, runtime, catalog, index, context.signal);
    },
  };
}

export function createFileMetadataRestoreHandler(
  options: FileStorageRestoreOptions,
): RestoreActionHandler {
  const runtime = dependencies(options);
  const source = async (artifacts: readonly string[]) => {
    assertArtifacts(
      artifacts,
      [CATALOG_ARTIFACT, METADATA_SQL_ARTIFACT],
      "storage.file_metadata",
    );
    const catalog = await readSourceCatalog(options, "storage.file_metadata");
    const index = await readJsonArtifact(
      options,
      INDEX_ARTIFACT,
      67_108_864,
      indexSchema,
      "storage.file_metadata",
    );
    validateIndexAgainstCatalog(catalog, index, "storage.file_metadata");
    return { catalog, index };
  };
  return {
    async apply(context): Promise<RestoreActionResult> {
      const value = await source(context.action.artifacts);
      return { fingerprint: metadataFingerprint(value.catalog, value.index) };
    },
    async verify(context): Promise<boolean> {
      const value = await source(context.action.artifacts);
      const expected = metadataFingerprint(value.catalog, value.index);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      )
        return false;
      const target = await runtime.collectTarget(context.signal);
      const targetMap = targetByIdentity(target);
      if (target.objects.length !== value.index.objects.length) return false;
      const sourceMap = targetByIdentity(value.catalog);
      return value.index.objects.every((entry) => {
        const sourceObject = sourceMap.get(identity(entry.bucket, entry.name));
        const targetObject = targetMap.get(identity(entry.bucket, entry.name));
        return (
          sourceObject !== undefined &&
          targetObject !== undefined &&
          metadataMatches(
            objectMetadata(sourceObject, entry.bytes),
            targetObject,
          )
        );
      });
    },
  };
}

export function createFileStorageRestoreHandlers(
  options: FileStorageRestoreOptions,
): Readonly<Record<FileStorageRestoreComponent, RestoreActionHandler>> {
  return {
    "storage.file_buckets": createFileBucketRestoreHandler(options),
    "storage.file_objects": createFileObjectRestoreHandler(options),
    "storage.file_metadata": createFileMetadataRestoreHandler(options),
  };
}
