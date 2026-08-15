import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { PgDumpsterError } from "../core/errors/error.js";
import { assertSafeBundlePath } from "./bundle-path.js";

export interface SafeRemoveOptions {
  recursive?: boolean;
  signal?: AbortSignal | undefined;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function rejected(relativePath: string, reason: string): PgDumpsterError {
  return new PgDumpsterError({
    code: "SECURITY_PATH_REJECTED",
    category: "security",
    message: "Cleanup refused an unsafe bundle path.",
    retryable: false,
    details: { relativePath, reason },
  });
}

function assertWithinRoot(
  resolvedRoot: string,
  resolvedTarget: string,
  relativePath: string,
): void {
  const relativeResolved = path.relative(resolvedRoot, resolvedTarget);
  if (
    relativeResolved === ".." ||
    relativeResolved.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeResolved)
  ) {
    throw rejected(relativePath, "resolved_path_escapes_bundle_root");
  }
}

async function safeDirectoryEntries(
  root: string,
  relativeDirectory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw rejected(relativeDirectory || ".", "bundle_root_is_not_a_real_directory");
  }
  const resolvedRoot = await realpath(root);
  let current = root;

  if (relativeDirectory.length > 0) {
    assertSafeBundlePath(relativeDirectory);
    for (const segment of relativeDirectory.split("/")) {
      signal?.throwIfAborted();
      current = path.join(current, segment);
      let stat;
      try {
        stat = await lstat(current);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw rejected(relativeDirectory, "artifact_parent_is_not_a_real_directory");
      }
      const resolved = await realpath(current);
      assertWithinRoot(resolvedRoot, resolved, relativeDirectory);
    }
  }

  signal?.throwIfAborted();
  return readdir(current);
}

export async function removeSafeBundlePath(
  root: string,
  relativePath: string,
  options: SafeRemoveOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  assertSafeBundlePath(relativePath);

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw rejected(relativePath, "bundle_root_is_not_a_real_directory");
  }
  const resolvedRoot = await realpath(root);
  const segments = relativePath.split("/");
  let current = root;

  for (const [index, segment] of segments.entries()) {
    options.signal?.throwIfAborted();
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }

    const final = index === segments.length - 1;
    if (stat.isSymbolicLink()) {
      throw rejected(relativePath, final ? "target_is_symlink" : "parent_is_symlink");
    }
    if (!final && !stat.isDirectory()) {
      throw rejected(relativePath, "parent_is_not_directory");
    }

    const resolved = await realpath(current);
    assertWithinRoot(resolvedRoot, resolved, relativePath);

    if (!final) continue;
    if (!stat.isFile() && !stat.isDirectory()) {
      throw rejected(relativePath, "target_is_not_regular_file_or_directory");
    }
    if (stat.isDirectory() && options.recursive !== true) {
      throw rejected(relativePath, "recursive_cleanup_not_authorized");
    }
    await rm(current, {
      force: true,
      ...(stat.isDirectory() ? { recursive: true } : {}),
    });
    options.signal?.throwIfAborted();
  }
}

function isArtifactPartial(entry: string, basename: string): boolean {
  for (const prefix of [`.${basename}.partial-`, `${basename}.partial-`]) {
    if (entry.startsWith(prefix) && UUID_PATTERN.test(entry.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

export async function removeSafeBundleArtifactWithPartials(
  root: string,
  relativePath: string,
  options: Omit<SafeRemoveOptions, "recursive"> = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  assertSafeBundlePath(relativePath);

  const parent = path.posix.dirname(relativePath);
  const relativeParent = parent === "." ? "" : parent;
  const basename = path.posix.basename(relativePath);
  const entries = await safeDirectoryEntries(root, relativeParent, options.signal);
  const partials = entries.filter((entry) => isArtifactPartial(entry, basename));

  await removeSafeBundlePath(root, relativePath, { signal: options.signal });
  for (const partial of partials) {
    const candidate =
      relativeParent.length === 0 ? partial : `${relativeParent}/${partial}`;
    await removeSafeBundlePath(root, candidate, { signal: options.signal });
  }
  options.signal?.throwIfAborted();
}
