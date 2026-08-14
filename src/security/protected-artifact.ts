import { lstat, realpath } from "node:fs/promises";

import { PgDumpsterError } from "../core/errors/error.js";
import { assertSafeBundlePath } from "./bundle-path.js";
import { resolveSafeArtifactTarget } from "./safe-artifact-parent.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { canonicalJson } from "../utils/canonical-json.js";

export interface ProtectedArtifactSink {
  writeJson(
    relativePath: string,
    value: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PlaintextProtectedArtifactSinkOptions {
  allowPlaintextSecrets: boolean;
  signal?: AbortSignal | undefined;
}

export async function createPlaintextProtectedArtifactSink(
  bundleRoot: string,
  options: PlaintextProtectedArtifactSinkOptions,
): Promise<ProtectedArtifactSink> {
  options.signal?.throwIfAborted();
  if (!options.allowPlaintextSecrets) {
    throw new PgDumpsterError({
      code: "PLAINTEXT_SECRETS_NOT_ALLOWED",
      category: "security",
      message:
        "Writing plaintext secret artifacts requires explicit --allow-plaintext-secrets opt-in.",
      retryable: false,
    });
  }
  const rootStat = await lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PgDumpsterError({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
      message: "Secret artifact root must be a real directory.",
      retryable: false,
    });
  }
  const resolvedRoot = await realpath(bundleRoot);
  return {
    async writeJson(relativePath, value, signal) {
      signal?.throwIfAborted();
      assertSafeBundlePath(relativePath);
      if (!relativePath.startsWith("secrets/")) {
        throw new PgDumpsterError({
          code: "SECURITY_PATH_REJECTED",
          category: "security",
          message: "Protected artifacts must be stored under secrets/.",
          retryable: false,
        });
      }
      const target = await resolveSafeArtifactTarget(
        bundleRoot,
        resolvedRoot,
        relativePath,
      );
      await writeFileAtomic(target, canonicalJson(value), {
        signal,
        mode: 0o600,
      });
    },
  };
}
