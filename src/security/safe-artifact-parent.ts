import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { PgDumpsterError } from "../core/errors/error.js";
import { assertSafeBundlePath } from "./bundle-path.js";

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function rejected(): PgDumpsterError {
  return new PgDumpsterError({
    code: "SECURITY_PATH_REJECTED",
    category: "security",
    message: "Artifact parent escapes the bundle root.",
    retryable: false,
  });
}

export async function resolveSafeArtifactTarget(
  root: string,
  resolvedRoot: string,
  relativePath: string,
): Promise<string> {
  assertSafeBundlePath(relativePath);
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw rejected();
    const resolved = await realpath(current);
    const relativeResolved = path.relative(resolvedRoot, resolved);
    if (
      relativeResolved === ".." ||
      relativeResolved.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeResolved)
    ) {
      throw rejected();
    }
  }
  return path.join(root, ...segments);
}
