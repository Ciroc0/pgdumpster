import { rm } from "node:fs/promises";
import path from "node:path";

import {
  collectDatabaseConsistencySnapshot,
  collectLinkedDatabaseConsistencySnapshot,
  databaseConsistencySnapshotsEqual,
  type DatabaseConsistencySnapshot,
} from "../../database/consistency.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
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

function databaseArtifactTarget(
  workspaceRoot: string,
  artifact: string,
): string {
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
  return path.join(workspaceRoot, ...artifact.split("/"));
}

async function cleanupDatabaseArtifacts(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const targets = [...new Set(result.artifacts)].map((artifact) =>
    databaseArtifactTarget(context.workspaceRoot, artifact),
  );

  for (const target of targets) {
    context.signal?.throwIfAborted();
    await rm(target, { force: true });
  }
  context.signal?.throwIfAborted();
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
    equals: snapshotsEqual,
  };
}
