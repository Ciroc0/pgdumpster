import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { mapBounded } from "../utils/bounded-concurrency.js";
import { canonicalJson } from "../utils/canonical-json.js";

const MIB = 1024 * 1024;
const DEFAULT_PART_SIZE_MIB = 64;
const DEFAULT_CONCURRENCY = 4;
const MAX_MULTIPART_PARTS = 10_000;
const MAX_MARKER_BYTES = 65_536;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const completionMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("pgdumpster.s3.complete"),
    runId: z.string().min(1),
    objectKey: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: sha256Schema,
    verifiedAt: z.string().min(1),
  })
  .strict();
const completedPartSchema = z
  .object({
    partNumber: z.number().int().min(1).max(MAX_MULTIPART_PARTS),
    etag: z.string().min(1),
    size: z.number().int().positive(),
  })
  .strict();
const uploadStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    bucket: z.string().min(1),
    objectKey: z.string().min(1),
    markerKey: z.string().min(1),
    runId: z.string().min(1),
    localFile: z.string().min(1),
    size: z.number().int().positive(),
    sha256: sha256Schema,
    partSize: z.number().int().positive(),
    uploadId: z.string().min(1),
    completedParts: z.array(completedPartSchema),
    createdAt: z.string().min(1),
  })
  .strict();

type CompletionMarker = z.infer<typeof completionMarkerSchema>;
type UploadState = z.infer<typeof uploadStateSchema>;
type CompletedPartState = z.infer<typeof completedPartSchema>;

export interface S3DestinationConfig {
  bucket: string;
  prefix?: string | undefined;
  endpoint?: string | undefined;
  region?: string | undefined;
  forcePathStyle?: boolean | undefined;
  partSizeMiB?: number | undefined;
  maxConcurrency?: number | undefined;
}

export interface S3PublicationOptions {
  runId: string;
  statePath?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  client?: S3Client | undefined;
  now?: (() => Date) | undefined;
}

export interface S3MaterializeOptions {
  environment?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  client?: S3Client | undefined;
}

export interface S3PublicationResult {
  locator: string;
  objectUri: string;
  markerUri: string;
  size: number;
  sha256: string;
  recovered: boolean;
}

interface FileDigest {
  size: number;
  sha256: string;
}

interface RemoteKeys {
  directoryKey: string;
  objectKey: string;
  markerKey: string;
}

function destinationError(
  code: string,
  message: string,
  cause?: unknown,
  details?: Readonly<Record<string, unknown>>,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category: "destination",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    ...(details === undefined ? {} : { details }),
  });
}

function integrityError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PgDumpsterError {
  return new PgDumpsterError({
    code: "S3_REMOTE_INTEGRITY_FAILED",
    category: "integrity",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}

function cancellationError(signal: AbortSignal): PgDumpsterError {
  return new PgDumpsterError({
    code: "OPERATION_CANCELLED",
    category: "cancelled",
    message: "S3 operation was cancelled.",
    retryable: false,
    cause: signal.reason,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancellationError(signal);
}

function requestOptions(signal: AbortSignal | undefined): {
  abortSignal?: AbortSignal;
} {
  return signal === undefined ? {} : { abortSignal: signal };
}

function fsCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

function isNotFound(error: unknown): boolean {
  const name = errorName(error);
  return (
    httpStatus(error) === 404 ||
    name === "NotFound" ||
    name === "NoSuchKey" ||
    name === "NoSuchUpload"
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return httpStatus(error) === 412 || errorName(error) === "PreconditionFailed";
}

function remoteFailure(
  signal: AbortSignal | undefined,
  code: string,
  message: string,
  cause: unknown,
): PgDumpsterError {
  if (signal?.aborted === true) return cancellationError(signal);
  if (cause instanceof PgDumpsterError) return cause;
  return destinationError(code, message, cause);
}

function normalizePrefix(prefix: string | undefined): string {
  const raw = prefix ?? "";
  if (raw.includes("\\")) {
    throw destinationError(
      "S3_DESTINATION_INVALID",
      "S3 prefix must use forward slashes.",
    );
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw destinationError(
      "S3_DESTINATION_INVALID",
      "S3 prefix may not contain dot traversal segments.",
    );
  }
  return segments.length === 0 ? "" : `${segments.join("/")}/`;
}

function validateConfig(config: S3DestinationConfig): void {
  if (config.bucket.length === 0) {
    throw destinationError("S3_DESTINATION_INVALID", "S3 bucket is required.");
  }
  if (
    config.partSizeMiB !== undefined &&
    (!Number.isInteger(config.partSizeMiB) || config.partSizeMiB < 5)
  ) {
    throw destinationError(
      "S3_DESTINATION_INVALID",
      "S3 multipart part size must be at least 5 MiB.",
    );
  }
  if (
    config.maxConcurrency !== undefined &&
    (!Number.isInteger(config.maxConcurrency) ||
      config.maxConcurrency < 1 ||
      config.maxConcurrency > 16)
  ) {
    throw destinationError(
      "S3_DESTINATION_INVALID",
      "S3 multipart concurrency must be between 1 and 16.",
    );
  }
  normalizePrefix(config.prefix);
}

export function createS3Client(
  config: S3DestinationConfig,
  environment: NodeJS.ProcessEnv = process.env,
): S3Client {
  validateConfig(config);
  const accessKeyId = environment["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = environment["AWS_SECRET_ACCESS_KEY"];
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    throw destinationError(
      "S3_CREDENTIALS_INVALID",
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be supplied together.",
    );
  }
  const credentials =
    accessKeyId === undefined || secretAccessKey === undefined
      ? undefined
      : {
          accessKeyId,
          secretAccessKey,
          ...(environment["AWS_SESSION_TOKEN"] === undefined
            ? {}
            : { sessionToken: environment["AWS_SESSION_TOKEN"] }),
        };
  return new S3Client({
    region:
      config.region ??
      environment["AWS_REGION"] ??
      environment["AWS_DEFAULT_REGION"] ??
      "us-east-1",
    maxAttempts: 3,
    forcePathStyle: config.forcePathStyle ?? false,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(credentials === undefined ? {} : { credentials }),
  });
}

async function digestFile(
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<FileDigest> {
  throwIfAborted(signal);
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    throw destinationError(
      "S3_LOCAL_INPUT_INVALID",
      "S3 publication input could not be inspected.",
      error,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw destinationError(
      "S3_LOCAL_INPUT_INVALID",
      "S3 publication input must be a non-empty regular non-symlink file.",
    );
  }
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of createReadStream(filePath, {
      ...(signal === undefined ? {} : { signal }),
    })) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw destinationError(
          "S3_LOCAL_INPUT_INVALID",
          "Local backup stream produced an unsupported chunk type.",
        );
      }
      hash.update(chunk);
      size += chunk.byteLength;
    }
  } catch (error) {
    throw remoteFailure(
      signal,
      "S3_LOCAL_INPUT_INVALID",
      "S3 publication input could not be read.",
      error,
    );
  }
  if (size !== stat.size) {
    throw destinationError(
      "S3_LOCAL_INPUT_CHANGED",
      "Local backup changed while preparing S3 publication.",
      undefined,
      { expectedSize: stat.size, observedSize: size },
    );
  }
  return { size, sha256: hash.digest("hex") };
}

function assertStreamable(body: unknown): AsyncIterable<unknown> {
  if (
    body === null ||
    typeof body !== "object" ||
    !(Symbol.asyncIterator in body)
  ) {
    throw destinationError(
      "S3_RESPONSE_INVALID",
      "S3 response body is not streamable.",
    );
  }
  return body as AsyncIterable<unknown>;
}

async function digestRemoteBody(
  body: unknown,
  signal: AbortSignal | undefined,
  limitBytes?: number,
): Promise<{ size: number; sha256: string; bytes?: Buffer }> {
  const hash = createHash("sha256");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const raw of assertStreamable(body)) {
    throwIfAborted(signal);
    if (!(raw instanceof Uint8Array)) {
      throw destinationError(
        "S3_RESPONSE_INVALID",
        "S3 response body produced an unsupported chunk type.",
      );
    }
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (limitBytes !== undefined && size > limitBytes) {
      throw destinationError(
        "S3_RESPONSE_INVALID",
        "S3 completion marker exceeds the allowed size.",
      );
    }
    hash.update(chunk);
    if (limitBytes !== undefined) chunks.push(chunk);
  }
  return {
    size,
    sha256: hash.digest("hex"),
    ...(limitBytes === undefined ? {} : { bytes: Buffer.concat(chunks) }),
  };
}

function remoteKeys(
  config: S3DestinationConfig,
  runId: string,
  localFile: string,
): RemoteKeys {
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) {
    throw destinationError(
      "S3_DESTINATION_INVALID",
      "S3 publication run ID contains unsupported characters.",
    );
  }
  const directoryKey = `${normalizePrefix(config.prefix)}${runId}/`;
  return {
    directoryKey,
    objectKey: `${directoryKey}${path.basename(localFile)}`,
    markerKey: `${directoryKey}COMPLETE.json`,
  };
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function s3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${encodeKey(key)}`;
}

function publicationResult(
  config: S3DestinationConfig,
  keys: RemoteKeys,
  digest: FileDigest,
  recovered: boolean,
): S3PublicationResult {
  return {
    locator: s3Uri(config.bucket, keys.directoryKey),
    objectUri: s3Uri(config.bucket, keys.objectKey),
    markerUri: s3Uri(config.bucket, keys.markerKey),
    size: digest.size,
    sha256: digest.sha256,
    recovered,
  };
}

async function headObject(
  client: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal | undefined,
): Promise<HeadObjectCommandOutput | undefined> {
  try {
    return await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      requestOptions(signal),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw remoteFailure(
      signal,
      "S3_HEAD_FAILED",
      "S3 object metadata could not be read.",
      error,
    );
  }
}

async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal | undefined,
  code: string,
  message: string,
): Promise<GetObjectCommandOutput> {
  try {
    return await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      requestOptions(signal),
    );
  } catch (error) {
    throw remoteFailure(signal, code, message, error);
  }
}

function metadataValue(
  metadata: Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): string | undefined {
  return Object.entries(metadata ?? {}).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  )?.[1];
}

async function verifyRemoteObject(
  client: S3Client,
  config: S3DestinationConfig,
  key: string,
  expected: FileDigest,
  signal: AbortSignal | undefined,
): Promise<void> {
  const head = await headObject(client, config.bucket, key, signal);
  if (head === undefined) {
    throw integrityError("Committed S3 object is missing.", { key });
  }
  if (
    head.ContentLength !== expected.size ||
    metadataValue(head.Metadata, "pgdumpster-sha256") !== expected.sha256 ||
    metadataValue(head.Metadata, "pgdumpster-size") !== String(expected.size)
  ) {
    throw integrityError("S3 object metadata does not match local backup.", {
      key,
      expectedSize: expected.size,
      observedSize: head.ContentLength,
    });
  }
  const response = await getObject(
    client,
    config.bucket,
    key,
    signal,
    "S3_DOWNLOAD_FAILED",
    "S3 object could not be read back for integrity verification.",
  );
  const observed = await digestRemoteBody(response.Body, signal);
  if (observed.size !== expected.size || observed.sha256 !== expected.sha256) {
    throw integrityError("S3 object bytes failed SHA-256 verification.", {
      key,
      expectedSize: expected.size,
      observedSize: observed.size,
    });
  }
}

async function readMarker(
  client: S3Client,
  bucket: string,
  markerKey: string,
  signal: AbortSignal | undefined,
): Promise<CompletionMarker | undefined> {
  let response: GetObjectCommandOutput;
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: markerKey }),
      requestOptions(signal),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw remoteFailure(
      signal,
      "S3_MARKER_READ_FAILED",
      "S3 completion marker could not be read.",
      error,
    );
  }
  const body = await digestRemoteBody(response.Body, signal, MAX_MARKER_BYTES);
  try {
    return completionMarkerSchema.parse(
      JSON.parse(body.bytes!.toString("utf8")) as unknown,
    );
  } catch (error) {
    throw destinationError(
      "S3_MARKER_INVALID",
      "S3 completion marker is invalid.",
      error,
    );
  }
}

function assertMarkerMatches(
  marker: CompletionMarker,
  runId: string,
  keys: RemoteKeys,
  digest: FileDigest,
): void {
  if (
    marker.runId !== runId ||
    marker.objectKey !== keys.objectKey ||
    marker.size !== digest.size ||
    marker.sha256 !== digest.sha256
  ) {
    throw integrityError("S3 completion marker does not match this backup.", {
      markerObjectKey: marker.objectKey,
      expectedObjectKey: keys.objectKey,
    });
  }
}

async function writeMarker(
  client: S3Client,
  config: S3DestinationConfig,
  marker: CompletionMarker,
  keys: RemoteKeys,
  signal: AbortSignal | undefined,
): Promise<void> {
  const contents = canonicalJson(marker);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: keys.markerKey,
        Body: contents,
        ContentType: "application/json",
        ContentLength: Buffer.byteLength(contents),
        IfNoneMatch: "*",
        Metadata: {
          "pgdumpster-sha256": createHash("sha256")
            .update(contents)
            .digest("hex"),
        },
      }),
      requestOptions(signal),
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) {
      throw remoteFailure(
        signal,
        "S3_MARKER_WRITE_FAILED",
        "S3 completion marker could not be written.",
        error,
      );
    }
  }
  const observed = await readMarker(
    client,
    config.bucket,
    keys.markerKey,
    signal,
  );
  if (observed === undefined) {
    throw destinationError(
      "S3_MARKER_WRITE_FAILED",
      "S3 completion marker was not observable after publication.",
    );
  }
  assertMarkerMatches(observed, marker.runId, keys, {
    size: marker.size,
    sha256: marker.sha256,
  });
}

async function readUploadState(statePath: string): Promise<UploadState | undefined> {
  try {
    const stat = await lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw destinationError(
        "S3_UPLOAD_STATE_INVALID",
        "S3 upload state must be a regular non-symlink file.",
      );
    }
  } catch (error) {
    if (fsCode(error) === "ENOENT") return undefined;
    if (error instanceof PgDumpsterError) throw error;
    throw destinationError(
      "S3_UPLOAD_STATE_INVALID",
      "S3 upload state could not be inspected.",
      error,
    );
  }
  try {
    return uploadStateSchema.parse(
      JSON.parse(await readFile(statePath, "utf8")) as unknown,
    );
  } catch (error) {
    throw destinationError(
      "S3_UPLOAD_STATE_INVALID",
      "S3 upload state is invalid.",
      error,
    );
  }
}

async function writeUploadState(
  statePath: string,
  state: UploadState,
  signal: AbortSignal | undefined,
): Promise<void> {
  await writeFileAtomic(statePath, canonicalJson(state), {
    mode: 0o600,
    ...(signal === undefined ? {} : { signal }),
  });
}

function resolvePartSize(size: number, configuredMiB: number | undefined): number {
  return Math.max(
    (configuredMiB ?? DEFAULT_PART_SIZE_MIB) * MIB,
    Math.ceil(size / MAX_MULTIPART_PARTS),
  );
}

async function createUploadState(
  client: S3Client,
  config: S3DestinationConfig,
  localFile: string,
  runId: string,
  keys: RemoteKeys,
  digest: FileDigest,
  statePath: string,
  signal: AbortSignal | undefined,
  now: () => Date,
): Promise<UploadState> {
  let uploadId: string;
  try {
    const response = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: config.bucket,
        Key: keys.objectKey,
        ContentType: "application/octet-stream",
        Metadata: {
          "pgdumpster-sha256": digest.sha256,
          "pgdumpster-size": String(digest.size),
          "pgdumpster-run-id": runId,
        },
      }),
      requestOptions(signal),
    );
    if (response.UploadId === undefined || response.UploadId.length === 0) {
      throw destinationError(
        "S3_RESPONSE_INVALID",
        "S3 multipart creation did not return an upload ID.",
      );
    }
    uploadId = response.UploadId;
  } catch (error) {
    throw remoteFailure(
      signal,
      "S3_MULTIPART_CREATE_FAILED",
      "S3 multipart upload could not be created.",
      error,
    );
  }
  const state: UploadState = {
    schemaVersion: 1,
    bucket: config.bucket,
    objectKey: keys.objectKey,
    markerKey: keys.markerKey,
    runId,
    localFile: path.resolve(localFile),
    size: digest.size,
    sha256: digest.sha256,
    partSize: resolvePartSize(digest.size, config.partSizeMiB),
    uploadId,
    completedParts: [],
    createdAt: now().toISOString(),
  };
  await writeUploadState(statePath, state, signal);
  return state;
}

async function abortUpload(
  client: S3Client,
  state: UploadState,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: state.bucket,
        Key: state.objectKey,
        UploadId: state.uploadId,
      }),
      requestOptions(signal),
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw remoteFailure(
      signal,
      "S3_MULTIPART_ABORT_FAILED",
      "Stale S3 multipart upload could not be aborted.",
      error,
    );
  }
}

async function reconcileCompletedParts(
  client: S3Client,
  state: UploadState,
  statePath: string,
  signal: AbortSignal | undefined,
): Promise<UploadState | undefined> {
  const remote = new Map<number, { etag: string; size: number }>();
  let marker: number | undefined;
  for (;;) {
    try {
      const response = await client.send(
        new ListPartsCommand({
          Bucket: state.bucket,
          Key: state.objectKey,
          UploadId: state.uploadId,
          ...(marker === undefined ? {} : { PartNumberMarker: marker }),
        }),
        requestOptions(signal),
      );
      for (const part of response.Parts ?? []) {
        if (
          part.PartNumber !== undefined &&
          part.ETag !== undefined &&
          part.Size !== undefined
        ) {
          remote.set(part.PartNumber, { etag: part.ETag, size: part.Size });
        }
      }
      if (response.IsTruncated !== true) break;
      if (response.NextPartNumberMarker === undefined) {
        throw destinationError(
          "S3_RESPONSE_INVALID",
          "Truncated S3 part listing omitted its continuation marker.",
        );
      }
      marker = response.NextPartNumberMarker;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw remoteFailure(
        signal,
        "S3_MULTIPART_LIST_FAILED",
        "S3 multipart parts could not be reconciled.",
        error,
      );
    }
  }
  const completedParts = state.completedParts.filter((part) => {
    const observed = remote.get(part.partNumber);
    return observed?.etag === part.etag && observed.size === part.size;
  });
  if (completedParts.length === state.completedParts.length) return state;
  const reconciled = { ...state, completedParts };
  await writeUploadState(statePath, reconciled, signal);
  return reconciled;
}

async function uploadRemainingParts(
  client: S3Client,
  config: S3DestinationConfig,
  localFile: string,
  state: UploadState,
  statePath: string,
  signal: AbortSignal | undefined,
): Promise<UploadState> {
  const totalParts = Math.ceil(state.size / state.partSize);
  if (totalParts < 1 || totalParts > MAX_MULTIPART_PARTS) {
    throw destinationError(
      "S3_MULTIPART_INVALID",
      "Backup cannot be represented within the S3 multipart part limit.",
      undefined,
      { totalParts },
    );
  }
  const parts = new Map(
    state.completedParts.map((part) => [part.partNumber, part] as const),
  );
  const pending = Array.from({ length: totalParts }, (_, index) => index + 1).filter(
    (partNumber) => !parts.has(partNumber),
  );
  let checkpointWrites = Promise.resolve();
  await mapBounded(
    pending,
    config.maxConcurrency ?? DEFAULT_CONCURRENCY,
    async (partNumber, _index, workerSignal) => {
      const start = (partNumber - 1) * state.partSize;
      const size = Math.min(state.partSize, state.size - start);
      const end = start + size - 1;
      let etag: string;
      try {
        const response = await client.send(
          new UploadPartCommand({
            Bucket: state.bucket,
            Key: state.objectKey,
            UploadId: state.uploadId,
            PartNumber: partNumber,
            ContentLength: size,
            Body: createReadStream(localFile, {
              start,
              end,
              signal: workerSignal,
            }),
          }),
          requestOptions(workerSignal),
        );
        if (response.ETag === undefined || response.ETag.length === 0) {
          throw destinationError(
            "S3_RESPONSE_INVALID",
            `S3 multipart part ${partNumber} did not return an ETag.`,
          );
        }
        etag = response.ETag;
      } catch (error) {
        throw remoteFailure(
          workerSignal,
          "S3_UPLOAD_PART_FAILED",
          `S3 multipart part ${partNumber} failed.`,
          error,
        );
      }
      const part: CompletedPartState = { partNumber, etag, size };
      parts.set(partNumber, part);
      const completedParts = [...parts.values()].sort(
        (left, right) => left.partNumber - right.partNumber,
      );
      checkpointWrites = checkpointWrites.then(() =>
        writeUploadState(statePath, { ...state, completedParts }, signal),
      );
      await checkpointWrites;
    },
    signal,
  );
  await checkpointWrites;
  return {
    ...state,
    completedParts: [...parts.values()].sort(
      (left, right) => left.partNumber - right.partNumber,
    ),
  };
}

async function completeMultipartUpload(
  client: S3Client,
  state: UploadState,
  signal: AbortSignal | undefined,
): Promise<void> {
  const totalParts = Math.ceil(state.size / state.partSize);
  if (state.completedParts.length !== totalParts) {
    throw destinationError(
      "S3_MULTIPART_INCOMPLETE",
      "S3 multipart upload is missing completed parts.",
      undefined,
      { expectedParts: totalParts, completedParts: state.completedParts.length },
    );
  }
  try {
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: state.bucket,
        Key: state.objectKey,
        UploadId: state.uploadId,
        IfNoneMatch: "*",
        MultipartUpload: {
          Parts: state.completedParts.map(({ partNumber, etag }) => ({
            PartNumber: partNumber,
            ETag: etag,
          })),
        },
      }),
      requestOptions(signal),
    );
  } catch (error) {
    if (isPreconditionFailed(error)) {
      await abortUpload(client, state, signal);
      throw destinationError(
        "S3_OBJECT_ALREADY_EXISTS",
        "S3 backup object appeared concurrently and was not overwritten.",
        error,
      );
    }
    throw remoteFailure(
      signal,
      "S3_MULTIPART_COMPLETE_FAILED",
      "S3 multipart upload could not be completed.",
      error,
    );
  }
}

async function prepareUploadState(
  client: S3Client,
  config: S3DestinationConfig,
  localFile: string,
  runId: string,
  keys: RemoteKeys,
  digest: FileDigest,
  statePath: string,
  signal: AbortSignal | undefined,
  now: () => Date,
): Promise<UploadState> {
  let state = await readUploadState(statePath);
  if (state !== undefined) {
    if (
      state.bucket !== config.bucket ||
      state.objectKey !== keys.objectKey ||
      state.markerKey !== keys.markerKey ||
      state.runId !== runId
    ) {
      throw destinationError(
        "S3_UPLOAD_STATE_MISMATCH",
        "Existing S3 upload state belongs to a different destination or run.",
      );
    }
    if (
      state.localFile !== path.resolve(localFile) ||
      state.size !== digest.size ||
      state.sha256 !== digest.sha256
    ) {
      await abortUpload(client, state, signal);
      await rm(statePath, { force: true });
      state = undefined;
    }
  }
  if (state === undefined) {
    return createUploadState(
      client,
      config,
      localFile,
      runId,
      keys,
      digest,
      statePath,
      signal,
      now,
    );
  }
  const reconciled = await reconcileCompletedParts(
    client,
    state,
    statePath,
    signal,
  );
  if (reconciled !== undefined) return reconciled;
  await rm(statePath, { force: true });
  return createUploadState(
    client,
    config,
    localFile,
    runId,
    keys,
    digest,
    statePath,
    signal,
    now,
  );
}

export async function publishS3Backup(
  localFile: string,
  config: S3DestinationConfig,
  options: S3PublicationOptions,
): Promise<S3PublicationResult> {
  validateConfig(config);
  throwIfAborted(options.signal);
  const digest = await digestFile(localFile, options.signal);
  const keys = remoteKeys(config, options.runId, localFile);
  const client =
    options.client ?? createS3Client(config, options.environment ?? process.env);
  const statePath = options.statePath ?? `${localFile}.s3-upload.json`;
  const now = options.now ?? (() => new Date());

  const marker = await readMarker(
    client,
    config.bucket,
    keys.markerKey,
    options.signal,
  );
  if (marker !== undefined) {
    assertMarkerMatches(marker, options.runId, keys, digest);
    await verifyRemoteObject(
      client,
      config,
      keys.objectKey,
      digest,
      options.signal,
    );
    await rm(statePath, { force: true });
    return publicationResult(config, keys, digest, true);
  }

  if (
    (await headObject(client, config.bucket, keys.objectKey, options.signal)) !==
    undefined
  ) {
    await verifyRemoteObject(
      client,
      config,
      keys.objectKey,
      digest,
      options.signal,
    );
    const recoveredMarker: CompletionMarker = {
      schemaVersion: 1,
      type: "pgdumpster.s3.complete",
      runId: options.runId,
      objectKey: keys.objectKey,
      size: digest.size,
      sha256: digest.sha256,
      verifiedAt: now().toISOString(),
    };
    await writeMarker(client, config, recoveredMarker, keys, options.signal);
    await rm(statePath, { force: true });
    return publicationResult(config, keys, digest, true);
  }

  let state = await prepareUploadState(
    client,
    config,
    localFile,
    options.runId,
    keys,
    digest,
    statePath,
    options.signal,
    now,
  );
  state = await uploadRemainingParts(
    client,
    config,
    localFile,
    state,
    statePath,
    options.signal,
  );
  await completeMultipartUpload(client, state, options.signal);
  await verifyRemoteObject(
    client,
    config,
    keys.objectKey,
    digest,
    options.signal,
  );
  const completeMarker: CompletionMarker = {
    schemaVersion: 1,
    type: "pgdumpster.s3.complete",
    runId: options.runId,
    objectKey: keys.objectKey,
    size: digest.size,
    sha256: digest.sha256,
    verifiedAt: now().toISOString(),
  };
  await writeMarker(client, config, completeMarker, keys, options.signal);
  await rm(statePath, { force: true });
  return publicationResult(config, keys, digest, false);
}

interface ParsedLocator {
  bucket: string;
  directoryKey: string;
  markerKey: string;
}

function parseLocator(locator: string): ParsedLocator {
  try {
    const url = new URL(locator);
    if (url.protocol !== "s3:" || url.hostname.length === 0) {
      throw new Error("wrong scheme or missing bucket");
    }
    const key = url.pathname
      .slice(1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const directoryKey = key.endsWith("COMPLETE.json")
      ? key.slice(0, -"COMPLETE.json".length)
      : key.endsWith("/")
        ? key
        : `${key}/`;
    if (directoryKey.length === 0) throw new Error("missing backup directory");
    return {
      bucket: url.hostname,
      directoryKey,
      markerKey: `${directoryKey}COMPLETE.json`,
    };
  } catch (error) {
    throw destinationError(
      "S3_LOCATOR_INVALID",
      "S3 backup locator must use s3://bucket/prefix/run-id/.",
      error,
    );
  }
}

function assertLocatorScope(
  locator: ParsedLocator,
  config: S3DestinationConfig,
): void {
  if (
    locator.bucket !== config.bucket ||
    !locator.directoryKey.startsWith(normalizePrefix(config.prefix))
  ) {
    throw destinationError(
      "S3_LOCATOR_OUT_OF_SCOPE",
      "S3 backup locator is outside the configured bucket/prefix scope.",
    );
  }
}

async function assertOutputDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw destinationError(
      "S3_DOWNLOAD_OUTPUT_INVALID",
      "S3 download output must be a real directory.",
    );
  }
}

function markerFileName(marker: CompletionMarker, locator: ParsedLocator): string {
  if (!marker.objectKey.startsWith(locator.directoryKey)) {
    throw destinationError(
      "S3_MARKER_INVALID",
      "S3 completion marker references an object outside its backup directory.",
    );
  }
  const suffix = marker.objectKey.slice(locator.directoryKey.length);
  if (
    suffix.length === 0 ||
    suffix.includes("/") ||
    (!suffix.endsWith(".tar.zst") && !suffix.endsWith(".tar.zst.age"))
  ) {
    throw destinationError(
      "S3_MARKER_INVALID",
      "S3 completion marker references an unsupported backup object.",
    );
  }
  return suffix;
}

export async function materializeS3Backup(
  locatorValue: string,
  outputDirectory: string,
  config: S3DestinationConfig,
  options: S3MaterializeOptions = {},
): Promise<string> {
  validateConfig(config);
  throwIfAborted(options.signal);
  const locator = parseLocator(locatorValue);
  assertLocatorScope(locator, config);
  const client =
    options.client ?? createS3Client(config, options.environment ?? process.env);
  const marker = await readMarker(
    client,
    locator.bucket,
    locator.markerKey,
    options.signal,
  );
  if (marker === undefined) {
    throw destinationError(
      "S3_BACKUP_INCOMPLETE",
      "S3 backup has no completion marker and is not a valid committed backup.",
    );
  }
  const fileName = markerFileName(marker, locator);
  await assertOutputDirectory(outputDirectory);
  const target = path.join(path.resolve(outputDirectory), fileName);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.partial-${randomUUID()}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await getObject(
      client,
      locator.bucket,
      marker.objectKey,
      options.signal,
      "S3_DOWNLOAD_FAILED",
      "S3 backup object could not be downloaded.",
    );
    handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const raw of assertStreamable(response.Body)) {
      throwIfAborted(options.signal);
      if (!(raw instanceof Uint8Array)) {
        throw destinationError(
          "S3_RESPONSE_INVALID",
          "S3 backup download produced an unsupported chunk type.",
        );
      }
      const chunk = Buffer.from(raw);
      await handle.write(chunk);
      hash.update(chunk);
      size += chunk.length;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    const sha256 = hash.digest("hex");
    if (size !== marker.size || sha256 !== marker.sha256) {
      throw integrityError("Downloaded S3 backup failed SHA-256 verification.", {
        expectedSize: marker.size,
        observedSize: size,
      });
    }
    await link(temporary, target);
    await rm(temporary);
    return target;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof PgDumpsterError) throw error;
    if (fsCode(error) === "EEXIST") {
      throw destinationError(
        "S3_DOWNLOAD_OUTPUT_EXISTS",
        "S3 download output already exists.",
        error,
      );
    }
    throw destinationError(
      "S3_DOWNLOAD_FAILED",
      "S3 backup could not be materialized locally.",
      error,
    );
  }
}
