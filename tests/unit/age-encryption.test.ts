import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptArchiveWithAge,
  encryptArchiveWithAge,
  type AgeProcessRunner,
} from "../../src/core/bundle/encryption.js";

const temporaryDirectories: string[] = [];
const recipient = `age1${"q".repeat(58)}`;

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-age-"));
  temporaryDirectories.push(directory);
  return directory;
}

function successfulRunner(contents: string): AgeProcessRunner {
  return vi.fn<AgeProcessRunner>(async (_command, args) => {
    const outputIndex = args.indexOf("--output");
    const output = args[outputIndex + 1];
    if (output === undefined) throw new Error("missing output argument");
    await writeFile(output, contents);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("age archive encryption", () => {
  it("encrypts a tar.zst to an atomic tar.zst.age output", async () => {
    const directory = await root();
    const archive = path.join(directory, "backup with spaces.tar.zst");
    const output = `${archive}.age`;
    await writeFile(archive, "plain archive");
    const runner = successfulRunner("encrypted bytes");

    await encryptArchiveWithAge(archive, output, recipient, {
      runProcess: runner,
      environment: { PATH: "test-path" },
    });

    expect(await readFile(output, "utf8")).toBe("encrypted bytes");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "age",
      [
        "--encrypt",
        "--recipient",
        recipient,
        "--output",
        expect.stringContaining(".partial-"),
        archive,
      ],
      expect.objectContaining({
        environment: { PATH: "test-path" },
        maxOutputBytes: 65_536,
      }),
    );
  });

  it("decrypts with an identity file path without exposing identity contents", async () => {
    const directory = await root();
    const encrypted = path.join(directory, "backup.tar.zst.age");
    const output = path.join(directory, "backup.tar.zst");
    const identity = path.join(directory, "identity key.txt");
    const privateValue = "AGE-SECRET-KEY-1TEST-PRIVATE-MATERIAL";
    await writeFile(encrypted, "encrypted bytes");
    await writeFile(identity, privateValue);
    const runner = successfulRunner("plain archive");

    await decryptArchiveWithAge(encrypted, output, identity, {
      runProcess: runner,
    });

    expect(await readFile(output, "utf8")).toBe("plain archive");
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).toContain(identity);
    expect(args.join(" ")).not.toContain(privateValue);
  });

  it("fails closed on invalid archive suffixes and recipients", async () => {
    const directory = await root();
    const input = path.join(directory, "backup.txt");
    await writeFile(input, "plain");

    await expect(
      encryptArchiveWithAge(input, `${input}.age`, recipient),
    ).rejects.toMatchObject({ code: "ENCRYPTION_FAILED" });
    await expect(
      encryptArchiveWithAge(
        path.join(directory, "backup.tar.zst"),
        path.join(directory, "backup.tar.zst.age"),
        "invalid",
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      decryptArchiveWithAge(
        path.join(directory, "backup.age"),
        path.join(directory, "backup.tar.zst"),
        path.join(directory, "identity.txt"),
      ),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("maps missing age executable to a dependency error and removes partial output", async () => {
    const directory = await root();
    const archive = path.join(directory, "backup.tar.zst");
    const output = `${archive}.age`;
    await writeFile(archive, "plain");
    const runner = vi.fn<AgeProcessRunner>(async (_command, args) => {
      const outputIndex = args.indexOf("--output");
      const temporary = args[outputIndex + 1];
      if (temporary !== undefined) await writeFile(temporary, "partial");
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });

    await expect(
      encryptArchiveWithAge(archive, output, recipient, {
        runProcess: runner,
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_NOT_FOUND",
      category: "dependency",
    });
    await expect(access(output)).rejects.toThrow();
  });

  it("maps non-zero encryption and decryption exits without publishing output", async () => {
    const directory = await root();
    const archive = path.join(directory, "backup.tar.zst");
    const encrypted = `${archive}.age`;
    const identity = path.join(directory, "identity.txt");
    await writeFile(archive, "plain");
    await writeFile(encrypted, "cipher");
    await writeFile(identity, "AGE-SECRET-KEY-1TEST");
    const runner = vi.fn<AgeProcessRunner>(() =>
      Promise.resolve({ exitCode: 1, stdout: "", stderr: "secret diagnostic" }),
    );

    await expect(
      encryptArchiveWithAge(
        archive,
        path.join(directory, "failed.tar.zst.age"),
        recipient,
        { runProcess: runner },
      ),
    ).rejects.toMatchObject({
      code: "ENCRYPTION_FAILED",
      details: { exitCode: 1 },
    });
    await expect(
      decryptArchiveWithAge(
        encrypted,
        path.join(directory, "decrypted.tar.zst"),
        identity,
        { runProcess: runner },
      ),
    ).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
      details: { exitCode: 1 },
    });
  });

  it("rejects missing or non-file inputs and invalid output parents", async () => {
    const directory = await root();
    const archiveDirectory = path.join(directory, "directory.tar.zst");
    await mkdir(archiveDirectory);
    await expect(
      encryptArchiveWithAge(
        archiveDirectory,
        path.join(directory, "output.tar.zst.age"),
        recipient,
      ),
    ).rejects.toMatchObject({ code: "ENCRYPTION_FAILED" });

    const encrypted = path.join(directory, "backup.tar.zst.age");
    await writeFile(encrypted, "cipher");
    await expect(
      decryptArchiveWithAge(
        encrypted,
        path.join(directory, "output.tar.zst"),
        path.join(directory, "missing-identity.txt"),
      ),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });

    const archive = path.join(directory, "backup.tar.zst");
    const parentFile = path.join(directory, "not-a-directory");
    await writeFile(archive, "plain");
    await writeFile(parentFile, "file");
    await expect(
      encryptArchiveWithAge(
        archive,
        path.join(parentFile, "output.tar.zst.age"),
        recipient,
      ),
    ).rejects.toMatchObject({ code: "ENCRYPTION_FAILED" });
  });

  it("propagates an already-aborted signal before starting age", async () => {
    const directory = await root();
    const archive = path.join(directory, "backup.tar.zst");
    await writeFile(archive, "plain");
    const runner = successfulRunner("cipher");
    const controller = new AbortController();
    controller.abort(new Error("cancelled encryption"));

    await expect(
      encryptArchiveWithAge(archive, `${archive}.age`, recipient, {
        signal: controller.signal,
        runProcess: runner,
      }),
    ).rejects.toThrow("cancelled encryption");
    expect(runner).not.toHaveBeenCalled();
  });
});
