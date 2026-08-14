import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { PgDumpsterError } from "../errors/error.js";
import { resolveSafeArtifactTarget } from "../../security/safe-artifact-parent.js";
import { canonicalJson } from "../../utils/canonical-json.js";

export interface ArtifactWriteResult {
  bytes: number;
  sha256: string;
}

export interface StreamArtifactOptions {
  maxBytes: number;
  signal?: AbortSignal | undefined;
}

export interface BundleArtifactSink {
  writeJson(
    relativePath: string,
    value: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ArtifactWriteResult>;
  writeStream(
    relativePath: string,
    stream: ReadableStream<Uint8Array>,
    options: StreamArtifactOptions,
  ): Promise<ArtifactWriteResult>;
}

export async function createDirectoryArtifactSink(
  bundleRoot: string,
): Promise<BundleArtifactSink> {
  const rootStat = await lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PgDumpsterError({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
      message: "Artifact root must be a real directory.",
      retryable: false,
    });
  }
  const resolvedRoot = await realpath(bundleRoot);

  const writeStream: BundleArtifactSink["writeStream"] = async (
    relativePath,
    stream,
    options,
  ) => {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new Error("maxBytes must be a non-negative safe integer");
    }
    options.signal?.throwIfAborted();
    const target = await resolveSafeArtifactTarget(
      bundleRoot,
      resolvedRoot,
      relativePath,
    );
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.partial-${randomUUID()}`,
    );
    const reader = stream.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      for (;;) {
        options.signal?.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > options.maxBytes) {
          throw new PgDumpsterError({
            code: "ARTIFACT_SIZE_LIMIT_EXCEEDED",
            category: "io",
            message: "Artifact exceeded the configured byte limit.",
            retryable: false,
            details: { maxBytes: options.maxBytes, relativePath },
          });
        }
        hash.update(result.value);
        await handle.write(result.value);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      options.signal?.throwIfAborted();
      await resolveSafeArtifactTarget(bundleRoot, resolvedRoot, relativePath);
      await link(temporary, target);
      try {
        await rm(temporary);
      } catch (cleanupError) {
        await rm(target, { force: true }).catch(() => undefined);
        throw cleanupError;
      }
      return { bytes, sha256: hash.digest("hex") };
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  };

  return {
    writeStream,
    writeJson(relativePath, value, signal) {
      const bytes = new TextEncoder().encode(canonicalJson(value));
      return writeStream(relativePath, new Blob([bytes]).stream(), {
        maxBytes: bytes.byteLength,
        signal,
      });
    },
  };
}
