import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPlaintextProtectedArtifactSink } from "../../src/security/protected-artifact.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("protected artifact sink", () => {
  it("requires explicit plaintext opt-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-secret-"));
    temporaryDirectories.push(root);
    await expect(
      createPlaintextProtectedArtifactSink(root, {
        allowPlaintextSecrets: false,
      }),
    ).rejects.toMatchObject({ code: "PLAINTEXT_SECRETS_NOT_ALLOWED" });
  });

  it("writes only beneath secrets with restrictive requested mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-secret-"));
    temporaryDirectories.push(root);
    const sink = await createPlaintextProtectedArtifactSink(root, {
      allowPlaintextSecrets: true,
    });
    await sink.writeJson("secrets/key.json", {
      schemaVersion: 1,
      value: "test-secret-canary",
    });
    const target = path.join(root, "secrets", "key.json");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      schemaVersion: 1,
      value: "test-secret-canary",
    });
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
    await expect(
      sink.writeJson("metadata/key.json", { value: "no" }),
    ).rejects.toMatchObject({ code: "SECURITY_PATH_REJECTED" });
    await expect(
      sink.writeJson("secrets/../../escaped.json", { value: "no" }),
    ).rejects.toThrow(/unsafe|dot segments|traversal/iu);
  });

  it("rejects a pre-existing secrets directory junction escape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-secret-"));
    const outside = await mkdtemp(path.join(tmpdir(), "pgdumpster-outside-"));
    temporaryDirectories.push(root, outside);
    await symlink(
      outside,
      path.join(root, "secrets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const sink = await createPlaintextProtectedArtifactSink(root, {
      allowPlaintextSecrets: true,
    });
    await expect(
      sink.writeJson("secrets/key.json", { value: "must-not-escape" }),
    ).rejects.toMatchObject({ code: "SECURITY_PATH_REJECTED" });
    await expect(readFile(path.join(outside, "key.json"))).rejects.toThrow();
  });
});
