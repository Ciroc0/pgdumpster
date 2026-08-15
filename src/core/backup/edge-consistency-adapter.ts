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
import type { ManagementClient } from "../../supabase/management/client.js";
import { captureEdgeState } from "../../supabase/management/edge.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import type {
  BackupStepConsistencyAdapter,
  BackupStepConsistencyContext,
  BackupStepResult,
} from "./coordinator.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface EdgeConsistencyAdapterSource {
  management: ManagementClient;
  projectRef: string;
  maxApiConcurrency: number;
}

interface EdgeCoverageMarker {
  id: string;
  status: CoverageEntry["status"];
  reasonCode: string | null;
}

export interface EdgeConsistencySnapshot {
  schemaVersion: 1;
  functionsIndexSha256: string;
  secretDigestsSha256: string;
  coverage: EdgeCoverageMarker[];
}

const FUNCTION_INDEX_ARTIFACT = "functions/index.json";
const SECRET_DIGEST_ARTIFACT = "secrets/edge-secret-digests.json";
const FUNCTION_BODY_PATTERN = /^functions\/[A-Za-z0-9_-]+\/source\.multipart$/u;
const EMPTY_STREAM_SHA256 = createHash("sha256").digest("hex");

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function invalidSnapshotArtifact(
  relativePath: string,
  message: string,
): PgDumpsterError {
  return new PgDumpsterError({
    code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
    category: "consistency",
    message,
    retryable: false,
    component: "edge",
    details: { relativePath },
  });
}

function normalizedFunctionIndex(
  value: Readonly<Record<string, unknown>>,
): unknown {
  const functions = value["functions"];
  if (!Array.isArray(functions)) {
    throw invalidSnapshotArtifact(
      FUNCTION_INDEX_ARTIFACT,
      "Edge consistency snapshot expected functions/index.json to contain a functions array.",
    );
  }

  return {
    schemaVersion: value["schemaVersion"],
    representation: value["representation"],
    functions: functions.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw invalidSnapshotArtifact(
          FUNCTION_INDEX_ARTIFACT,
          "Edge consistency snapshot encountered an invalid function index entry.",
        );
      }
      const metadata = Reflect.get(entry, "metadata") as unknown;
      const body = Reflect.get(entry, "body") as unknown;
      const contentType =
        body !== null && typeof body === "object"
          ? (Reflect.get(body, "contentType") as unknown)
          : undefined;
      return { metadata, contentType };
    }),
  };
}

function createEdgeSnapshotSinks(): {
  ordinary: BundleArtifactSink;
  protectedSink: ProtectedArtifactSink;
  finalize(coverage: readonly CoverageEntry[]): EdgeConsistencySnapshot;
} {
  let functionsIndexSha256: string | undefined;
  let secretDigestsSha256: string | undefined;

  const ordinary: BundleArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (relativePath !== FUNCTION_INDEX_ARTIFACT) {
        return Promise.reject(
          invalidSnapshotArtifact(
            relativePath,
            "Edge consistency snapshot received an unexpected ordinary artifact.",
          ),
        );
      }
      const normalized = normalizedFunctionIndex(value);
      const bytes = new TextEncoder().encode(canonicalJson(normalized));
      functionsIndexSha256 = createHash("sha256").update(bytes).digest("hex");
      return Promise.resolve({
        bytes: bytes.byteLength,
        sha256: functionsIndexSha256,
      });
    },
    async writeStream(
      relativePath: string,
      stream: ReadableStream<Uint8Array>,
      options: StreamArtifactOptions,
    ): Promise<ArtifactWriteResult> {
      options.signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (!FUNCTION_BODY_PATTERN.test(relativePath)) {
        await stream.cancel().catch(() => undefined);
        throw invalidSnapshotArtifact(
          relativePath,
          "Edge consistency snapshot received an unexpected streamed artifact.",
        );
      }
      // Edge capture validates function metadata before and after the body
      // response. The consistency probe only needs that metadata evidence and
      // response content type, so cancel the body instead of downloading the
      // full deployment a second time for each pre/post snapshot.
      await stream.cancel();
      return { bytes: 0, sha256: EMPTY_STREAM_SHA256 };
    },
  };

  const protectedSink: ProtectedArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (relativePath !== SECRET_DIGEST_ARTIFACT) {
        return Promise.reject(
          invalidSnapshotArtifact(
            relativePath,
            "Edge consistency snapshot received an unexpected protected artifact.",
          ),
        );
      }
      secretDigestsSha256 = digest(value);
      return Promise.resolve();
    },
  };

  return {
    ordinary,
    protectedSink,
    finalize(coverage) {
      if (
        functionsIndexSha256 === undefined ||
        secretDigestsSha256 === undefined
      ) {
        throw new PgDumpsterError({
          code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
          category: "consistency",
          message:
            "Edge consistency snapshot did not observe all required source markers.",
          retryable: false,
          component: "edge",
        });
      }
      return {
        schemaVersion: 1,
        functionsIndexSha256,
        secretDigestsSha256,
        coverage: coverage
          .map(({ id, status, reasonCode }) => ({
            id,
            status,
            reasonCode: reasonCode ?? null,
          }))
          .sort((left, right) => left.id.localeCompare(right.id, "en")),
      };
    },
  };
}

async function collectEdgeConsistencySnapshot(
  source: EdgeConsistencyAdapterSource,
  signal?: AbortSignal,
): Promise<EdgeConsistencySnapshot> {
  signal?.throwIfAborted();
  const sinks = createEdgeSnapshotSinks();
  try {
    const captured = await captureEdgeState(
      source.management,
      source.projectRef,
      sinks.protectedSink,
      sinks.ordinary,
      { maxConcurrency: source.maxApiConcurrency, signal },
    );
    signal?.throwIfAborted();
    return sinks.finalize(captured.coverage);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PgDumpsterError && error.category === "consistency") {
      throw error;
    }
    throw new PgDumpsterError({
      code: "EDGE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      message: "Edge consistency snapshot failed.",
      retryable: false,
      component: "edge",
      cause: error,
    });
  }
}

function edgeArtifactTarget(workspaceRoot: string, artifact: string): string {
  assertSafeBundlePath(artifact);
  if (
    artifact !== FUNCTION_INDEX_ARTIFACT &&
    artifact !== SECRET_DIGEST_ARTIFACT &&
    !FUNCTION_BODY_PATTERN.test(artifact)
  ) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
      message:
        "Edge consistency cleanup refused an artifact outside the Edge backup scope.",
      retryable: false,
      component: "edge",
      details: { artifact },
    });
  }
  return path.join(workspaceRoot, ...artifact.split("/"));
}

async function cleanupEdgeArtifacts(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const targets = [
    ...new Set(
      result.artifacts.map((artifact) =>
        edgeArtifactTarget(context.workspaceRoot, artifact),
      ),
    ),
  ];
  for (const target of targets) {
    context.signal?.throwIfAborted();
    await rm(target, { force: true });
  }
  context.signal?.throwIfAborted();
}

async function cleanupPartialEdgeArtifacts(
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  await rm(path.join(context.workspaceRoot, "functions"), {
    recursive: true,
    force: true,
  });
  context.signal?.throwIfAborted();
  await rm(
    path.join(context.workspaceRoot, ...SECRET_DIGEST_ARTIFACT.split("/")),
    { force: true },
  );
  context.signal?.throwIfAborted();
}

export function createEdgeConsistencyAdapter(
  source: EdgeConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return {
    snapshot: ({ signal }) => collectEdgeConsistencySnapshot(source, signal),
    cleanup: cleanupEdgeArtifacts,
    cleanupPartial: cleanupPartialEdgeArtifacts,
  };
}