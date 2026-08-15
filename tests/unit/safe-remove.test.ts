import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-safe-remove-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("safe bundle cleanup", () => {
  it("removes regular files inside the real bundle root", async () => {
    const bundleRoot = await root();
    await mkdir(path.join(bundleRoot, "secrets"));
    const target = path.join(bundleRoot, "secrets", "value.json");
    await writeFile(target, "secret\n");

    await removeSafeBundlePath(bundleRoot, "secrets/value.json");

    await expect(access(target)).rejects.toThrow();
  });

  it("removes an explicitly authorized real directory tree", async () => {
    const bundleRoot = await root();
    const tree = path.join(bundleRoot, "storage", "file-objects", "aa");
    await mkdir(tree, { recursive: true });
    await writeFile(path.join(tree, "object"), "payload\n");

    await removeSafeBundlePath(bundleRoot, "storage/file-objects", {
      recursive: true,
    });

    await expect(
      access(path.join(bundleRoot, "storage", "file-objects")),
    ).rejects.toThrow();
  });

  it("is a no-op when the scoped cleanup target does not exist", async () => {
    const bundleRoot = await root();

    await expect(
      removeSafeBundlePath(bundleRoot, "storage/file-catalog.json"),
    ).resolves.toBeUndefined();
  });

  it("removes atomic-writer partial siblings without touching near matches", async () => {
    const bundleRoot = await root();
    const secrets = path.join(bundleRoot, "secrets");
    await mkdir(secrets);
    const target = path.join(secrets, "value.json");
    const hiddenPartial = path.join(
      secrets,
      `.value.json.partial-${PARTIAL_UUID}`,
    );
    const streamPartial = path.join(
      secrets,
      `value.json.partial-${PARTIAL_UUID}`,
    );
    const nearMatch = path.join(secrets, ".value.json.partial-not-a-uuid");
    await Promise.all([
      writeFile(target, "final\n"),
      writeFile(hiddenPartial, "hidden partial\n"),
      writeFile(streamPartial, "stream partial\n"),
      writeFile(nearMatch, "must survive\n"),
    ]);

    await removeSafeBundleArtifactWithPartials(
      bundleRoot,
      "secrets/value.json",
    );

    await expect(access(target)).rejects.toThrow();
    await expect(access(hiddenPartial)).rejects.toThrow();
    await expect(access(streamPartial)).rejects.toThrow();
    await expect(readFile(nearMatch, "utf8")).resolves.toBe("must survive\n");
  });

  it("removes crash-leftover partials even when the final artifact does not exist", async () => {
    const bundleRoot = await root();
    const storage = path.join(bundleRoot, "storage");
    await mkdir(storage);
    const partial = path.join(
      storage,
      `.file-catalog.json.partial-${PARTIAL_UUID}`,
    );
    await writeFile(partial, "partial\n");

    await removeSafeBundleArtifactWithPartials(
      bundleRoot,
      "storage/file-catalog.json",
    );

    await expect(access(partial)).rejects.toThrow();
  });

  it("refuses a symlinked parent instead of deleting outside the bundle", async () => {
    const parent = await root();
    const bundleRoot = path.join(parent, "bundle");
    const outside = path.join(parent, "outside");
    await mkdir(bundleRoot);
    await mkdir(outside);
    const outsideFile = path.join(outside, "victim.json");
    await writeFile(outsideFile, "must survive\n");

    await symlink(
      outside,
      path.join(bundleRoot, "secrets"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      removeSafeBundlePath(bundleRoot, "secrets/victim.json"),
    ).rejects.toMatchObject({
      code: "SECURITY_PATH_REJECTED",
      category: "security",
    });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("must survive\n");
  });

  it("refuses recursive deletion unless the caller explicitly authorizes it", async () => {
    const bundleRoot = await root();
    await mkdir(path.join(bundleRoot, "functions"));

    await expect(
      removeSafeBundlePath(bundleRoot, "functions"),
    ).rejects.toMatchObject({ code: "SECURITY_PATH_REJECTED" });
    await expect(access(path.join(bundleRoot, "functions"))).resolves.toBeUndefined();
  });
});
