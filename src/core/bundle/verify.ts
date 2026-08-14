import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PgDumpsterError } from "../errors/error.js";
import {
  deriveBackupResult,
  validateCoverageOutcomes,
} from "../coverage/result.js";
import { loadCoverageRegistry } from "../coverage/registry.js";
import {
  coverageDocumentSchema,
  manifestSchema,
  type CoverageDocument,
  type Manifest,
} from "./schemas.js";
import {
  assertNoCaseFoldCollisions,
  assertSafeBundlePath,
} from "../../security/bundle-path.js";

const CHECKSUM_LINE = /^([a-f0-9]{64}) {2}(.+)$/u;

export interface VerifiedBundle {
  root: string;
  manifest: Manifest;
  coverage: CoverageDocument;
  checksums: ReadonlyMap<string, string>;
}

async function sha256File(
  filePath: string,
): Promise<{ hash: string; size: number }> {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    digest.update(buffer);
  }
  return { hash: digest.digest("hex"), size };
}

async function listRegularFiles(
  root: string,
  directory = "",
): Promise<string[]> {
  const absolute = path.join(root, ...directory.split("/").filter(Boolean));
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative =
      directory === "" ? entry.name : `${directory}/${entry.name}`;
    assertSafeBundlePath(relative);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are forbidden: ${relative}`);
    if (entry.isDirectory())
      files.push(...(await listRegularFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Special files are forbidden: ${relative}`);
  }
  return files.sort();
}

function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match === null) throw new Error(`Invalid checksum line: ${line}`);
    const [, digest, bundlePath] = match;
    assertSafeBundlePath(bundlePath!);
    if (bundlePath === "manifest.json" || bundlePath === "checksums.sha256") {
      throw new Error(`Checksum index cannot include ${bundlePath}`);
    }
    if (checksums.has(bundlePath!))
      throw new Error(`Duplicate checksum path: ${bundlePath}`);
    checksums.set(bundlePath!, digest!);
    paths.push(bundlePath!);
  }
  assertNoCaseFoldCollisions(paths);
  return checksums;
}

function integrityError(cause: unknown): PgDumpsterError {
  return new PgDumpsterError({
    code: "BUNDLE_INCOMPLETE",
    category: "integrity",
    message:
      cause instanceof Error ? cause.message : "Bundle verification failed.",
    retryable: false,
    cause,
  });
}

export async function verifyBundle(root: string): Promise<VerifiedBundle> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(
        "This verifier currently requires a real directory bundle",
      );
    }

    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")),
    );
    const coverage = coverageDocumentSchema.parse(
      JSON.parse(
        await readFile(path.join(root, manifest.coverageFile), "utf8"),
      ),
    );
    const checksumText = await readFile(
      path.join(root, manifest.checksumFile),
      "utf8",
    );
    const checksumDigest = createHash("sha256")
      .update(checksumText)
      .digest("hex");
    if (checksumDigest !== manifest.checksumFileSha256) {
      throw new Error("Checksum index digest does not match manifest");
    }
    const checksums = parseChecksums(checksumText);
    const files = await listRegularFiles(root);
    const allowedUnindexed = new Set(["manifest.json", "checksums.sha256"]);
    for (const file of files) {
      if (!allowedUnindexed.has(file) && !checksums.has(file)) {
        throw new Error(`Unindexed extra file: ${file}`);
      }
    }
    for (const bundlePath of checksums.keys()) {
      if (!files.includes(bundlePath))
        throw new Error(`Missing checksummed file: ${bundlePath}`);
    }

    let bytes = 0;
    for (const [bundlePath, expected] of checksums) {
      const actual = await sha256File(
        path.join(root, ...bundlePath.split("/")),
      );
      if (actual.hash !== expected)
        throw new Error(`Checksum mismatch: ${bundlePath}`);
      bytes += actual.size;
    }
    if (
      manifest.statistics.files !== checksums.size ||
      manifest.statistics.bytes !== bytes
    ) {
      throw new Error("Manifest statistics do not match checksummed payloads");
    }

    const registry = await loadCoverageRegistry();
    validateCoverageOutcomes(registry, coverage.components);
    const derivedResult = deriveBackupResult(registry, coverage.components);
    if (manifest.result.status !== derivedResult) {
      throw new Error(
        `Manifest result ${manifest.result.status} does not match coverage result ${derivedResult}`,
      );
    }
    const coverageSummary = new Map(
      coverage.components.map(({ id, status }) => [id, status]),
    );
    if (manifest.components.length !== coverage.components.length) {
      throw new Error("Manifest and coverage component counts differ");
    }
    for (const component of manifest.components) {
      if (coverageSummary.get(component.id) !== component.status) {
        throw new Error(`Manifest/coverage mismatch: ${component.id}`);
      }
    }

    return { root, manifest, coverage, checksums };
  } catch (error) {
    if (error instanceof PgDumpsterError) throw error;
    throw integrityError(error);
  }
}
