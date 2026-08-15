import {
  collectFileStorageConsistencySnapshot,
  collectLinkedFileStorageConsistencySnapshot,
  fileStorageConsistencySnapshotsEqual,
  type FileStorageConsistencySnapshot,
} from "../../storage/consistency.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import { removeSafeBundlePath } from "../../security/safe-remove.js";
import type { SecretValue } from "../../security/secret-value.js";
import { PgDumpsterError } from "../errors/error.js";
import type {
  BackupStepConsistencyAdapter,
  BackupStepConsistencyContext,
  BackupStepResult,
} from "./coordinator.js";

export interface FileStorageConsistencyAdapterSource {
  databaseUrl?: SecretValue | undefined;
  linked?: boolean | undefined;
}

const SHARED_DATABASE_ARTIFACT = "database/storage-metadata.sql";
const FILE_CATALOG_ARTIFACT = "storage/file-catalog.json";
const FILE_OBJECT_INDEX_ARTIFACT = "secrets/storage/file-object-index.json";
const FILE_OBJECT_DIRECTORY = "storage/file-objects";

function assertStorageSource(
  source: FileStorageConsistencyAdapterSource,
): void {
  if ((source.databaseUrl === undefined) === (source.linked !== true)) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message:
        "File Storage consistency requires exactly one catalog source: a direct database URL or linked Supabase mode.",
      retryable: false,
    });
  }
}

function assertStorageArtifact(artifact: string): boolean {
  assertSafeBundlePath(artifact);

  if (artifact === SHARED_DATABASE_ARTIFACT) return false;

  if (
    artifact !== FILE_CATALOG_ARTIFACT &&
    artifact !== FILE_OBJECT_INDEX_ARTIFACT &&
    !artifact.startsWith(`${FILE_OBJECT_DIRECTORY}/`)
  ) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
      message:
        "File Storage consistency cleanup refused an artifact outside the File Storage backup scope.",
      retryable: false,
      component: "storage.file_objects",
      details: { artifact },
    });
  }

  return true;
}

async function cleanupFileStorageArtifacts(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const artifacts = [...new Set(result.artifacts)];
  const owned = artifacts.filter(assertStorageArtifact);
  for (const artifact of owned) {
    await removeSafeBundlePath(context.workspaceRoot, artifact, {
      signal: context.signal,
    });
  }
  context.signal?.throwIfAborted();
}

async function cleanupPartialFileStorageArtifacts(
  context: BackupStepConsistencyContext,
): Promise<void> {
  for (const artifact of [FILE_CATALOG_ARTIFACT, FILE_OBJECT_INDEX_ARTIFACT]) {
    await removeSafeBundlePath(context.workspaceRoot, artifact, {
      signal: context.signal,
    });
  }
  await removeSafeBundlePath(context.workspaceRoot, FILE_OBJECT_DIRECTORY, {
    recursive: true,
    signal: context.signal,
  });
}

function snapshotsEqual(before: unknown, after: unknown): boolean {
  return fileStorageConsistencySnapshotsEqual(
    before as FileStorageConsistencySnapshot,
    after as FileStorageConsistencySnapshot,
  );
}

export function createFileStorageConsistencyAdapter(
  source: FileStorageConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  assertStorageSource(source);
  return {
    snapshot: ({ signal }) =>
      source.databaseUrl === undefined
        ? collectLinkedFileStorageConsistencySnapshot(signal)
        : collectFileStorageConsistencySnapshot(source.databaseUrl, signal),
    cleanup: cleanupFileStorageArtifacts,
    cleanupPartial: cleanupPartialFileStorageArtifacts,
    equals: snapshotsEqual,
  };
}
