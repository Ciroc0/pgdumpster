import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type {
  ArtifactWriteResult,
  BundleArtifactSink,
  StreamArtifactOptions,
} from "../bundle/artifact-sink.js";
import type { CoverageDocument } from "../bundle/schemas.js";
import { PgDumpsterError } from "../errors/error.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import { Redactor } from "../../security/redactor.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { captureApiKeys } from "../../supabase/management/api-keys.js";
import { captureAuthControlPlane } from "../../supabase/management/auth.js";
import type { ManagementClient } from "../../supabase/management/client.js";
import { captureControlPlaneState } from "../../supabase/management/control-plane.js";
import { capturePlatformV2State } from "../../supabase/management/platform-v2.js";
import { captureProjectState } from "../../supabase/management/project-state.js";
import type {
  BackupStepConsistencyAdapter,
  BackupStepConsistencyContext,
  BackupStepResult,
} from "./coordinator.js";

type CoverageEntry = CoverageDocument["components"][number];

type Protection = "ordinary" | "protected";

interface SnapshotArtifactDigest {
  path: string;
  sha256: string;
  bytes: number;
  protection: Protection;
}

interface SnapshotCoverageMarker {
  id: string;
  status: CoverageEntry["status"];
  reasonCode: string | null;
  artifacts: string[];
  children: unknown[];
}

export interface ManagementConsistencySnapshot {
  schemaVersion: 1;
  coverage: SnapshotCoverageMarker[];
  artifacts: SnapshotArtifactDigest[];
}

export interface ManagementConsistencyAdapterSource {
  management: ManagementClient;
  projectRef: string;
}

interface CaptureContext {
  ordinary: BundleArtifactSink;
  protectedSink: ProtectedArtifactSink;
  redactor: Redactor;
  signal?: AbortSignal | undefined;
}

type Capture = (context: CaptureContext) => Promise<CoverageEntry[]>;
type CoverageFilter = (entry: CoverageEntry) => boolean;

interface SnapshotCollector {
  ordinary: BundleArtifactSink;
  protectedSink: ProtectedArtifactSink;
  finalize(
    coverage: readonly CoverageEntry[],
    includeCoverage?: CoverageFilter,
  ): ManagementConsistencySnapshot;
}

const PROJECT_STATE_ARTIFACTS = new Set([
  "control-plane/project.json",
  "control-plane/disk-autoscale.json",
  "control-plane/addons.json",
  "control-plane/jit-access.json",
  "control-plane/branches.json",
  "diagnostics/health.json",
  "diagnostics/advisors-performance.json",
  "diagnostics/advisors-security.json",
]);

const CONTROL_PLANE_ARTIFACTS = new Set([
  "control-plane/database-postgres.json",
  "secrets/control-plane/database-pooler.json",
  "secrets/control-plane/database-pgbouncer.json",
  "control-plane/database-ssl.json",
  "control-plane/database-backup-schedule.json",
  "control-plane/realtime.json",
  "secrets/control-plane/postgrest.json",
  "control-plane/storage.json",
  "control-plane/custom-hostname.json",
  "control-plane/vanity-subdomain.json",
  "control-plane/network-restrictions.json",
  "control-plane/read-replicas.json",
]);

const PLATFORM_V2_ARTIFACTS = new Set([
  "secrets/control-plane/log-drains.json",
  "control-plane/private-link.json",
]);

const AUTH_ARTIFACTS = new Set([
  "secrets/auth-config.json",
  "secrets/auth-sso.json",
  "secrets/auth-tpa.json",
  "secrets/auth-signing-keys.json",
  "secrets/auth-legacy-signing-key.json",
]);

const API_KEY_ARTIFACTS = new Set([
  "secrets/api-keys.json",
  "secrets/api-legacy-keys-state.json",
]);

function artifactBytes(value: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function createSnapshotCollector(): SnapshotCollector {
  const digests = new Map<string, SnapshotArtifactDigest>();

  function validatePath(relativePath: string, protection: Protection): void {
    assertSafeBundlePath(relativePath);
    const secretPath = relativePath.startsWith("secrets/");
    if ((protection === "protected") !== secretPath) {
      throw new PgDumpsterError({
        code: "CONSISTENCY_SNAPSHOT_PROTECTION_MISMATCH",
        category: "consistency",
        message:
          "Management consistency snapshot artifact protection does not match its bundle path.",
        retryable: false,
        details: { relativePath, protection },
      });
    }
    if (digests.has(relativePath)) {
      throw new PgDumpsterError({
        code: "CONSISTENCY_SNAPSHOT_DUPLICATE_ARTIFACT",
        category: "consistency",
        message:
          "Management consistency snapshot attempted to write the same artifact more than once.",
        retryable: false,
        details: { relativePath },
      });
    }
  }

  function registerDigest(
    relativePath: string,
    protection: Protection,
    bytes: number,
    sha256: string,
  ): ArtifactWriteResult {
    validatePath(relativePath, protection);
    digests.set(relativePath, {
      path: relativePath,
      sha256,
      bytes,
      protection,
    });
    return { bytes, sha256 };
  }

  function registerBytes(
    relativePath: string,
    protection: Protection,
    bytes: Uint8Array,
  ): ArtifactWriteResult {
    return registerDigest(
      relativePath,
      protection,
      bytes.byteLength,
      createHash("sha256").update(bytes).digest("hex"),
    );
  }

  const ordinary: BundleArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      return Promise.resolve(
        registerBytes(relativePath, "ordinary", artifactBytes(value)),
      );
    },
    async writeStream(
      relativePath: string,
      stream: ReadableStream<Uint8Array>,
      options: StreamArtifactOptions,
    ) {
      if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
        throw new Error("maxBytes must be a non-negative safe integer");
      }
      options.signal?.throwIfAborted();
      validatePath(relativePath, "ordinary");
      const reader = stream.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for (;;) {
          options.signal?.throwIfAborted();
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > options.maxBytes) {
            throw new PgDumpsterError({
              code: "ARTIFACT_SIZE_LIMIT_EXCEEDED",
              category: "io",
              message: "Consistency snapshot artifact exceeded its byte limit.",
              retryable: false,
              details: { maxBytes: options.maxBytes, relativePath },
            });
          }
          hash.update(result.value);
        }
        const sha256 = hash.digest("hex");
        digests.set(relativePath, {
          path: relativePath,
          sha256,
          bytes,
          protection: "ordinary",
        });
        return { bytes, sha256 };
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
  };

  const protectedSink: ProtectedArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      registerBytes(relativePath, "protected", artifactBytes(value));
      return Promise.resolve();
    },
  };

  return {
    ordinary,
    protectedSink,
    finalize(coverage, includeCoverage = () => true) {
      const selected = coverage.filter(includeCoverage);
      const referenced = new Set(
        selected.flatMap(({ artifacts }) => artifacts),
      );
      for (const artifact of referenced) {
        if (!digests.has(artifact)) {
          throw new PgDumpsterError({
            code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
            category: "consistency",
            message:
              "Management consistency snapshot coverage referenced an artifact that was not captured.",
            retryable: false,
            details: { artifact },
          });
        }
      }
      return {
        schemaVersion: 1,
        coverage: selected
          .map((entry) => ({
            id: entry.id,
            status: entry.status,
            reasonCode: entry.reasonCode ?? null,
            artifacts: [...entry.artifacts].sort((left, right) =>
              left.localeCompare(right, "en"),
            ),
            children: entry.children ?? [],
          }))
          .sort((left, right) => left.id.localeCompare(right.id, "en")),
        artifacts: [...digests.values()]
          .filter(({ path: artifactPath }) => referenced.has(artifactPath))
          .sort((left, right) => left.path.localeCompare(right.path, "en")),
      };
    },
  };
}

async function collectManagementSnapshot(
  stepId: string,
  capture: Capture,
  signal?: AbortSignal,
  includeCoverage?: CoverageFilter,
): Promise<ManagementConsistencySnapshot> {
  signal?.throwIfAborted();
  const collector = createSnapshotCollector();
  try {
    const coverage = await capture({
      ordinary: collector.ordinary,
      protectedSink: collector.protectedSink,
      redactor: new Redactor(),
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    return collector.finalize(coverage, includeCoverage);
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof PgDumpsterError &&
      error.category === "consistency" &&
      error.code.startsWith("CONSISTENCY_SNAPSHOT_")
    ) {
      throw error;
    }
    throw new PgDumpsterError({
      code: "MANAGEMENT_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      message: "Management API consistency snapshot failed.",
      retryable: false,
      component: stepId,
      details: { stepId },
      cause: error,
    });
  }
}

function cleanupArtifacts(
  stepId: string,
  allowedArtifacts: ReadonlySet<string>,
): BackupStepConsistencyAdapter["cleanup"] {
  return async (
    result: BackupStepResult,
    context: BackupStepConsistencyContext,
  ): Promise<void> => {
    context.signal?.throwIfAborted();
    const artifacts = [...new Set(result.artifacts)];
    const targets = artifacts.map((artifact) => {
      assertSafeBundlePath(artifact);
      if (!allowedArtifacts.has(artifact)) {
        throw new PgDumpsterError({
          code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
          category: "consistency",
          message:
            "Management consistency cleanup refused an artifact outside its owning backup step.",
          retryable: false,
          component: stepId,
          details: { stepId, artifact },
        });
      }
      return path.join(context.workspaceRoot, ...artifact.split("/"));
    });

    for (const target of targets) {
      context.signal?.throwIfAborted();
      await rm(target, { force: true });
    }
    context.signal?.throwIfAborted();
  };
}

function adapter(
  stepId: string,
  allowedArtifacts: ReadonlySet<string>,
  capture: Capture,
  includeCoverage?: CoverageFilter,
): BackupStepConsistencyAdapter {
  return {
    snapshot: ({ signal }) =>
      collectManagementSnapshot(stepId, capture, signal, includeCoverage),
    cleanup: cleanupArtifacts(stepId, allowedArtifacts),
  };
}

export function createProjectStateConsistencyAdapter(
  source: ManagementConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return adapter(
    "project-state",
    PROJECT_STATE_ARTIFACTS,
    async ({ ordinary, signal }) =>
      (
        await captureProjectState(
          source.management,
          source.projectRef,
          ordinary,
          signal,
        )
      ).coverage,
    ({ id }) => !id.startsWith("diagnostics."),
  );
}

export function createControlPlaneConsistencyAdapter(
  source: ManagementConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return adapter(
    "control-plane",
    CONTROL_PLANE_ARTIFACTS,
    async ({ ordinary, protectedSink, redactor, signal }) =>
      (
        await captureControlPlaneState(
          source.management,
          source.projectRef,
          ordinary,
          protectedSink,
          redactor,
          signal,
        )
      ).coverage,
  );
}

export function createPlatformV2ConsistencyAdapter(
  source: ManagementConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return adapter(
    "platform-v2",
    PLATFORM_V2_ARTIFACTS,
    async ({ ordinary, protectedSink, redactor, signal }) =>
      (
        await capturePlatformV2State(
          source.management,
          source.projectRef,
          ordinary,
          protectedSink,
          redactor,
          signal,
        )
      ).coverage,
  );
}

export function createAuthConsistencyAdapter(
  source: ManagementConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return adapter(
    "auth",
    AUTH_ARTIFACTS,
    async ({ protectedSink, redactor, signal }) =>
      (
        await captureAuthControlPlane(
          source.management,
          source.projectRef,
          redactor,
          protectedSink,
          signal,
        )
      ).coverage,
  );
}

export function createApiKeysConsistencyAdapter(
  source: ManagementConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return adapter(
    "api-keys",
    API_KEY_ARTIFACTS,
    async ({ protectedSink, redactor, signal }) =>
      (
        await captureApiKeys(
          source.management,
          source.projectRef,
          redactor,
          protectedSink,
          signal,
        )
      ).coverage,
  );
}
