import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import { canonicalJson } from "../utils/canonical-json.js";
import {
  collectFileStorageCatalog,
  collectLinkedFileStorageCatalog,
  type FileStorageCatalog,
} from "./catalog.js";

export interface FileStorageConsistencySnapshot {
  schemaVersion: 1;
  catalog: FileStorageCatalog;
}

export interface FileStorageConsistencyDependencies {
  collectCatalog?: (
    outputDirectory: string,
    signal?: AbortSignal,
  ) => Promise<FileStorageCatalog>;
}

function comparableCatalog(catalog: FileStorageCatalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    buckets: catalog.buckets,
    objects: catalog.objects.map(({ lastAccessedAt: _lastAccessedAt, ...object }) =>
      object,
    ),
  };
}

function comparableSnapshot(snapshot: FileStorageConsistencySnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    catalog: comparableCatalog(snapshot.catalog),
  };
}

export function fileStorageConsistencySnapshotsEqual(
  before: FileStorageConsistencySnapshot,
  after: FileStorageConsistencySnapshot,
): boolean {
  // Reading an object may itself advance storage.objects.last_accessed_at.
  // That field therefore cannot participate in drift equality without making
  // pgDumpster detect its own reads as source mutations.
  return (
    canonicalJson(comparableSnapshot(before)) ===
    canonicalJson(comparableSnapshot(after))
  );
}

export function storageObjectEtag(
  metadata: Record<string, unknown> | null,
): string | undefined {
  if (metadata === null) return undefined;
  for (const key of ["eTag", "etag", "ETag"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

async function collectSnapshot(
  signal: AbortSignal | undefined,
  collectCatalog: (
    outputDirectory: string,
    signal?: AbortSignal,
  ) => Promise<FileStorageCatalog>,
): Promise<FileStorageConsistencySnapshot> {
  signal?.throwIfAborted();
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-storage-consistency-"),
  );

  try {
    const catalog = await collectCatalog(temporaryRoot, signal);
    signal?.throwIfAborted();
    return { schemaVersion: 1, catalog };
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "STORAGE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      message: "File Storage consistency inventory could not be collected safely.",
      retryable: false,
      component: "storage.file_objects",
      cause: error,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function collectFileStorageConsistencySnapshot(
  connectionString: SecretValue,
  signal?: AbortSignal,
  dependencies: FileStorageConsistencyDependencies = {},
): Promise<FileStorageConsistencySnapshot> {
  return collectSnapshot(
    signal,
    dependencies.collectCatalog ??
      ((outputDirectory, snapshotSignal) =>
        collectFileStorageCatalog(
          connectionString,
          outputDirectory,
          snapshotSignal,
        )),
  );
}

export function collectLinkedFileStorageConsistencySnapshot(
  signal?: AbortSignal,
  dependencies: FileStorageConsistencyDependencies = {},
): Promise<FileStorageConsistencySnapshot> {
  return collectSnapshot(
    signal,
    dependencies.collectCatalog ??
      ((outputDirectory, snapshotSignal) =>
        collectLinkedFileStorageCatalog(outputDirectory, snapshotSignal)),
  );
}
