import { createWriteStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";

import { pack, type Headers } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/main.js";
import {
  extractBundleArchive,
  packBundle,
  stripTrailingEmptyZstdFrames,
} from "../../src/core/bundle/archive.js";
import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { verifyBundle } from "../../src/core/bundle/verify.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

async function craftedArchive(
  output: string,
  header: Headers,
  contents = "x",
): Promise<void> {
  const tar = pack();
  const writing = pipeline(
    tar,
    createZstdCompress(),
    createWriteStream(output),
  );
  tar.entry({ ...header, size: Buffer.byteLength(contents) }, contents);
  tar.finalize();
  await writing;
}

async function finalizedBundle(parent: string): Promise<string> {
  const root = path.join(parent, "staging");
  await mkdir(path.join(root, "database"), { recursive: true });
  const registry = await loadCoverageRegistry();
  const components = registry.components.map(({ id, sensitivity }) => ({
    id,
    status: "backed_up" as const,
    sensitivity,
    artifacts: id === "database.schema" ? ["database/schema.sql"] : [],
  }));
  await writeFile(
    path.join(root, "database", "schema.sql"),
    "create table public.example(id bigint primary key);\n",
  );
  await writeFile(
    path.join(root, "coverage.json"),
    canonicalJson({ formatVersion: "1.0.0", components }),
  );
  const manifest: ManifestBeforeFinalization = {
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: "0.0.0-test" },
    operation: {
      id: "019ffcf4-d0b6-7b40-847b-668eb570a987",
      startedAt: "2026-08-13T20:00:00.000Z",
      completedAt: "2026-08-13T20:01:00.000Z",
    },
    source: { projectRef: "abcdefghijklmnopqrst" },
    result: { status: "complete", consistency: "verified" },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    components: components.map(({ id, status }) => ({ id, status })),
  };
  await finalizeBundle(root, manifest);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("deterministic tar.zst packing", () => {
  it("removes only trailing independent empty Zstd frames", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-archive-"));
    temporaryDirectories.push(parent);
    const target = path.join(parent, "frames.zst");
    const content = Buffer.concat([
      Buffer.from("non-empty-frame"),
      Buffer.from("28b52ffd240001000099e9d851", "hex"),
      Buffer.from("28b52ffd240001000099e9d851", "hex"),
    ]);
    await writeFile(target, content);
    const handle = await open(target, "r+");
    try {
      await stripTrailingEmptyZstdFrames(handle);
    } finally {
      await handle.close();
    }
    expect(await readFile(target)).toEqual(Buffer.from("non-empty-frame"));
  });

  it("produces identical bytes and refuses an existing destination", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-archive-"));
    temporaryDirectories.push(parent);
    const root = await finalizedBundle(parent);
    const firstDirectory = path.join(parent, "first");
    const secondDirectory = path.join(parent, "second");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    const archiveName = "pgdumpster-2026-08-13T200100.000Z.tar.zst";
    const first = path.join(firstDirectory, archiveName);
    const second = path.join(secondDirectory, archiveName);
    await packBundle(root, first);
    await packBundle(root, second);
    expect(await readFile(first)).toEqual(await readFile(second));
    const extraction = await mkdtemp(
      path.join(parent, "pgdumpster-extracted-"),
    );
    const extractedRoot = await extractBundleArchive(first, extraction);
    await expect(verifyBundle(extractedRoot)).resolves.toMatchObject({
      root: extractedRoot,
    });
    await expect(
      runCli(["verify", first, "--json"], {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).resolves.toBe(0);
    await expect(packBundle(root, first)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("does not publish a partial archive when already aborted", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-archive-"));
    temporaryDirectories.push(parent);
    const root = await finalizedBundle(parent);
    const output = path.join(parent, "pgdumpster-aborted.tar.zst");
    const controller = new AbortController();
    controller.abort(new Error("test interruption"));
    await expect(
      packBundle(root, output, { signal: controller.signal }),
    ).rejects.toThrow(/test interruption/u);
    await expect(readFile(output)).rejects.toThrow();
  });

  it("rejects traversal, links, and decompressed size excess", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-archive-"));
    temporaryDirectories.push(parent);
    const destination = await mkdtemp(path.join(parent, "extract-"));

    const traversal = path.join(parent, "traversal.tar.zst");
    await craftedArchive(traversal, {
      name: "pgdumpster-test/../../escaped.txt",
      type: "file",
    });
    await expect(extractBundleArchive(traversal, destination)).rejects.toThrow(
      /unsafe bundle path|traversal|dot segments/iu,
    );

    const link = path.join(parent, "link.tar.zst");
    await craftedArchive(
      link,
      {
        name: "pgdumpster-test/link",
        type: "symlink",
        linkname: "../../escaped.txt",
      },
      "",
    );
    await expect(extractBundleArchive(link, destination)).rejects.toThrow(
      /entry type|links are forbidden/u,
    );

    const root = await finalizedBundle(parent);
    const valid = path.join(parent, "pgdumpster-limited.tar.zst");
    await packBundle(root, valid);
    await expect(
      extractBundleArchive(valid, destination, { maxFileBytes: 1 }),
    ).rejects.toThrow(/per-file limit/u);
  });
});
