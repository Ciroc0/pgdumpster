import { rm } from "node:fs/promises";
import path from "node:path";

import {
  collectFileStorageConsistencySnapshot,
  collectLinkedFileStorageConsistencySnapshot,
  fileStorageConsistencySnapshotsEqual,
  type FileStorageConsistencySnapshot,
} from "../../storage/consistency.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
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

function storageArtifactTarget(
  workspaceRoot: string,
  artifact: string,
): string | undefined {
  assertSafeBundlePath(artifact);

  if (artifact === SHARED_DATABASE_ARTIFACT) {
    // This dump is produced by the database step and merely referenced by the
    // File Storage coverage record. Deleting it here would corrupt a completed
    // database checkpoint during a Storage consistency retry.
    return undefined;
  }

  if (
    artifact !== "storage/file-catalog.json" &&
    artifact !== "secrets/storage/file-object-index.json" &&
    !artifact.startsWith("storage/file-objects/")
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

  return path.join(workspaceRoot, ...artifact.split("/"));
}

async function cleanupFileStorageArtifacts(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const targets = [
    ...new Set(
      result.artifacts
        .map((artifact) =>
          storageArtifactTarget(context.workspaceRoot, artifact),
        )
        .filter((target): target is string => target !== undefined),
    ),
  ];

  for (const target of targets) {
    context.signal?.throwIfAborted();
    await rm(target, { force: true });
  }
  context.signal?.throwIfAborted();
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
    equals: snapshotsEqual,
  };
}
