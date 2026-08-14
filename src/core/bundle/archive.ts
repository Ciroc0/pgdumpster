import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  constants as zlibConstants,
  createZstdCompress,
  createZstdDecompress,
} from "node:zlib";

import { extract, pack } from "tar-stream";

import {
  assertNoCaseFoldCollisions,
  assertSafeBundlePath,
} from "../../security/bundle-path.js";
import { verifyBundle } from "./verify.js";

export interface PackBundleOptions {
  signal?: AbortSignal | undefined;
  compressionLevel?: number;
}

export interface ExtractBundleOptions {
  signal?: AbortSignal | undefined;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILES = 1_000_000;
const DEFAULT_MAX_FILE_BYTES = 1_099_511_627_776;
const DEFAULT_MAX_TOTAL_BYTES = 4_398_046_511_104;

// Node's streaming Zstd binding can sporadically append this independent empty
// frame after the data frame. Concatenated frames are valid Zstd, but retaining
// a no-op frame makes identical inputs produce different archive bytes.
const EMPTY_ZSTD_FRAME = Buffer.from("28b52ffd240001000099e9d851", "hex");

export async function stripTrailingEmptyZstdFrames(
  handle: FileHandle,
): Promise<void> {
  let size = (await handle.stat()).size;
  const tail = Buffer.alloc(EMPTY_ZSTD_FRAME.length);
  while (size > EMPTY_ZSTD_FRAME.length) {
    const { bytesRead } = await handle.read(
      tail,
      0,
      tail.length,
      size - tail.length,
    );
    if (bytesRead !== tail.length || !tail.equals(EMPTY_ZSTD_FRAME)) return;
    size -= tail.length;
    await handle.truncate(size);
  }
}

function archiveRootName(output: string): string {
  const filename = path.basename(output);
  if (!filename.endsWith(".tar.zst")) {
    throw new Error("Packed bundle path must end in .tar.zst");
  }
  const root = filename.slice(0, -".tar.zst".length);
  assertSafeBundlePath(root);
  if (!root.startsWith("pgdumpster-")) {
    throw new Error("Packed bundle name must start with pgdumpster-");
  }
  return root;
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function packBundle(
  bundleRoot: string,
  output: string,
  options: PackBundleOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const verified = await verifyBundle(bundleRoot);
  const prefix = archiveRootName(output);
  const outputDirectory = path.dirname(path.resolve(output));
  const outputDirectoryStat = await lstat(outputDirectory);
  if (!outputDirectoryStat.isDirectory()) {
    throw new Error("Archive output parent must be a directory");
  }

  const temporary = path.join(
    outputDirectory,
    `.${path.basename(output)}.partial-${randomUUID()}`,
  );
  const files = [
    ...verified.checksums.keys(),
    "checksums.sha256",
    "manifest.json",
  ].sort(comparePaths);
  const tar = pack();
  const zstd = createZstdCompress({
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: options.compressionLevel ?? 10,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
      [zlibConstants.ZSTD_c_nbWorkers]: 0,
    },
  });
  const outputStream = createWriteStream(temporary, {
    flags: "wx",
    mode: 0o600,
  });
  const archivePipeline = pipeline(tar, zstd, outputStream, {
    signal: options.signal,
  });

  try {
    for (const relative of files) {
      options.signal?.throwIfAborted();
      const source = path.join(bundleRoot, ...relative.split("/"));
      const sourceStat = await stat(source);
      const entry = tar.entry({
        name: `${prefix}/${relative}`,
        type: "file",
        size: sourceStat.size,
        mode: 0o600,
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
        mtime: new Date(0),
      });
      await pipeline(
        createReadStream(source, { signal: options.signal }),
        entry,
        {
          signal: options.signal,
        },
      );
    }
    tar.finalize();
    await archivePipeline;
    const handle = await open(temporary, "r+");
    try {
      await stripTrailingEmptyZstdFrames(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
    options.signal?.throwIfAborted();
    await link(temporary, output);
    await rm(temporary);
  } catch (error) {
    tar.destroy();
    await archivePipeline.catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function extractBundleArchive(
  archive: string,
  destination: string,
  options: ExtractBundleOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const destinationStat = await lstat(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error("Extraction destination must be a real directory");
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const tar = extract();
  const decompressor = createZstdDecompress();
  const inputPipeline = pipeline(
    createReadStream(archive, { signal: options.signal }),
    decompressor,
    tar,
    { signal: options.signal },
  );
  const paths: string[] = [];
  let prefix: string | undefined;
  let totalBytes = 0;

  try {
    for await (const entry of tar) {
      options.signal?.throwIfAborted();
      const header = entry.header;
      assertSafeBundlePath(header.name);
      if (
        header.type !== "file" &&
        header.type !== null &&
        header.type !== undefined
      ) {
        throw new Error(`Archive entry type is forbidden: ${header.type}`);
      }
      if (header.linkname !== null && header.linkname !== undefined) {
        throw new Error("Archive links are forbidden");
      }
      const segments = header.name.split("/");
      if (segments.length < 2) {
        throw new Error("Archive entry must be inside one bundle root");
      }
      const entryPrefix = segments[0];
      if (entryPrefix === undefined) {
        throw new Error("Archive entry has no bundle root");
      }
      prefix ??= entryPrefix;
      if (entryPrefix !== prefix || !entryPrefix.startsWith("pgdumpster-")) {
        throw new Error(
          "Archive must contain exactly one pgdumpster bundle root",
        );
      }
      const relative = segments.slice(1).join("/");
      assertSafeBundlePath(relative);
      if (paths.includes(relative)) {
        throw new Error(`Duplicate archive entry: ${relative}`);
      }
      paths.push(relative);
      assertNoCaseFoldCollisions(paths);
      if (paths.length > maxFiles) {
        throw new Error(`Archive exceeds file-count limit ${maxFiles}`);
      }
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
        throw new Error(`Archive entry exceeds per-file limit: ${relative}`);
      }
      totalBytes += size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
        throw new Error(`Archive exceeds total-byte limit ${maxTotalBytes}`);
      }
      const target = path.join(
        destination,
        entryPrefix,
        ...relative.split("/"),
      );
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await pipeline(
        entry,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
        { signal: options.signal },
      );
    }
    await inputPipeline;
    if (prefix === undefined) throw new Error("Archive is empty");
    return path.join(destination, prefix);
  } catch (error) {
    tar.destroy();
    decompressor.destroy();
    await inputPipeline.catch(() => undefined);
    throw error;
  }
}
