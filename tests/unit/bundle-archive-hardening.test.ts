import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
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
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function parent(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-archive-hardening-"),
  );

  temporaryDirectories.push(directory);
  return directory;
}

async function destination(root: string): Promise<string> {
  const directory = path.join(
    root,
    `extract-${Math.random().toString(16).slice(2)}`,
  );

  await mkdir(directory);
  return directory;
}

async function writeArchive(
  output: string,
  entries: readonly {
    header: Headers;
    contents?: string;
  }[],
): Promise<void> {
  const tar = pack();

  const writing = pipeline(
    tar,
    createZstdCompress(),
    createWriteStream(output),
  );

  for (const entry of entries) {
    const contents = entry.contents ?? "";

    tar.entry(
      {
        ...entry.header,
        size: Buffer.byteLength(contents),
      },
      contents,
    );
  }

  tar.finalize();
  await writing;
}

async function finalizedBundle(directory: string): Promise<string> {
  const root = path.join(directory, "bundle");

  await mkdir(path.join(root, "database"), {
    recursive: true,
  });

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
    canonicalJson({
      formatVersion: "1.0.0",
      components,
    }),
  );

  const manifest: ManifestBeforeFinalization = {
    formatVersion: "1.0.0",
    tool: {
      name: "pgdumpster",
      version: "0.0.0-test",
    },
    operation: {
      id: "019ffcf4-d0b6-7b40-847b-668eb570a987",
      startedAt: "2026-08-14T20:00:00.000Z",
      completedAt: "2026-08-14T20:01:00.000Z",
    },
    source: {
      projectRef: "abcdefghijklmnopqrst",
    },
    result: {
      status: "complete",
      consistency: "verified",
    },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    components: components.map(({ id, status }) => ({
      id,
      status,
    })),
  };

  await finalizeBundle(root, manifest);

  return root;
}

describe("bundle archive hardening", () => {
  it("leaves non-empty-frame tails untouched", async () => {
    const directory = await parent();
    const target = path.join(directory, "plain.zst");

    const contents = Buffer.alloc(32, 0x41);

    await writeFile(target, contents);

    const handle = await open(target, "r+");

    try {
      await stripTrailingEmptyZstdFrames(handle);
    } finally {
      await handle.close();
    }

    expect(await readFile(target)).toEqual(contents);
  });

  it("rejects invalid packed archive names", async () => {
    const directory = await parent();
    const root = await finalizedBundle(directory);

    await expect(
      packBundle(root, path.join(directory, "pgdumpster-test.zip")),
    ).rejects.toThrow("must end in .tar.zst");

    await expect(
      packBundle(root, path.join(directory, "backup-test.tar.zst")),
    ).rejects.toThrow("must start with pgdumpster-");
  });

  it("rejects a packed archive parent that is not a directory", async () => {
    const directory = await parent();
    const root = await finalizedBundle(directory);

    const outputParent = path.join(directory, "not-a-directory");

    await writeFile(outputParent, "file");

    await expect(
      packBundle(root, path.join(outputParent, "pgdumpster-test.tar.zst")),
    ).rejects.toThrow("Archive output parent must be a directory");
  });

  it("rejects an extraction destination that is not a real directory", async () => {
    const directory = await parent();
    const target = path.join(directory, "destination-file");

    await writeFile(target, "file");

    await expect(
      extractBundleArchive(path.join(directory, "missing.tar.zst"), target),
    ).rejects.toThrow("Extraction destination must be a real directory");
  });

  it("rejects an empty archive", async () => {
    const directory = await parent();
    const archive = path.join(directory, "empty.tar.zst");

    await writeArchive(archive, []);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow("Archive is empty");
  });

  it("requires every entry to live beneath a bundle root", async () => {
    const directory = await parent();
    const archive = path.join(directory, "rootless.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "lonely.txt",
          type: "file",
        },
        contents: "x",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow("Archive entry must be inside one bundle root");
  });

  it("requires the archive root to use the pgdumpster prefix", async () => {
    const directory = await parent();
    const archive = path.join(directory, "wrong-root.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "other-root/file.txt",
          type: "file",
        },
        contents: "x",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow(
      "Archive must contain exactly one pgdumpster bundle root",
    );
  });

  it("rejects multiple bundle roots", async () => {
    const directory = await parent();
    const archive = path.join(directory, "multiple-roots.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/a.txt",
          type: "file",
        },
        contents: "a",
      },
      {
        header: {
          name: "pgdumpster-two/b.txt",
          type: "file",
        },
        contents: "b",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow(
      "Archive must contain exactly one pgdumpster bundle root",
    );
  });

  it("rejects duplicate archive entries", async () => {
    const directory = await parent();
    const archive = path.join(directory, "duplicate.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/a.txt",
          type: "file",
        },
        contents: "a",
      },
      {
        header: {
          name: "pgdumpster-one/a.txt",
          type: "file",
        },
        contents: "b",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow("Duplicate archive entry");
  });

  it("rejects case-fold archive collisions", async () => {
    const directory = await parent();
    const archive = path.join(directory, "case-collision.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/A.txt",
          type: "file",
        },
        contents: "a",
      },
      {
        header: {
          name: "pgdumpster-one/a.txt",
          type: "file",
        },
        contents: "b",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow(/case|collision/iu);
  });

  it("enforces the archive file-count limit", async () => {
    const directory = await parent();
    const archive = path.join(directory, "file-count.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/a.txt",
          type: "file",
        },
        contents: "a",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory), {
        maxFiles: 0,
      }),
    ).rejects.toThrow("Archive exceeds file-count limit 0");
  });

  it("enforces the total decompressed byte limit independently", async () => {
    const directory = await parent();
    const archive = path.join(directory, "total-limit.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/a.txt",
          type: "file",
        },
        contents: "ab",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory), {
        maxFileBytes: 10,
        maxTotalBytes: 1,
      }),
    ).rejects.toThrow("Archive exceeds total-byte limit 1");
  });

  it("rejects non-file archive entry types", async () => {
    const directory = await parent();
    const archive = path.join(directory, "directory-entry.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/directory",
          type: "directory",
        },
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow("Archive entry type is forbidden");
  });

  it("rejects link metadata even on a nominal file entry", async () => {
    const directory = await parent();
    const archive = path.join(directory, "link-metadata.tar.zst");

    await writeArchive(archive, [
      {
        header: {
          name: "pgdumpster-one/file.txt",
          type: "file",
          linkname: "target.txt",
        },
        contents: "x",
      },
    ]);

    await expect(
      extractBundleArchive(archive, await destination(directory)),
    ).rejects.toThrow("Archive links are forbidden");
  });
});
