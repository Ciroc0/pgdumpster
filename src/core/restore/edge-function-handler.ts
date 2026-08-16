import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { z } from "zod";

import type { SecretValue } from "../../security/secret-value.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const API_ORIGIN = "https://api.supabase.com";
const MAX_INDEX_BYTES = 16_777_216;
const MAX_BODY_BYTES = 536_870_912;

const functionMetadataSchema = z
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
const functionIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    representation: z.literal("management-api-multipart"),
    functions: z.array(
      z
        .object({
          metadata: functionMetadataSchema,
          body: z
            .object({
              path: z.string().min(1),
              bytes: z
                .number()
                .int()
                .nonnegative()
                .refine(Number.isSafeInteger),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              contentType: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

type FunctionMetadata = z.infer<typeof functionMetadataSchema>;
type SourceFunction = z.infer<typeof functionIndexSchema>["functions"][number];

export interface EdgeFunctionBody {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
}

export interface EdgeFunctionRestoreClient {
  list(signal?: AbortSignal): Promise<FunctionMetadata[]>;
  get(slug: string, signal?: AbortSignal): Promise<FunctionMetadata>;
  body(slug: string, signal?: AbortSignal): Promise<EdgeFunctionBody>;
  deploy(
    input: { slug: string; sourcePath: string; contentType: string },
    signal?: AbortSignal,
  ): Promise<FunctionMetadata>;
  delete(slug: string, signal?: AbortSignal): Promise<void>;
}

export interface EdgeFunctionRestoreOptions {
  bundleRoot: string;
  targetProjectRef: string;
  accessToken: SecretValue;
  conflictPolicy: "fail" | "replace";
  client?: EdgeFunctionRestoreClient | undefined;
  fetch?: typeof fetch | undefined;
}

function edgeError(
  code: string,
  category:
    | "restore_policy"
    | "integrity"
    | "edge"
    | "platform_contract"
    | "network"
    | "auth",
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category,
    message,
    retryable: false,
    component: "edge.functions",
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function multipart(contentType: string): boolean {
  return (
    /^multipart\/form-data(?:\s*;|$)/iu.test(contentType) &&
    /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/iu.test(contentType)
  );
}

function apiUrl(
  projectRef: string,
  suffix: string,
  query?: Readonly<Record<string, string>>,
): string {
  if (!/^[a-z0-9]{20}$/u.test(projectRef))
    throw edgeError(
      "PROJECT_REF_INVALID",
      "platform_contract",
      "Target project ref is invalid for Edge Function restore.",
    );
  const url = new URL(
    `/v1/projects/${encodeURIComponent(projectRef)}/functions${suffix}`,
    API_ORIGIN,
  );
  for (const [key, value] of Object.entries(query ?? {}))
    url.searchParams.set(key, value);
  return url.href;
}

function responseError(response: Response): PgDumpsterError {
  const details = {
    status: response.status,
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("sb-request-id") ??
      undefined,
  };
  if (response.status === 401 || response.status === 403)
    return edgeError(
      "AUTH_MANAGEMENT_API_FAILED",
      "auth",
      "Supabase Management API authentication or authorization failed during Edge Function restore.",
      details,
    );
  return edgeError(
    "EDGE_FUNCTION_RESTORE_FAILED",
    response.status === 429 || response.status >= 500 ? "network" : "edge",
    "Supabase Management API Edge Function restore request failed.",
    details,
  );
}

async function metadataResponse(response: Response): Promise<FunctionMetadata> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw edgeError(
      "PLATFORM_API_CONTRACT_CHANGED",
      "platform_contract",
      "Edge Function response was not valid JSON.",
      undefined,
      error,
    );
  }
  const parsed = functionMetadataSchema.safeParse(value);
  if (!parsed.success)
    throw edgeError(
      "PLATFORM_API_CONTRACT_CHANGED",
      "platform_contract",
      "Edge Function response no longer matches the expected contract.",
    );
  return parsed.data;
}

async function transport(
  request: typeof fetch,
  input: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<Response> {
  try {
    const response = await request(input, init);
    if (!response.ok) throw responseError(response);
    return response;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PgDumpsterError) throw error;
    throw edgeError(
      "EDGE_FUNCTION_RESTORE_FAILED",
      "network",
      `${operation} failed before a response.`,
      undefined,
      error,
    );
  }
}

export function createFetchEdgeFunctionRestoreClient(
  options: Pick<
    EdgeFunctionRestoreOptions,
    "targetProjectRef" | "accessToken" | "fetch"
  >,
): EdgeFunctionRestoreClient {
  const request = options.fetch ?? globalThis.fetch;
  const authorization = `Bearer ${options.accessToken.expose()}`;
  const jsonHeaders = { authorization, accept: "application/json" };
  return {
    async list(signal) {
      const response = await transport(
        request,
        apiUrl(options.targetProjectRef, ""),
        {
          method: "GET",
          headers: jsonHeaders,
          ...(signal === undefined ? {} : { signal }),
        },
        signal,
        "Edge Function inventory request",
      );
      let value: unknown;
      try {
        value = await response.json();
      } catch (error) {
        throw edgeError(
          "PLATFORM_API_CONTRACT_CHANGED",
          "platform_contract",
          "Edge Function inventory response was not valid JSON.",
          undefined,
          error,
        );
      }
      const parsed = functionMetadataSchema.array().safeParse(value);
      if (!parsed.success)
        throw edgeError(
          "PLATFORM_API_CONTRACT_CHANGED",
          "platform_contract",
          "Edge Function inventory response no longer matches the expected contract.",
        );
      return parsed.data;
    },
    async get(slug, signal) {
      const response = await transport(
        request,
        apiUrl(options.targetProjectRef, `/${encodeURIComponent(slug)}`),
        {
          method: "GET",
          headers: jsonHeaders,
          ...(signal === undefined ? {} : { signal }),
        },
        signal,
        "Edge Function metadata request",
      );
      return metadataResponse(response);
    },
    async body(slug, signal) {
      const response = await transport(
        request,
        apiUrl(options.targetProjectRef, `/${encodeURIComponent(slug)}/body`),
        {
          method: "GET",
          headers: { authorization, accept: "multipart/form-data" },
          ...(signal === undefined ? {} : { signal }),
        },
        signal,
        "Edge Function body request",
      );
      if (response.body === null)
        throw edgeError(
          "PLATFORM_API_CONTRACT_CHANGED",
          "platform_contract",
          "Edge Function body verification returned no body.",
        );
      return {
        body: response.body,
        contentType: response.headers.get("content-type"),
      };
    },
    async deploy(input, signal) {
      const source = createReadStream(input.sourcePath);
      try {
        const requestOptions: RequestInit & { duplex: "half" } = {
          method: "POST",
          headers: {
            authorization,
            accept: "application/json",
            "content-type": input.contentType,
          },
          body: source,
          duplex: "half",
          ...(signal === undefined ? {} : { signal }),
        };
        const response = await transport(
          request,
          apiUrl(options.targetProjectRef, "/deploy", { slug: input.slug }),
          requestOptions,
          signal,
          "Edge Function deployment",
        );
        return metadataResponse(response);
      } finally {
        source.destroy();
      }
    },
    async delete(slug, signal) {
      const response = await transport(
        request,
        apiUrl(options.targetProjectRef, `/${encodeURIComponent(slug)}`),
        {
          method: "DELETE",
          headers: jsonHeaders,
          ...(signal === undefined ? {} : { signal }),
        },
        signal,
        "Edge Function deletion",
      );
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

function semanticMetadata(value: FunctionMetadata) {
  return {
    slug: value.slug,
    name: value.name,
    verifyJwt: value.verify_jwt ?? true,
    importMap: value.import_map ?? false,
    entrypointPath: value.entrypoint_path ?? null,
    importMapPath: value.import_map_path ?? null,
  };
}

function sourceFingerprint(source: readonly SourceFunction[]): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        source
          .map((entry) => ({
            metadata: semanticMetadata(entry.metadata),
            bundleSha256: entry.metadata.ezbr_sha256 ?? null,
            bodySha256: entry.body.sha256,
            bytes: entry.body.bytes,
          }))
          .sort((left, right) =>
            left.metadata.slug.localeCompare(right.metadata.slug, "en"),
          ),
      ),
    )
    .digest("hex");
}

async function readSource(
  options: EdgeFunctionRestoreOptions,
  artifacts: readonly string[],
): Promise<SourceFunction[]> {
  const indexPath = await resolveBundleArtifact(
    options.bundleRoot,
    "functions/index.json",
  );
  const stat = await lstat(indexPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0 ||
    stat.size > MAX_INDEX_BYTES
  )
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function index is not a bounded regular file.",
    );
  let document: z.infer<typeof functionIndexSchema>;
  try {
    document = functionIndexSchema.parse(
      JSON.parse(await readFile(indexPath, "utf8")),
    );
  } catch (error) {
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function index failed validation.",
      undefined,
      error,
    );
  }
  const expectedArtifacts = [
    "functions/index.json",
    ...document.functions.map(({ body }) => body.path),
  ].sort();
  if (canonicalJson([...artifacts].sort()) !== canonicalJson(expectedArtifacts))
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "restore_policy",
      "Edge Function action artifacts do not match its index.",
    );
  const slugs = new Set<string>();
  for (const entry of document.functions) {
    if (entry.metadata.status !== "ACTIVE")
      throw edgeError(
        "EDGE_FUNCTION_RESTORE_UNSUPPORTED_STATE",
        "restore_policy",
        "Only active Edge Functions can be restored automatically.",
        { slug: entry.metadata.slug, status: entry.metadata.status },
      );
    if (slugs.has(entry.metadata.slug))
      throw edgeError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Edge Function index contains duplicate slugs.",
      );
    slugs.add(entry.metadata.slug);
    if (entry.body.bytes > MAX_BODY_BYTES || !multipart(entry.body.contentType))
      throw edgeError(
        "RESTORE_ARTIFACT_INVALID",
        "integrity",
        "Edge Function multipart metadata is invalid or oversized.",
        { slug: entry.metadata.slug },
      );
  }
  return document.functions;
}

async function validateSourceBody(
  options: EdgeFunctionRestoreOptions,
  source: SourceFunction,
): Promise<string> {
  const filename = await resolveBundleArtifact(
    options.bundleRoot,
    source.body.path,
  );
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== source.body.bytes ||
    stat.size > MAX_BODY_BYTES
  )
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function multipart body size does not match its index.",
      { slug: source.metadata.slug },
    );
  const digest = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(filename);
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      digest.update(buffer);
    }
  } finally {
    stream.destroy();
  }
  if (
    bytes !== source.body.bytes ||
    digest.digest("hex") !== source.body.sha256
  )
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function multipart body checksum does not match its index.",
      { slug: source.metadata.slug },
    );
  return filename;
}

async function streamSha256(body: ReadableStream<Uint8Array>): Promise<string> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES)
      throw edgeError(
        "EDGE_FUNCTION_PARITY_FAILED",
        "integrity",
        "Target Edge Function body exceeded the verification bound.",
      );
    digest.update(buffer);
  }
  return digest.digest("hex");
}

async function matches(
  client: EdgeFunctionRestoreClient,
  source: SourceFunction,
  target: FunctionMetadata,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    canonicalJson(semanticMetadata(source.metadata)) !==
    canonicalJson(semanticMetadata(target))
  )
    return false;
  if (
    source.metadata.ezbr_sha256 !== undefined &&
    target.ezbr_sha256 === source.metadata.ezbr_sha256
  )
    return true;
  const targetBody = await client.body(source.metadata.slug, signal);
  if (targetBody.contentType === null || !multipart(targetBody.contentType))
    return false;
  return (await streamSha256(targetBody.body)) === source.body.sha256;
}

export function createEdgeFunctionRestoreHandler(
  options: EdgeFunctionRestoreOptions,
): RestoreActionHandler {
  const client =
    options.client ?? createFetchEdgeFunctionRestoreClient(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await readSource(options, context.action.artifacts);
      const bodyPaths = new Map<string, string>();
      for (const entry of source)
        bodyPaths.set(
          entry.metadata.slug,
          await validateSourceBody(options, entry),
        );

      const target = await client.list(context.signal);
      const sourceBySlug = new Map(
        source.map((entry) => [entry.metadata.slug, entry]),
      );
      const targetBySlug = new Map(target.map((entry) => [entry.slug, entry]));
      const extra = target.filter((entry) => !sourceBySlug.has(entry.slug));
      const conflicts: SourceFunction[] = [];
      for (const entry of source) {
        const current = targetBySlug.get(entry.metadata.slug);
        if (
          current !== undefined &&
          !(await matches(client, entry, current, context.signal))
        )
          conflicts.push(entry);
      }
      if (
        options.conflictPolicy === "fail" &&
        (extra.length > 0 || conflicts.length > 0)
      )
        throw edgeError(
          "RESTORE_TARGET_CONFLICT",
          "restore_policy",
          "Target Edge Function state differs from the source backup.",
          {
            extraFunctions: extra.length,
            conflictingFunctions: conflicts.length,
          },
        );
      if (options.conflictPolicy === "replace")
        for (const entry of extra)
          await client.delete(entry.slug, context.signal);

      const conflictSlugs = new Set(
        conflicts.map(({ metadata }) => metadata.slug),
      );
      for (const entry of source) {
        const current = targetBySlug.get(entry.metadata.slug);
        if (current !== undefined && !conflictSlugs.has(entry.metadata.slug))
          continue;
        await client.deploy(
          {
            slug: entry.metadata.slug,
            sourcePath: bodyPaths.get(entry.metadata.slug)!,
            contentType: entry.body.contentType,
          },
          context.signal,
        );
      }
      return { fingerprint: sourceFingerprint(source) };
    },
    async verify(context): Promise<boolean> {
      const source = await readSource(options, context.action.artifacts);
      const expected = sourceFingerprint(source);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== expected
      )
        return false;
      const target = await client.list(context.signal);
      if (target.length !== source.length) return false;
      const targetBySlug = new Map(target.map((entry) => [entry.slug, entry]));
      for (const entry of source) {
        const current = targetBySlug.get(entry.metadata.slug);
        if (
          current === undefined ||
          !(await matches(client, entry, current, context.signal))
        )
          return false;
      }
      return true;
    },
  };
}
