import { z } from "zod";

import type {
  ArtifactWriteResult,
  BundleArtifactSink,
} from "../../core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../../core/bundle/schemas.js";
import { PgDumpsterError } from "../../core/errors/error.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import { mapBounded } from "../../utils/bounded-concurrency.js";
import type { ManagementClient } from "./client.js";
import {
  EDGE_CONTRACT_SOURCE_SHA256,
  edgeContractSchema,
} from "./edge-contract.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface EdgeCaptureOptions {
  maxConcurrency?: number;
  maxFunctionBodyBytes?: number;
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

function contentTypeIsMultipart(
  contentType: string | null,
): contentType is string {
  if (contentType === null) return false;
  return (
    /^multipart\/form-data(?:\s*;|$)/iu.test(contentType) &&
    /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/iu.test(contentType)
  );
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
  body: ArtifactWriteResult;
  contentType: string;
  metadata: z.infer<typeof functionSchema>;
  path: string;
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
      const response = await client.getRaw(`${detailPath}/body`, {
        accept: "multipart/form-data",
        signal,
      });
      const contentType = response.headers.get("content-type");
      if (!contentTypeIsMultipart(contentType) || response.body === null) {
        throw new PgDumpsterError({
          code: "PLATFORM_API_CONTRACT_CHANGED",
          category: "platform_contract",
          component: "edge.functions",
          message:
            "Supabase returned an invalid Edge Function multipart body response.",
          retryable: false,
          details: { slug: listed.slug },
        });
      }
      const artifactPath = `functions/${listed.slug}/source.multipart`;
      const body = await artifactSink.writeStream(artifactPath, response.body, {
        maxBytes: options.maxFunctionBodyBytes ?? 536_870_912,
        signal,
      });
      const after = functionSchema.parse(
        await client.get(detailPath, functionDetailContract, { signal }),
      );
      if (comparableFunction(before) !== comparableFunction(after)) {
        throw driftError(listed.slug);
      }
      return { body, contentType, metadata: after, path: artifactPath };
    },
    options.signal,
  );

  const indexPath = "functions/index.json";
  await artifactSink.writeJson(
    indexPath,
    {
      schemaVersion: 1,
      representation: "management-api-multipart",
      functions: capturedFunctions.map((entry) => ({
        metadata: entry.metadata,
        body: {
          path: entry.path,
          bytes: entry.body.bytes,
          sha256: entry.body.sha256,
          contentType: entry.contentType,
        },
      })),
    },
    options.signal,
  );

  const functionChildren = capturedFunctions.map((entry) => ({
    slug: entry.metadata.slug,
    status: "backed_up",
    artifact: entry.path,
    sha256: entry.body.sha256,
    bytes: entry.body.bytes,
    sourceFidelity: "deployed_representation_not_original_repository",
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
                "The complete exposed multipart deployment representation is captured. This does not claim to reproduce the original source repository or legacy bundle formats.",
            }),
        sensitivity: "sensitive",
        artifacts: [indexPath, ...capturedFunctions.map(({ path }) => path)],
        children: functionChildren,
        sourceContract: sourceContract(
          "/v1/projects/{ref}/functions + /functions/{function_slug}/body",
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
