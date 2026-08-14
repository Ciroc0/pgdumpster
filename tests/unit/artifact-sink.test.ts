import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDirectoryArtifactSink } from "../../src/core/bundle/artifact-sink.js";

describe("directory artifact sink", () => {
  it("streams an atomic no-clobber artifact and returns its digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pgdumpster-artifact-"));
    const sink = await createDirectoryArtifactSink(root);
    const result = await sink.writeStream(
      "functions/example/source.multipart",
      new Blob([new Uint8Array([1, 2]), new Uint8Array([3])]).stream(),
      { maxBytes: 3 },
    );
    expect(result).toEqual({
      bytes: 3,
      sha256:
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    });
    expect(
      new Uint8Array(
        await readFile(path.join(root, "functions/example/source.multipart")),
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
    await expect(
      sink.writeJson("functions/example/source.multipart", { replaced: true }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("cleans partial output after a byte-limit failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pgdumpster-artifact-"));
    const sink = await createDirectoryArtifactSink(root);
    await expect(
      sink.writeStream("functions/large.bin", new Blob(["1234"]).stream(), {
        maxBytes: 3,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_SIZE_LIMIT_EXCEEDED" });
    await expect(
      readFile(path.join(root, "functions/large.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a parent symlink or junction escape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pgdumpster-artifact-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "pgdumpster-outside-"),
    );
    await mkdir(path.join(root, "functions"));
    await symlink(
      outside,
      path.join(root, "functions", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const sink = await createDirectoryArtifactSink(root);
    await expect(
      sink.writeJson("functions/escape/created/value.json", { blocked: true }),
    ).rejects.toMatchObject({ code: "SECURITY_PATH_REJECTED" });
    await expect(stat(path.join(outside, "created"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
