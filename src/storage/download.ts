import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import { assertStorageObjectResponseEvidence } from "./object-evidence.js";

export interface StorageObjectSource {
  bucket: string;
  name: string;
  expectedBytes?: number | undefined;
  version?: string | null | undefined;
  updatedAt?: string | null | undefined;
  etag?: string | null | undefined;
}

export interface DownloadedStorageObject {
  bucket: string;
  name: string;
  contentId: string;
  path: string;
  sha256: string;
  bytes: number;
  version?: string | null | undefined;
  updatedAt?: string | null | undefined;
}

export interface StorageDownloadOptions {
  projectRef: string;
  storageKey: SecretValue;
  outputDirectory: string;
  fetch?: typeof fetch;
  signal?: AbortSignal | undefined;
  maxAttempts?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function objectUrl(projectRef: string, bucket: string, name: string): string {
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) {
    throw new PgDumpsterError({
      code: "PROJECT_REF_INVALID",
      category: "config",
      message: "Storage project ref is invalid.",
      retryable: false,
    });
  }
  const nameSegments = name.split("/");
  if (
    bucket.length === 0 ||
    name.length === 0 ||
    name.includes("\0") ||
    nameSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new PgDumpsterError({
      code: "PLATFORM_API_CONTRACT_CHANGED",
      category: "platform_contract",
      message: "Storage object identity is invalid.",
      retryable: false,
      component: "storage.file_objects",
    });
  }
  const encodedBucket = encodeURIComponent(bucket);
  const encodedName = nameSegments.map(encodeURIComponent).join("/");
  return `https://${projectRef}.supabase.co/storage/v1/object/${encodedBucket}/${encodedName}`;
}

function contentId(source: StorageObjectSource): string {
  return createHash("sha256")
    .update(source.bucket)
    .update("\0")
    .update(source.name)
    .digest("hex");
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Storage download was cancelled"),
        );
      },
      { once: true },
    );
  });
}

function retryDelay(attempt: number, random: () => number): number {
  return Math.floor(Math.min(10_000, 250 * 2 ** (attempt - 1)) * random());
}

function storageError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PgDumpsterError {
  return new PgDumpsterError({
    code: "STORAGE_OBJECT_DOWNLOAD_FAILED",
    category: "storage",
    message,
    retryable: false,
    component: "storage.file_objects",
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export async function downloadStorageObject(
  source: StorageObjectSource,
  options: StorageDownloadOptions,
): Promise<DownloadedStorageObject> {
  options.signal?.throwIfAborted();
  const outputStat = await lstat(options.outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw storageError("Storage output must be a real directory.");
  }
  const id = contentId(source);
  const relativePath = `storage/file-objects/${id.slice(0, 2)}/${id}`;
  const finalPath = path.join(
    options.outputDirectory,
    ...relativePath.split("/"),
  );
  await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  const request = options.fetch ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 5;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const url = objectUrl(options.projectRef, source.bucket, source.name);
  const key = options.storageKey.expose();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();
    const temporaryPath = `${finalPath}.partial-${randomUUID()}`;
    try {
      const response = await request(url, {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, apikey: key },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok || response.body === null) {
        if (
          attempt < maxAttempts &&
          (response.status === 429 || response.status >= 500)
        ) {
          await response.body?.cancel().catch(() => undefined);
          await sleep(retryDelay(attempt, random), options.signal);
          continue;
        }
        await response.body?.cancel().catch(() => undefined);
        throw storageError("Storage object request failed.", {
          httpStatus: response.status,
          attempt,
        });
      }
      try {
        assertStorageObjectResponseEvidence(source.etag, response);
      } catch (error) {
        await response.body.cancel().catch(() => undefined);
        throw error;
      }
      const digest = createHash("sha256");
      let bytes = 0;
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        hashing,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        { signal: options.signal },
      );
      if (
        source.expectedBytes !== undefined &&
        bytes !== source.expectedBytes
      ) {
        throw new PgDumpsterError({
          code: "STORAGE_OBJECT_CHANGED_DURING_COPY",
          category: "consistency",
          message: "Storage object byte count changed during copy.",
          retryable: false,
          component: "storage.file_objects",
          details: { expectedBytes: source.expectedBytes, actualBytes: bytes },
        });
      }
      await link(temporaryPath, finalPath);
      await rm(temporaryPath);
      return {
        bucket: source.bucket,
        name: source.name,
        contentId: id,
        path: relativePath,
        sha256: digest.digest("hex"),
        bytes,
        ...(source.version === undefined ? {} : { version: source.version }),
        ...(source.updatedAt === undefined
          ? {}
          : { updatedAt: source.updatedAt }),
      };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      options.signal?.throwIfAborted();
      if (attempt < maxAttempts && !(error instanceof PgDumpsterError)) {
        await sleep(retryDelay(attempt, random), options.signal);
        continue;
      }
      if (error instanceof PgDumpsterError) throw error;
      throw storageError("Storage object download failed.", { attempt }, error);
    }
  }
  throw storageError("Storage object retry limit was exhausted.");
}
