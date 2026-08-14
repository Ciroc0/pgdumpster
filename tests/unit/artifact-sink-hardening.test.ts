import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDirectoryArtifactSink } from "../../src/core/bundle/artifact-sink.js";
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

async function root(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-artifact-hardening-"),
  );

  temporaryDirectories.push(directory);
  return directory;
}

describe("directory artifact sink hardening", () => {
  it("rejects an artifact root that is not a directory", async () => {
    const parent = await root();
    const file = path.join(parent, "root-file");

    await writeFile(file, "not a directory");

    await expect(createDirectoryArtifactSink(file)).rejects.toMatchObject({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
    });
  });

  it("rejects negative, fractional and non-finite byte limits", async () => {
    const directory = await root();
    const sink = await createDirectoryArtifactSink(directory);

    for (const maxBytes of [-1, 1.5, Number.NaN]) {
      await expect(
        sink.writeStream("objects/example.bin", new Blob(["x"]).stream(), {
          maxBytes,
        }),
      ).rejects.toThrow("maxBytes must be a non-negative safe integer");
    }

    await expect(
      readFile(path.join(directory, "objects", "example.bin")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("honors cancellation before opening partial output", async () => {
    const directory = await root();
    const sink = await createDirectoryArtifactSink(directory);

    const controller = new AbortController();
    const reason = new Error("cancel artifact write");

    controller.abort(reason);

    await expect(
      sink.writeStream("objects/cancelled.bin", new Blob(["data"]).stream(), {
        maxBytes: 4,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    await expect(
      readFile(path.join(directory, "objects", "cancelled.bin")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes and hashes a valid zero-byte artifact", async () => {
    const directory = await root();
    const sink = await createDirectoryArtifactSink(directory);

    const result = await sink.writeStream(
      "objects/empty.bin",
      new Blob([]).stream(),
      {
        maxBytes: 0,
      },
    );

    expect(result).toEqual({
      bytes: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

    expect(
      await readFile(path.join(directory, "objects", "empty.bin")),
    ).toHaveLength(0);
  });

  it("exercises the JSON writer on a successful new artifact", async () => {
    const directory = await root();
    const sink = await createDirectoryArtifactSink(directory);

    const value = {
      alpha: 1,
      beta: "two",
    };

    const result = await sink.writeJson("metadata/example.json", value);

    const expected = canonicalJson(value);
    const written = await readFile(
      path.join(directory, "metadata", "example.json"),
      "utf8",
    );

    expect(written).toBe(expected);
    expect(result.bytes).toBe(Buffer.byteLength(expected));
  });
});
