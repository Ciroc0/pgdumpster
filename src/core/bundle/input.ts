import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractBundleArchive } from "./archive.js";
import { verifyBundle, type VerifiedBundle } from "./verify.js";

export async function withVerifiedBundle<T>(
  input: string,
  callback: (bundle: VerifiedBundle) => Promise<T> | T,
): Promise<T> {
  const inputStat = await lstat(input);
  if (inputStat.isDirectory() && !inputStat.isSymbolicLink()) {
    return callback(await verifyBundle(input));
  }
  if (!inputStat.isFile() || !input.endsWith(".tar.zst")) {
    throw new Error("Bundle input must be a directory or .tar.zst archive");
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "pgdumpster-extract-"));
  try {
    const root = await extractBundleArchive(input, temporary);
    return await callback(await verifyBundle(root));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
