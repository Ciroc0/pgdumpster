import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type {
  ArtifactWriteResult,
  BundleArtifactSink,
} from "../../core/bundle/artifact-sink.js";
import { PgDumpsterError } from "../../core/errors/error.js";
import {
  assertNoCaseFoldCollisions,
  assertSafeBundlePath,
} from "../../security/bundle-path.js";
import type { SecretValue } from "../../security/secret-value.js";
import {
  resolveSupabaseCommand,
  runProcess,
  type ResolvedCommand,
  type RunProcessOptions,
} from "../../utils/process.js";

const MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_BYTES = 536_870_912;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface CapturedEdgeSourceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EdgeSourceTreeDependencies {
  resolveSupabaseCommand?: typeof resolveSupabaseCommand;
  runProcess?: (
    command: string,
    args: readonly string[],
    options?: RunProcessOptions,
  ) => ReturnType<typeof runProcess>;
  environment?: NodeJS.ProcessEnv;
}

function sourceError(
  code: string,
  category: "dependency" | "platform_contract" | "io" | "security",
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category,
    component: "edge.functions",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function relativeWithin(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      "security",
      "Downloaded Edge Function source escaped its isolated work directory.",
    );
  }
  return relative;
}

async function filesInDownloadedTree(root: string): Promise<string[]> {
  const rootStat = await lstat(root).catch((error: unknown) => {
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      "platform_contract",
      "Supabase CLI did not produce the expected Edge Function source tree.",
      undefined,
      error,
    );
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      "security",
      "Downloaded Edge Function source root is not a real directory.",
    );
  const resolvedRoot = await realpath(root);
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const relative = relativeWithin(resolvedRoot, await realpath(filename));
      if (entry.isDirectory()) {
        const stat = await lstat(filename);
        if (stat.isSymbolicLink())
          throw sourceError(
            "EDGE_FUNCTION_SOURCE_TREE_INVALID",
            "security",
            "Downloaded Edge Function source contains a symbolic-link directory.",
            { path: relative },
          );
        await walk(filename);
        continue;
      }
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw sourceError(
          "EDGE_FUNCTION_SOURCE_TREE_INVALID",
          "security",
          "Downloaded Edge Function source contains a non-regular file.",
          { path: relative },
        );
      files.push(relative);
      if (files.length > MAX_SOURCE_FILES)
        throw sourceError(
          "EDGE_FUNCTION_SOURCE_TREE_INVALID",
          "io",
          "Downloaded Edge Function source exceeded the file-count bound.",
          { maxFiles: MAX_SOURCE_FILES },
        );
    }
  };
  await walk(root);
  if (files.length === 0)
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      "platform_contract",
      "Supabase CLI downloaded an empty Edge Function source tree.",
    );
  files.sort((left, right) => left.localeCompare(right, "en"));
  try {
    assertNoCaseFoldCollisions(files);
  } catch (error) {
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      "security",
      "Downloaded Edge Function source contains colliding paths.",
      undefined,
      error,
    );
  }
  return files;
}

async function writeSourceFile(
  sourceRoot: string,
  slug: string,
  sourcePath: string,
  artifactSink: BundleArtifactSink,
  signal?: AbortSignal,
): Promise<CapturedEdgeSourceFile> {
  const artifactPath = `functions/${slug}/source/${sourcePath}`;
  assertSafeBundlePath(artifactPath);
  const absolute = path.join(sourceRoot, ...sourcePath.split("/"));
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES)
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      "security",
      "Downloaded Edge Function source file is invalid or exceeds the byte bound.",
      { path: sourcePath, maxBytes: MAX_SOURCE_BYTES },
    );
  const nodeStream = createReadStream(absolute);
  let written: ArtifactWriteResult;
  try {
    written = await artifactSink.writeStream(
      artifactPath,
      Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      { maxBytes: MAX_SOURCE_BYTES, signal },
    );
  } finally {
    nodeStream.destroy();
  }
  return { path: artifactPath, ...written };
}

export async function downloadEdgeFunctionSourceTree(
  projectRef: string,
  slug: string,
  accessToken: SecretValue,
  artifactSink: BundleArtifactSink,
  dependencies: EdgeSourceTreeDependencies = {},
  signal?: AbortSignal,
): Promise<readonly CapturedEdgeSourceFile[]> {
  signal?.throwIfAborted();
  const baseEnvironment = dependencies.environment ?? process.env;
  const resolver =
    dependencies.resolveSupabaseCommand ?? resolveSupabaseCommand;
  let command: ResolvedCommand;
  try {
    command = await resolver(baseEnvironment);
  } catch (error) {
    throw sourceError(
      "EDGE_FUNCTION_SOURCE_DOWNLOAD_DEPENDENCY_MISSING",
      "dependency",
      "Supabase CLI is required to capture deployable Edge Function source.",
      undefined,
      error,
    );
  }
  const workdir = await mkdtemp(path.join(tmpdir(), "pgdumpster-edge-source-"));
  try {
    const environment: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      SUPABASE_ACCESS_TOKEN: accessToken.expose(),
    };
    let result;
    try {
      result = await (dependencies.runProcess ?? runProcess)(
        command.command,
        [
          ...command.prefixArgs,
          "functions",
          "download",
          slug,
          "--project-ref",
          projectRef,
          "--use-api",
          "--workdir",
          workdir,
        ],
        {
          environment,
          signal,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxOutputBytes: 1_048_576,
        },
      );
    } catch (error) {
      throw sourceError(
        "EDGE_FUNCTION_SOURCE_DOWNLOAD_FAILED",
        "io",
        "Supabase CLI could not download Edge Function source.",
        { slug },
        error,
      );
    }
    if (result.exitCode !== 0)
      throw sourceError(
        "EDGE_FUNCTION_SOURCE_DOWNLOAD_FAILED",
        "io",
        "Supabase CLI could not download Edge Function source.",
        { slug, exitCode: result.exitCode },
      );

    const sourceRoot = path.join(workdir, "supabase", "functions", slug);
    const paths = await filesInDownloadedTree(sourceRoot);
    const captured: CapturedEdgeSourceFile[] = [];
    let totalBytes = 0;
    for (const sourcePath of paths) {
      signal?.throwIfAborted();
      const file = await writeSourceFile(
        sourceRoot,
        slug,
        sourcePath,
        artifactSink,
        signal,
      );
      totalBytes += file.bytes;
      if (totalBytes > MAX_SOURCE_BYTES)
        throw sourceError(
          "EDGE_FUNCTION_SOURCE_TREE_INVALID",
          "io",
          "Downloaded Edge Function source exceeded the aggregate byte bound.",
          { maxBytes: MAX_SOURCE_BYTES },
        );
      captured.push(file);
    }
    return captured;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
