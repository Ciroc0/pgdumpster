import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { SecretValue } from "../../security/secret-value.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import {
  resolveSupabaseCommand,
  runProcess,
  type ResolvedCommand,
  type RunProcessOptions,
} from "../../utils/process.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import {
  createFetchEdgeFunctionRestoreClient,
  type EdgeFunctionRestoreClient,
} from "./edge-function-handler.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const MAX_INDEX_BYTES = 16_777_216;
const MAX_SOURCE_FILE_BYTES = 536_870_912;
const MAX_SOURCE_FILES = 10_000;
const DEPLOY_TIMEOUT_MS = 120_000;

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

const sourceFileSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative().refine(Number.isSafeInteger),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const functionIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    representation: z.literal("cli-source-tree"),
    functions: z.array(
      z
        .object({
          metadata: functionMetadataSchema,
          source: z
            .object({ files: z.array(sourceFileSchema).min(1) })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

type FunctionMetadata = z.infer<typeof functionMetadataSchema>;
type SourceFunction = z.infer<typeof functionIndexSchema>["functions"][number];
export interface EdgeSourceTreeRestoreOptions {
  bundleRoot: string;
  targetProjectRef: string;
  accessToken: SecretValue;
  conflictPolicy: "fail" | "replace";
  client?: Pick<EdgeFunctionRestoreClient, "list" | "delete"> | undefined;
  resolveSupabaseCommand?: typeof resolveSupabaseCommand;
  runProcess?: (
    command: string,
    args: readonly string[],
    options?: RunProcessOptions,
  ) => ReturnType<typeof runProcess>;
  environment?: NodeJS.ProcessEnv;
}

function edgeError(
  code: string,
  category:
    | "restore_policy"
    | "integrity"
    | "edge"
    | "platform_contract"
    | "network"
    | "dependency"
    | "io",
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

function portableMetadataPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.replaceAll("\\", "/").startsWith("file:///") ? null : value;
}

function semanticMetadata(value: FunctionMetadata) {
  return {
    slug: value.slug,
    name: value.name,
    verifyJwt: value.verify_jwt ?? true,
    importMap: value.import_map ?? false,
    entrypointPath: portableMetadataPath(value.entrypoint_path),
    importMapPath: portableMetadataPath(value.import_map_path),
  };
}

function sourceFingerprint(source: readonly SourceFunction[]): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        source
          .map(({ metadata, source: tree }) => ({
            metadata: semanticMetadata(metadata),
            files: [...tree.files].sort((left, right) =>
              left.path.localeCompare(right.path, "en"),
            ),
          }))
          .sort((left, right) =>
            left.metadata.slug.localeCompare(right.metadata.slug, "en"),
          ),
      ),
    )
    .digest("hex");
}

function sourceRelativePath(slug: string, artifact: string): string {
  const prefix = `functions/${slug}/source/`;
  if (!artifact.startsWith(prefix))
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function source artifact is outside its indexed source tree.",
      { slug },
    );
  const relative = artifact.slice(prefix.length);
  if (
    relative.length === 0 ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function source artifact path is unsafe.",
      { slug },
    );
  return relative;
}

function metadataSourcePath(slug: string, value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  // The Management API reports a worker-local file URI after CLI deployment.
  // It is not a portable source-tree path; Supabase CLI's default entrypoint is
  // the downloaded function's index.ts, so callers must use that default.
  if (normalized.startsWith("file:///")) return undefined;
  const projectRelativePrefix = `./functions/${slug}/`;
  const bareProjectRelativePrefix = `functions/${slug}/`;
  const sourcePath = normalized.startsWith(projectRelativePrefix)
    ? normalized.slice(projectRelativePrefix.length)
    : normalized.startsWith(bareProjectRelativePrefix)
      ? normalized.slice(bareProjectRelativePrefix.length)
      : normalized.startsWith("./")
        ? normalized.slice(2)
        : normalized;
  return sourceRelativePath(slug, `functions/${slug}/source/${sourcePath}`);
}

function tomlString(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r"))
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "integrity",
      "Edge Function metadata contains an unsafe configuration value.",
    );
  return `'${value.replaceAll("'", "\\'")}'`;
}

function configToml(source: readonly SourceFunction[]): string {
  const sections: string[] = [];
  for (const entry of source) {
    const paths = new Set(
      entry.source.files.map(({ path }) =>
        sourceRelativePath(entry.metadata.slug, path),
      ),
    );
    const lines = [
      `[functions.${entry.metadata.slug}]`,
      `verify_jwt = ${entry.metadata.verify_jwt ?? true}`,
    ];
    if (
      entry.metadata.import_map_path !== undefined &&
      entry.metadata.import_map_path !== null
    ) {
      const relative = metadataSourcePath(
        entry.metadata.slug,
        entry.metadata.import_map_path,
      );
      if (relative === undefined) {
        // Supabase can report a worker-local file URI. It is not portable and
        // the CLI-downloaded source tree remains the deployable authority.
      } else if (!paths.has(relative))
        throw edgeError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Edge Function import map was not included in the source tree.",
          { slug: entry.metadata.slug },
        );
      else
        lines.push(
          `import_map = ${tomlString(`./functions/${entry.metadata.slug}/${relative}`)}`,
        );
    }
    if (entry.metadata.entrypoint_path !== undefined) {
      const relative = metadataSourcePath(
        entry.metadata.slug,
        entry.metadata.entrypoint_path,
      );
      if (relative === undefined) {
        if (!paths.has("index.ts"))
          throw edgeError(
            "RESTORE_ARTIFACT_INVALID",
            "integrity",
            "Edge Function worker-local entrypoint has no downloaded index.ts default.",
            { slug: entry.metadata.slug },
          );
        sections.push(lines.join("\n"));
        continue;
      }
      if (!paths.has(relative))
        throw edgeError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Edge Function entrypoint was not included in the source tree.",
          { slug: entry.metadata.slug },
        );
      lines.push(
        `entrypoint = ${tomlString(`./functions/${entry.metadata.slug}/${relative}`)}`,
      );
    }
    sections.push(lines.join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

async function readSource(
  options: EdgeSourceTreeRestoreOptions,
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
      "Edge Function source index failed validation.",
      undefined,
      error,
    );
  }
  const expectedArtifacts = [
    "functions/index.json",
    ...document.functions.flatMap(({ source }) =>
      source.files.map(({ path }) => path),
    ),
  ].sort();
  if (canonicalJson([...artifacts].sort()) !== canonicalJson(expectedArtifacts))
    throw edgeError(
      "RESTORE_ARTIFACT_INVALID",
      "restore_policy",
      "Edge Function action artifacts do not match its source index.",
    );
  const slugs = new Set<string>();
  const files = new Set<string>();
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
        "Edge Function source index contains duplicate slugs.",
      );
    slugs.add(entry.metadata.slug);
    for (const file of entry.source.files) {
      sourceRelativePath(entry.metadata.slug, file.path);
      if (file.bytes > MAX_SOURCE_FILE_BYTES || files.has(file.path))
        throw edgeError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Edge Function source index contains invalid files.",
          { slug: entry.metadata.slug },
        );
      files.add(file.path);
      if (files.size > MAX_SOURCE_FILES)
        throw edgeError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Edge Function source index exceeds the file-count bound.",
          { maxFiles: MAX_SOURCE_FILES },
        );
    }
  }
  return document.functions;
}

async function verifyAndMaterialize(
  options: EdgeSourceTreeRestoreOptions,
  source: readonly SourceFunction[],
  workdir: string,
): Promise<void> {
  for (const entry of source) {
    for (const file of entry.source.files) {
      const origin = await resolveBundleArtifact(options.bundleRoot, file.path);
      const stat = await lstat(origin);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes)
        throw edgeError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Edge Function source file size does not match its index.",
          { slug: entry.metadata.slug },
        );
      const digest = createHash("sha256");
      const stream = createReadStream(origin);
      try {
        for await (const chunk of stream) digest.update(chunk as Buffer);
      } finally {
        stream.destroy();
      }
      const actual = digest.digest("hex");
      if (actual !== file.sha256)
        throw edgeError(
          "RESTORE_ARTIFACT_INVALID",
          "integrity",
          "Edge Function source file checksum does not match its index.",
          { slug: entry.metadata.slug },
        );
      const target = path.join(
        workdir,
        "supabase",
        "functions",
        entry.metadata.slug,
        ...sourceRelativePath(entry.metadata.slug, file.path).split("/"),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(origin, target);
    }
  }
  const configPath = path.join(workdir, "supabase", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, configToml(source), { mode: 0o600 });
}

async function resolveCli(
  options: EdgeSourceTreeRestoreOptions,
): Promise<ResolvedCommand> {
  try {
    return await (options.resolveSupabaseCommand ?? resolveSupabaseCommand)(
      options.environment ?? process.env,
    );
  } catch (error) {
    throw edgeError(
      "EDGE_FUNCTION_DEPLOY_DEPENDENCY_MISSING",
      "dependency",
      "Supabase CLI is required to restore Edge Function source.",
      undefined,
      error,
    );
  }
}

async function deploySource(
  command: ResolvedCommand,
  workdir: string,
  source: readonly SourceFunction[],
  options: EdgeSourceTreeRestoreOptions,
  signal?: AbortSignal,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    SUPABASE_ACCESS_TOKEN: options.accessToken.expose(),
  };
  for (const entry of source) {
    signal?.throwIfAborted();
    let result;
    try {
      result = await (options.runProcess ?? runProcess)(
        command.command,
        [
          ...command.prefixArgs,
          "functions",
          "deploy",
          entry.metadata.slug,
          "--project-ref",
          options.targetProjectRef,
          "--use-api",
          "--workdir",
          workdir,
        ],
        {
          environment,
          signal,
          timeoutMs: DEPLOY_TIMEOUT_MS,
          maxOutputBytes: 1_048_576,
        },
      );
    } catch (error) {
      throw edgeError(
        "EDGE_FUNCTION_SOURCE_DEPLOY_FAILED",
        "io",
        "Supabase CLI could not deploy Edge Function source.",
        { slug: entry.metadata.slug },
        error,
      );
    }
    if (result.exitCode !== 0)
      throw edgeError(
        "EDGE_FUNCTION_SOURCE_DEPLOY_FAILED",
        "io",
        "Supabase CLI could not deploy Edge Function source.",
        { slug: entry.metadata.slug, exitCode: result.exitCode },
      );
  }
}

function matches(source: FunctionMetadata, target: FunctionMetadata): boolean {
  return (
    canonicalJson(semanticMetadata(source)) ===
    canonicalJson(semanticMetadata(target))
  );
}

export function createEdgeSourceTreeRestoreHandler(
  options: EdgeSourceTreeRestoreOptions,
): RestoreActionHandler {
  const client =
    options.client ?? createFetchEdgeFunctionRestoreClient(options);
  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await readSource(options, context.action.artifacts);
      const command = await resolveCli(options);
      const workdir = await mkdtemp(
        path.join(tmpdir(), "pgdumpster-edge-restore-"),
      );
      try {
        await verifyAndMaterialize(options, source, workdir);
        const target = await client.list(context.signal);
        const sourceBySlug = new Map(
          source.map((entry) => [entry.metadata.slug, entry]),
        );
        const targetBySlug = new Map(
          target.map((entry) => [entry.slug, entry]),
        );
        const extra = target.filter((entry) => !sourceBySlug.has(entry.slug));
        const conflicts = source.filter((entry) => {
          const current = targetBySlug.get(entry.metadata.slug);
          return current !== undefined && !matches(entry.metadata, current);
        });
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
        const deploy = source.filter((entry) => {
          const current = targetBySlug.get(entry.metadata.slug);
          return current === undefined || !matches(entry.metadata, current);
        });
        await deploySource(command, workdir, deploy, options, context.signal);
        return { fingerprint: sourceFingerprint(source) };
      } finally {
        await rm(workdir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
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
      return source.every((entry) => {
        const current = targetBySlug.get(entry.metadata.slug);
        return current !== undefined && matches(entry.metadata, current);
      });
    },
  };
}
