import {
  collectDatabaseConsistencySnapshot,
  collectLinkedDatabaseConsistencySnapshot,
  databaseConsistencySnapshotsEqual,
  type DatabaseConsistencySnapshot,
} from "../../database/consistency.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import { removeSafeBundlePath } from "../../security/safe-remove.js";
import type { SecretValue } from "../../security/secret-value.js";
import { PgDumpsterError } from "../errors/error.js";
import type {
  BackupStepConsistencyAdapter,
  BackupStepConsistencyContext,
  BackupStepResult,
} from "./coordinator.js";

export interface DatabaseConsistencyAdapterSource {
  databaseUrl?: SecretValue | undefined;
  linked?: boolean | undefined;
}

function assertDatabaseSource(source: DatabaseConsistencyAdapterSource): void {
  if ((source.databaseUrl === undefined) === (source.linked !== true)) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message:
        "Database consistency requires exactly one source: a direct database URL or linked Supabase mode.",
      retryable: false,
    });
  }
}

function assertDatabaseArtifact(artifact: string): void {
  assertSafeBundlePath(artifact);
  if (!artifact.startsWith("database/")) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
      message:
        "Database consistency cleanup refused an artifact outside the database backup scope.",
      retryable: false,
      component: "database.data",
      details: { artifact },
    });
  }
}

async function cleanupDatabaseArtifacts(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const artifacts = [...new Set(result.artifacts)];
  for (const artifact of artifacts) assertDatabaseArtifact(artifact);
  for (const artifact of artifacts) {
    await removeSafeBundlePath(context.workspaceRoot, artifact, {
      signal: context.signal,
    });
  }
  context.signal?.throwIfAborted();
}

async function cleanupPartialDatabaseArtifacts(
  context: BackupStepConsistencyContext,
): Promise<void> {
  await removeSafeBundlePath(context.workspaceRoot, "database", {
    recursive: true,
    signal: context.signal,
  });
}

function snapshotsEqual(before: unknown, after: unknown): boolean {
  return databaseConsistencySnapshotsEqual(
    before as DatabaseConsistencySnapshot,
    after as DatabaseConsistencySnapshot,
  );
}

export function createDatabaseConsistencyAdapter(
  source: DatabaseConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  assertDatabaseSource(source);
  return {
    snapshot: ({ signal }) =>
      source.databaseUrl === undefined
        ? collectLinkedDatabaseConsistencySnapshot(signal)
        : collectDatabaseConsistencySnapshot(source.databaseUrl, signal),
    cleanup: cleanupDatabaseArtifacts,
    cleanupPartial: cleanupPartialDatabaseArtifacts,
    equals: snapshotsEqual,
  };
}