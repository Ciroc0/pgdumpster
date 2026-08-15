import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isBundleWriterPartialName,
  removeSafeBundleArtifactWithPartials,
  removeSafeBundlePath,
} from "../../src/security/safe-remove.js";

const temporaryDirectories: string[] = [];
const PARTIAL_UUID = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-safe-remove-hardening-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("safe cleanup hardening", () => {
  it("recognizes only UUID-suffixed writer partial names", () => {
    expect(isBundleWriterPartialName(`value.partial-${PARTIAL_UUID}`)).toBe(true);
    expect(isBundleWriterPartialName(`.value.partial-${PARTIAL_UUID}`)).toBe(true);
    expect(isBundleWriterPartialName("partial-without-marker")).toBe(false);
    expect(isBundleWriterPartialName(".partial-11111111-1111-4111-8111-111111111111")).toBe(
      false,
    );
    expect(isBundleWriterPartialName("value.partial-not-a-uuid")).toBe(false);
    expect(
      isBundleWriterPartialName(
        "value.partial-11111111-1111-0111-8111-111111111111",
      ),
    ).toBe(false);
  });

  it("handles root-level partial siblings and preserves unrelated UUID partials", async () => {
    const bundleRoot = await root();
    const target = path.join(bundleRoot, "manifest.json");
    const ownedPartial = path.join(
      bundleRoot,
      `.manifest.json.partial-${PARTIAL_UUID}`,
    );
    const unrelatedPartial = path.join(
      bundleRoot,
      `.coverage.json.partial-${PARTIAL_UUID}`,
    );
    await Promise.all([
      writeFile(target, "manifest"),
      writeFile(ownedPartial, "owned"),
      writeFile(unrelatedPartial, "unrelated"),
    ]);

    await removeSafeBundleArtifactWithPartials(bundleRoot, "manifest.json");

    await expect(access(target)).rejects.toThrow();
    await expect(access(ownedPartial)).rejects.toThrow();
    await expect(readFile(unrelatedPartial, "utf8")).resolves.toBe("unrelated");
  });

  it("returns safely when the artifact parent directory does not exist", async () => {
    const bundleRoot = await root();

    await expect(
      removeSafeBundleArtifactWithPartials(
        bundleRoot,
        "missing/deeper/artifact.json",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a non-directory bundle root and a non-directory parent", async () => {
    const parent = await root();
    const fileRoot = path.join(parent, "bundle-file");
    await writeFile(fileRoot, "not a directory");

    await expect(
      removeSafeBundlePath(fileRoot, "artifact.json"),
    ).rejects.toMatchObject({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
    });

    const bundleRoot = path.join(parent, "bundle");
    await mkdir(bundleRoot);
    await writeFile(path.join(bundleRoot, "secrets"), "not a directory");

    await expect(
      removeSafeBundleArtifactWithPartials(bundleRoot, "secrets/value.json"),
    ).rejects.toMatchObject({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
    });
    await expect(
      removeSafeBundlePath(bundleRoot, "secrets/value.json"),
    ).rejects.toMatchObject({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
    });
  });

  it("honors cancellation before inspecting or deleting paths", async () => {
    const bundleRoot = await root();
    const controller = new AbortController();
    const reason = new Error("cancel cleanup");
    controller.abort(reason);

    await expect(
      removeSafeBundlePath(bundleRoot, "value.json", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    await expect(
      removeSafeBundleArtifactWithPartials(bundleRoot, "value.json", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
