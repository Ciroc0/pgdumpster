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
import {
  captureSpecializedStorage,
  type SpecializedStorageClient,
} from "../../storage/specialized.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import type {
  BackupStepConsistencyAdapter,
  BackupStepConsistencyContext,
  BackupStepResult,
} from "./coordinator.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface SpecializedStorageConsistencyAdapterSource {
  storage: SpecializedStorageClient;
}

interface CoverageMarker {
  id: string;
  status: CoverageEntry["status"];
  reasonCode: string | null;
}

interface CatalogDigest {
  path: string;
  sha256: string;
}

interface VectorDigest {
  bucketName: string;
  indexName: string;
  key: string;
  sha256: string;
}

interface VectorSummaryMarker {
  bucketName: string;
  indexName: string;
  vectorCount: number;
}

export interface SpecializedStorageConsistencySnapshot {
  schemaVersion: 1;
  coverage: CoverageMarker[];
  catalogArtifacts: CatalogDigest[];
  vectorSummary: VectorSummaryMarker[];
  vectors: VectorDigest[];
}

const VECTOR_BUCKETS_ARTIFACT = "storage/vector-buckets.json";
const VECTOR_INDEXES_ARTIFACT = "storage/vector-indexes.json";
const VECTOR_SUMMARY_ARTIFACT = "secrets/storage/vector-summary.json";
const ANALYTICS_BUCKETS_ARTIFACT = "storage/analytics-buckets.json";
const VECTOR_PAGE_PATTERN =
  /^secrets\/storage\/vectors\/[a-f0-9]{64}\/[0-9]{8}\.json$/u;
const ANALYTICS_CATALOG_PATTERN =
  /^storage\/analytics-catalog\/[a-f0-9]{64}\.json$/u;

function snapshotError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category: "consistency",
    message,
    retryable: false,
    component: "specialized-storage",
    ...(details === undefined ? {} : { details }),
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalOrder(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right), "en");
}

function normalizedAnalyticsCatalog(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const namespacesValue = value["namespaces"];
  if (!Array.isArray(namespacesValue)) return value;

  const namespaces = namespacesValue
    .map((namespace) => {
      if (
        namespace === null ||
        typeof namespace !== "object" ||
        Array.isArray(namespace)
      ) {
        return namespace;
      }
      const record = namespace as Record<string, unknown>;
      const tablesValue = record["tables"];
      return {
        ...record,
        ...(Array.isArray(tablesValue)
          ? { tables: [...tablesValue].sort(canonicalOrder) }
          : {}),
      };
    })
    .sort((left, right) => {
      const leftNamespace =
        left !== null && typeof left === "object"
          ? Reflect.get(left, "namespace")
          : left;
      const rightNamespace =
        right !== null && typeof right === "object"
          ? Reflect.get(right, "namespace")
          : right;
      return canonicalOrder(leftNamespace, rightNamespace);
    });

  return { ...value, namespaces };
}

function normalizedCatalogArtifact(
  relativePath: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (ANALYTICS_CATALOG_PATTERN.test(relativePath)) {
    return normalizedAnalyticsCatalog(value);
  }
  return value;
}

function isOrdinarySpecializedArtifact(relativePath: string): boolean {
  return (
    relativePath === VECTOR_BUCKETS_ARTIFACT ||
    relativePath === VECTOR_INDEXES_ARTIFACT ||
    relativePath === ANALYTICS_BUCKETS_ARTIFACT ||
    ANALYTICS_CATALOG_PATTERN.test(relativePath)
  );
}

function parseVectorPage(
  relativePath: string,
  value: Readonly<Record<string, unknown>>,
): { bucketName: string; indexName: string; vectors: unknown[] } {
  const bucketName = value["bucketName"];
  const indexName = value["indexName"];
  const vectors = value["vectors"];
  if (
    typeof bucketName !== "string" ||
    typeof indexName !== "string" ||
    !Array.isArray(vectors)
  ) {
    throw snapshotError(
      "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
      "Specialized Storage consistency snapshot encountered an invalid vector page artifact.",
      { relativePath },
    );
  }
  return { bucketName, indexName, vectors };
}

function parseVectorSummary(
  value: Readonly<Record<string, unknown>>,
): VectorSummaryMarker[] {
  const indexes = value["indexes"];
  if (!Array.isArray(indexes)) {
    throw snapshotError(
      "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
      "Specialized Storage consistency snapshot encountered an invalid vector summary.",
    );
  }
  return indexes
    .map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw snapshotError(
          "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
          "Specialized Storage consistency snapshot encountered an invalid vector summary entry.",
        );
      }
      const bucketName = Reflect.get(entry, "bucketName") as unknown;
      const indexName = Reflect.get(entry, "indexName") as unknown;
      const vectorCount = Reflect.get(entry, "vectorCount") as unknown;
      if (
        typeof bucketName !== "string" ||
        typeof indexName !== "string" ||
        typeof vectorCount !== "number" ||
        !Number.isSafeInteger(vectorCount) ||
        vectorCount < 0
      ) {
        throw snapshotError(
          "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
          "Specialized Storage consistency snapshot encountered invalid vector summary fields.",
        );
      }
      return { bucketName, indexName, vectorCount };
    })
    .sort((left, right) =>
      `${left.bucketName}\0${left.indexName}`.localeCompare(
        `${right.bucketName}\0${right.indexName}`,
        "en",
      ),
    );
}

function createSpecializedSnapshotSinks(): {
  ordinary: BundleArtifactSink;
  protectedSink: ProtectedArtifactSink;
  finalize(coverage: readonly CoverageEntry[]): SpecializedStorageConsistencySnapshot;
} {
  const catalogDigests = new Map<string, CatalogDigest>();
  const vectorDigests = new Map<string, VectorDigest>();
  const seenVectorPages = new Set<string>();
  let vectorSummary: VectorSummaryMarker[] | undefined;

  const ordinary: BundleArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (!isOrdinarySpecializedArtifact(relativePath)) {
        return Promise.reject(
          snapshotError(
            "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
            "Specialized Storage consistency snapshot received an unexpected ordinary artifact.",
            { relativePath },
          ),
        );
      }
      if (catalogDigests.has(relativePath)) {
        return Promise.reject(
          snapshotError(
            "CONSISTENCY_SNAPSHOT_DUPLICATE_ARTIFACT",
            "Specialized Storage consistency snapshot wrote a catalog artifact more than once.",
            { relativePath },
          ),
        );
      }
      const normalized = normalizedCatalogArtifact(relativePath, value);
      const encoded = new TextEncoder().encode(canonicalJson(normalized));
      const sha256 = createHash("sha256").update(encoded).digest("hex");
      catalogDigests.set(relativePath, { path: relativePath, sha256 });
      return Promise.resolve({ bytes: encoded.byteLength, sha256 });
    },
    async writeStream(
      relativePath: string,
      stream: ReadableStream<Uint8Array>,
      _options: StreamArtifactOptions,
    ): Promise<ArtifactWriteResult> {
      await stream.cancel().catch(() => undefined);
      throw snapshotError(
        "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
        "Specialized Storage consistency snapshot received an unexpected streamed artifact.",
        { relativePath },
      );
    },
  };

  const protectedSink: ProtectedArtifactSink = {
    writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (relativePath === VECTOR_SUMMARY_ARTIFACT) {
        if (vectorSummary !== undefined) {
          return Promise.reject(
            snapshotError(
              "CONSISTENCY_SNAPSHOT_DUPLICATE_ARTIFACT",
              "Specialized Storage consistency snapshot wrote the vector summary more than once.",
              { relativePath },
            ),
          );
        }
        vectorSummary = parseVectorSummary(value);
        return Promise.resolve();
      }
      if (!VECTOR_PAGE_PATTERN.test(relativePath)) {
        return Promise.reject(
          snapshotError(
            "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
            "Specialized Storage consistency snapshot received an unexpected protected artifact.",
            { relativePath },
          ),
        );
      }
      if (seenVectorPages.has(relativePath)) {
        return Promise.reject(
          snapshotError(
            "CONSISTENCY_SNAPSHOT_DUPLICATE_ARTIFACT",
            "Specialized Storage consistency snapshot wrote a vector page more than once.",
            { relativePath },
          ),
        );
      }
      seenVectorPages.add(relativePath);
      const page = parseVectorPage(relativePath, value);
      for (const vector of page.vectors) {
        if (vector === null || typeof vector !== "object" || Array.isArray(vector)) {
          return Promise.reject(
            snapshotError(
              "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
              "Specialized Storage consistency snapshot encountered an invalid vector value.",
              { relativePath },
            ),
          );
        }
        const key = Reflect.get(vector, "key") as unknown;
        if (typeof key !== "string" || key.length === 0) {
          return Promise.reject(
            snapshotError(
              "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
              "Specialized Storage consistency snapshot encountered a vector without a stable key.",
              { relativePath },
            ),
          );
        }
        const identity = `${page.bucketName}\0${page.indexName}\0${key}`;
        if (vectorDigests.has(identity)) {
          return Promise.reject(
            snapshotError(
              "CONSISTENCY_SNAPSHOT_DUPLICATE_VECTOR",
              "Specialized Storage consistency snapshot observed the same vector identity more than once.",
              {
                bucketName: page.bucketName,
                indexName: page.indexName,
                key,
              },
            ),
          );
        }
        vectorDigests.set(identity, {
          bucketName: page.bucketName,
          indexName: page.indexName,
          key,
          sha256: digest(vector),
        });
      }
      return Promise.resolve();
    },
  };

  return {
    ordinary,
    protectedSink,
    finalize(coverage) {
      for (const required of [
        VECTOR_BUCKETS_ARTIFACT,
        VECTOR_INDEXES_ARTIFACT,
        ANALYTICS_BUCKETS_ARTIFACT,
      ]) {
        if (!catalogDigests.has(required)) {
          throw snapshotError(
            "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
            "Specialized Storage consistency snapshot did not observe a required catalog artifact.",
            { artifact: required },
          );
        }
      }
      if (vectorSummary === undefined) {
        throw snapshotError(
          "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
          "Specialized Storage consistency snapshot did not observe the vector summary.",
          { artifact: VECTOR_SUMMARY_ARTIFACT },
        );
      }

      for (const artifact of coverage.flatMap(({ artifacts }) => artifacts)) {
        if (
          catalogDigests.has(artifact) ||
          artifact === VECTOR_SUMMARY_ARTIFACT ||
          seenVectorPages.has(artifact)
        ) {
          continue;
        }
        throw snapshotError(
          "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
          "Specialized Storage coverage referenced an artifact that was not observed by the consistency snapshot.",
          { artifact },
        );
      }

      return {
        schemaVersion: 1,
        coverage: coverage
          .map(({ id, status, reasonCode }) => ({
            id,
            status,
            reasonCode: reasonCode ?? null,
          }))
          .sort((left, right) => left.id.localeCompare(right.id, "en")),
        catalogArtifacts: [...catalogDigests.values()].sort((left, right) =>
          left.path.localeCompare(right.path, "en"),
        ),
        vectorSummary,
        vectors: [...vectorDigests.values()].sort((left, right) =>
          `${left.bucketName}\0${left.indexName}\0${left.key}`.localeCompare(
            `${right.bucketName}\0${right.indexName}\0${right.key}`,
            "en",
          ),
        ),
      };
    },
  };
}

async function collectSpecializedStorageConsistencySnapshot(
  source: SpecializedStorageConsistencyAdapterSource,
  signal?: AbortSignal,
): Promise<SpecializedStorageConsistencySnapshot> {
  signal?.throwIfAborted();
  const sinks = createSpecializedSnapshotSinks();
  try {
    const captured = await captureSpecializedStorage(
      source.storage,
      sinks.ordinary,
      sinks.protectedSink,
      signal,
    );
    signal?.throwIfAborted();
    return sinks.finalize(captured.coverage);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PgDumpsterError && error.category === "consistency") {
      throw error;
    }
    throw new PgDumpsterError({
      code: "SPECIALIZED_STORAGE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      message: "Specialized Storage consistency snapshot failed.",
      retryable: false,
      component: "specialized-storage",
      cause: error,
    });
  }
}

function specializedArtifactTarget(
  workspaceRoot: string,
  artifact: string,
): string {
  assertSafeBundlePath(artifact);
  if (
    !isOrdinarySpecializedArtifact(artifact) &&
    artifact !== VECTOR_SUMMARY_ARTIFACT &&
    !VECTOR_PAGE_PATTERN.test(artifact)
  ) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      category: "consistency",
      message:
        "Specialized Storage consistency cleanup refused an artifact outside its backup scope.",
      retryable: false,
      component: "specialized-storage",
      details: { artifact },
    });
  }
  return path.join(workspaceRoot, ...artifact.split("/"));
}

async function cleanupSpecializedStorageArtifacts(
  result: BackupStepResult,
  context: BackupStepConsistencyContext,
): Promise<void> {
  context.signal?.throwIfAborted();
  const targets = [
    ...new Set(
      result.artifacts.map((artifact) =>
        specializedArtifactTarget(context.workspaceRoot, artifact),
      ),
    ),
  ];
  for (const target of targets) {
    context.signal?.throwIfAborted();
    await rm(target, { force: true });
  }
  context.signal?.throwIfAborted();
}

export function createSpecializedStorageConsistencyAdapter(
  source: SpecializedStorageConsistencyAdapterSource,
): BackupStepConsistencyAdapter {
  return {
    snapshot: ({ signal }) =>
      collectSpecializedStorageConsistencySnapshot(source, signal),
    cleanup: cleanupSpecializedStorageArtifacts,
  };
}
