import { z } from "zod";

import type { BundleArtifactSink } from "../../core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../../core/bundle/schemas.js";
import { PgDumpsterError } from "../../core/errors/error.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import type { SecretValue } from "../../security/secret-value.js";
import { assertNoCaseFoldCollisions } from "../../security/bundle-path.js";
import { mapBounded } from "../../utils/bounded-concurrency.js";
import type { ManagementClient } from "./client.js";
import {
  EDGE_CONTRACT_SOURCE_SHA256,
  edgeContractSchema,
} from "./edge-contract.js";
import {
  downloadEdgeFunctionSourceTree,
  type CapturedEdgeSourceFile,
  type EdgeSourceTreeDependencies,
} from "./edge-source-tree.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface EdgeCaptureOptions {
  maxConcurrency?: number;
  accessToken?: SecretValue | undefined;
  sourceTreeDependencies?: EdgeSourceTreeDependencies | undefined;
  captureSourceTree?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface CapturedEdgeState {
  coverage: CoverageEntry[];
}

const functionSchema = z
  .object({
    id: z.string(),
    slug: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    name: z.string(),
    status: z.enum(["ACTIVE", "REMOVED", "THROTTLED"]),
    version: z.number().int(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    verify_jwt: z.boolean().optional(),
    import_map: z.boolean().optional(),
    entrypoint_path: z.string().optional(),
    import_map_path: z.string().nullable().optional(),
    ezbr_sha256: z.string().optional(),
  })
  .passthrough();

const secretSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    updated_at: z.string().optional(),
  })
  .passthrough();

// The current Management API has been observed to return null for
// import_map_path when a deployed function has no import map, despite the
// dated OpenAPI snapshot declaring a string. Keep that official schema as the
// primary contract and admit only the separately runtime-validated response
// shape needed for this documented platform divergence.
const observedFunctionContract = functionSchema;
const functionListContract = z.union([
  edgeContractSchema("FunctionResponse").array(),
  observedFunctionContract.array(),
]);
const functionDetailContract = z.union([
  edgeContractSchema("FunctionSlugResponse"),
  observedFunctionContract,
]);
const secretListContract = edgeContractSchema("SecretResponse").array();

function sourceContract(endpoint: string): Record<string, unknown> {
  return {
    adapter: "management-api-edge-v1",
    endpoint,
    openapiSha256: EDGE_CONTRACT_SOURCE_SHA256,
    cliEvidence: "supabase-cli-v2.114.0",
  };
}

function comparableFunction(value: z.infer<typeof functionSchema>): string {
  return JSON.stringify({
    id: value.id,
    slug: value.slug,
    status: value.status,
    version: value.version,
    updated_at: value.updated_at,
    verify_jwt: value.verify_jwt,
    entrypoint_path: value.entrypoint_path,
    import_map_path: value.import_map_path,
    ezbr_sha256: value.ezbr_sha256,
  });
}

function driftError(slug: string): PgDumpsterError {
  return new PgDumpsterError({
    code: "BACKUP_SOURCE_DRIFT_DETECTED",
    category: "consistency",
    component: "edge.functions",
    message: "An Edge Function changed while its deployed body was captured.",
    retryable: true,
    details: { slug },
  });
}

interface CapturedFunction {
  metadata: z.infer<typeof functionSchema>;
  sourceFiles: readonly CapturedEdgeSourceFile[];
}

export async function captureEdgeState(
  client: ManagementClient,
  projectRef: string,
  protectedSink: ProtectedArtifactSink,
  artifactSink: BundleArtifactSink,
  options: EdgeCaptureOptions = {},
): Promise<CapturedEdgeState> {
  const encodedRef = encodeURIComponent(projectRef);
  const requestOptions =
    options.signal === undefined ? {} : { signal: options.signal };
  const base = `/v1/projects/${encodedRef}`;
  const [functionValues, secretValues] = await Promise.all([
    client.get(`${base}/functions`, functionListContract, requestOptions),
    client.get(`${base}/secrets`, secretListContract, requestOptions),
  ]);
  const functions = functionSchema
    .array()
    .parse(functionValues)
    .sort((left, right) => left.slug.localeCompare(right.slug, "en"));
  try {
    assertNoCaseFoldCollisions(
      functions.map(({ slug }) => `functions/${slug}`),
    );
  } catch (error) {
    throw new PgDumpsterError({
      code: "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      category: "security",
      component: "edge.functions",
      message: "Edge Function slugs collide on a case-insensitive filesystem.",
      retryable: false,
      cause: error,
    });
  }
  const secrets = secretSchema
    .array()
    .parse(secretValues)
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  await protectedSink.writeJson(
    "secrets/edge-secret-digests.json",
    { schemaVersion: 1, valuesAreDigests: true, secrets },
    options.signal,
  );

  const capturedFunctions = await mapBounded(
    functions,
    options.maxConcurrency ?? 3,
    async (listed, _index, signal): Promise<CapturedFunction> => {
      const slug = encodeURIComponent(listed.slug);
      const detailPath = `${base}/functions/${slug}`;
      const before = functionSchema.parse(
        await client.get(detailPath, functionDetailContract, { signal }),
      );
      if (comparableFunction(listed) !== comparableFunction(before)) {
        throw driftError(listed.slug);
      }
      const captureSourceTree = options.captureSourceTree ?? true;
      if (captureSourceTree && options.accessToken === undefined)
        throw new PgDumpsterError({
          code: "EDGE_FUNCTION_SOURCE_DOWNLOAD_CREDENTIAL_MISSING",
          category: "config",
          component: "edge.functions",
          message:
            "Supabase CLI source download requires the configured management access token.",
          retryable: false,
        });
      const sourceFiles = captureSourceTree
        ? await downloadEdgeFunctionSourceTree(
            projectRef,
            listed.slug,
            options.accessToken!,
            artifactSink,
            options.sourceTreeDependencies,
            signal,
          )
        : [];
      const after = functionSchema.parse(
        await client.get(detailPath, functionDetailContract, { signal }),
      );
      if (comparableFunction(before) !== comparableFunction(after)) {
        throw driftError(listed.slug);
      }
      return { metadata: after, sourceFiles };
    },
    options.signal,
  );

  const indexPath = "functions/index.json";
  await artifactSink.writeJson(
    indexPath,
    {
      schemaVersion: 1,
      representation: "cli-source-tree",
      functions: capturedFunctions.map((entry) => ({
        metadata: entry.metadata,
        source: {
          files: entry.sourceFiles,
        },
      })),
    },
    options.signal,
  );

  const functionChildren = capturedFunctions.map((entry) => ({
    slug: entry.metadata.slug,
    status: "backed_up",
    artifacts: entry.sourceFiles.map(({ path }) => path),
    bytes: entry.sourceFiles.reduce((total, { bytes }) => total + bytes, 0),
    sourceFidelity:
      "cli_downloaded_deployable_source_tree_not_original_repository",
  }));
  const secretChildren = secrets.map(({ name, updated_at: updatedAt }) => ({
    name,
    updatedAt,
    status: "not_exportable",
    reasonCode: "edge_secret_digest_only",
  }));

  return {
    coverage: [
      {
        id: "edge.functions",
        status: functions.length === 0 ? "not_configured" : "backed_up",
        ...(functions.length === 0
          ? {}
          : {
              message:
                "A Supabase CLI-downloaded deployable source tree is captured. This does not claim to reproduce the original source repository or files not returned by Supabase.",
            }),
        sensitivity: "sensitive",
        artifacts: [
          indexPath,
          ...capturedFunctions.flatMap(({ sourceFiles }) =>
            sourceFiles.map(({ path }) => path),
          ),
        ],
        children: functionChildren,
        sourceContract: sourceContract(
          "/v1/projects/{ref}/functions + Supabase CLI functions download --use-api",
        ),
      },
      {
        id: "edge.secrets",
        status: secrets.length === 0 ? "not_configured" : "not_exportable",
        ...(secrets.length === 0
          ? {}
          : {
              reasonCode: "edge_secret_digest_only",
              message:
                "Supabase CLI v2.114.0 identifies returned values as digests; original secret values must be supplied during restore.",
            }),
        sensitivity: "secret",
        artifacts: ["secrets/edge-secret-digests.json"],
        children: secretChildren,
        sourceContract: sourceContract("/v1/projects/{ref}/secrets"),
      },
    ],
  };
}
