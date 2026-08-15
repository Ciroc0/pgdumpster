import { createHash } from "node:crypto";

import { PgDumpsterError } from "../errors/error.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import { Redactor } from "../../security/redactor.js";
import { removeSafeBundlePath } from "../../security/safe-remove.js";
import type { ManagementClient } from "../../supabase/management/client.js";
import {
  captureVaultRootKey,
  VAULT_ROOT_KEY_ARTIFACT,
} from "../../supabase/management/vault-root-key.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import type {
  BackupStepConsistencyAdapter,
  BackupStepConsistencyContext,
  BackupStepResult,
} from "./coordinator.js";

export interface VaultRootKeyConsistencyAdapterSource {
  management: ManagementClient;
  projectRef: string;
}

export interface VaultRootKeyConsistencySnapshot {
  schemaVersion: 1;
  artifactSha256: string;
}

function createVaultSnapshotSink(): {
  sink: ProtectedArtifactSink;
  finalize(): VaultRootKeyConsistencySnapshot;
} {
  let artifactSha256: string | undefined;
  const sink: ProtectedArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (relativePath !== VAULT_ROOT_KEY_ARTIFACT) {
        return Promise.reject(
          new PgDumpsterError({
            code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
            category: "consistency",
            message:
              "Vault root key consistency snapshot received an unexpected artifact.",
            retryable: false,
            component: "database.vault_root_key",
            details: { relativePath },
          }),
        );
      }
      artifactSha256 = createHash("sha256")
        .update(canonicalJson(value))
        .digest("hex");
      return Promise.resolve();
    },
  };
  return {
    sink,
    finalize() {
      if (artifactSha256 === undefined) {
        throw new PgDumpsterError({
          code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
          category: "consistency",
          message:
            "Vault root key consistency snapshot did not observe the root key artifact.",
          retryable: false,
          component: "database.vault_root_key",
        });
      }
      return { schemaVersion: 1, artifactSha256 };
    },
  };
}

async function collectVaultRootKeyConsistencySnapshot(
  source: VaultRootKeyConsistencyAdapterSource,
  signal?: AbortSignal,
): Promise<VaultRootKeyConsistencySnapshot> {
  signal?.throwIfAborted();
  const snapshot = createVaultSnapshotSink();
  try {
    await captureVaultRootKey(
      source.management,
      source.projectRef,
      new Redactor(),
      snapshot.sink,
      signal,
    );
    signal?.throwIfAborted();
    return snapshot.finalize();
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PgDumpsterError && error.category === "consistency") {
      throw error;
    }
    throw new PgDumpsterError({
      code: "VAULT_ROOT_KEY_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      message: "Vault root key consistency snapshot failed.",
      retryable: false,
      component: "database.vault_root_key",
      cause: error,
    });
  }
}

function assertVaultArtifact(artifact: string): void {
  assertSafeBundlePath(artifact);
  if (artifact !== VAULT_ROOT_KEY_ARTIFACT) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
      message:
        "Vault root key consistency cleanup refused an artifact outside its backup scope.",
      retryable: false,
      component: "database.vault_root_key",
      details: { artifact },
    });
  }
}

async function cleanupVaultRootKeyArtifact(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const artifacts = [...new Set(result.artifacts)];
  for (const artifact of artifacts) assertVaultArtifact(artifact);
  for (const artifact of artifacts) {
    await removeSafeBundlePath(context.workspaceRoot, artifact, {
      signal: context.signal,
    });
  }
  context.signal?.throwIfAborted();
}

async function cleanupPartialVaultRootKeyArtifact(
  context: BackupStepConsistencyContext,
): Promise<void> {
  await removeSafeBundlePath(context.workspaceRoot, VAULT_ROOT_KEY_ARTIFACT, {
    signal: context.signal,
  });
}

export function createVaultRootKeyConsistencyAdapter(
  source: VaultRootKeyConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return {
    snapshot: ({ signal }) =>
      collectVaultRootKeyConsistencySnapshot(source, signal),
    cleanup: cleanupVaultRootKeyArtifact,
    cleanupPartial: cleanupPartialVaultRootKeyArtifact,
  };
}