import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  deriveBackupResult,
  validateCoverageOutcomes,
} from "../coverage/result.js";
import { loadCoverageRegistry } from "../coverage/registry.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import {
  isBundleWriterPartialName,
  removeSafeBundlePath,
} from "../../security/safe-remove.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { writeFileAtomic } from "../../utils/atomic-file.js";
import {
  coverageDocumentSchema,
  manifestSchema,
  type Manifest,
} from "./schemas.js";
import { verifyBundle } from "./verify.js";

export type ManifestBeforeFinalization = Omit<
  Manifest,
  "checksumFileSha256" | "statistics"
>;

export interface FinalizeBundleOptions {
  signal?: AbortSignal;
}

async function regularFiles(root: string, directory = ""): Promise<string[]> {
  const absolute = path.join(root, ...directory.split("/").filter(Boolean));
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    assertSafeBundlePath(relative);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are forbidden: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await regularFiles(root, relative)));
    } else if (entry.isFile()) {
      if (isBundleWriterPartialName(entry.name)) {
        await removeSafeBundlePath(root, relative);
        continue;
      }
      files.push(relative);
    } else {
      throw new Error(`Special files are forbidden: ${relative}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function sha256File(
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<{ hash: string; size: number }> {
  signal?.throwIfAborted();
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath, { signal })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    digest.update(buffer);
  }
  return { hash: digest.digest("hex"), size };
}

export async function finalizeBundle(
  root: string,
  manifestInput: ManifestBeforeFinalization,
  options: FinalizeBundleOptions = {},
): Promise<Manifest> {
  options.signal?.throwIfAborted();
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Bundle staging root must be a real directory");
  }

  const coverage = coverageDocumentSchema.parse(
    JSON.parse(await readFile(path.join(root, "coverage.json"), "utf8")),
  );
  const registry = await loadCoverageRegistry();
  validateCoverageOutcomes(registry, coverage.components);
  const derivedResult = deriveBackupResult(registry, coverage.components);
  if (manifestInput.result.status !== derivedResult) {
    throw new Error(
      `Manifest result ${manifestInput.result.status} does not match coverage result ${derivedResult}`,
    );
  }

  const files = (await regularFiles(root)).filter(
    (file) => file !== "manifest.json" && file !== "checksums.sha256",
  );
  for (const file of files) {
    if (file.includes(".partial-") || file.startsWith("checkpoints/")) {
      throw new Error(`Transient run file cannot be finalized: ${file}`);
    }
  }
  const fileSet = new Set(files);
  for (const component of coverage.components) {
    for (const artifact of component.artifacts) {
      assertSafeBundlePath(artifact);
      if (!fileSet.has(artifact)) {
        throw new Error(
          `Coverage artifact does not exist as a regular bundle file: ${component.id} -> ${artifact}`,
        );
      }
    }
  }

  let bytes = 0;
  const checksumLines: string[] = [];
  for (const file of files) {
    const digest = await sha256File(
      path.join(root, ...file.split("/")),
      options.signal,
    );
    bytes += digest.size;
    checksumLines.push(`${digest.hash}  ${file}`);
  }
  const checksumText = `${checksumLines.join("\n")}\n`;
  const checksumFileSha256 = createHash("sha256")
    .update(checksumText)
    .digest("hex");
  const manifest = manifestSchema.parse({
    ...manifestInput,
    checksumFileSha256,
    statistics: { files: files.length, bytes },
  });

  await writeFileAtomic(path.join(root, "checksums.sha256"), checksumText, {
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  await writeFileAtomic(
    path.join(root, "manifest.json"),
    canonicalJson(manifest),
    { signal: options.signal },
  );
  await verifyBundle(root);
  return manifest;
}
