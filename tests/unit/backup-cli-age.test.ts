import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import type { executeProductBackup } from "../../src/core/backup/product.js";
import type { packBundle } from "../../src/core/bundle/archive.js";
import type { encryptArchiveWithAge } from "../../src/core/bundle/encryption.js";
import type {
  CoverageDocument,
  Manifest,
} from "../../src/core/bundle/schemas.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

const temporaryDirectories: string[] = [];
const recipient = `age1${"q".repeat(58)}`;

function completedResult(): { manifest: Manifest; coverage: CoverageDocument } {
  return {
    manifest: {
      formatVersion: "1.0.0",
      tool: { name: "pgdumpster", version: "0.0.0-development" },
      operation: {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-15T02:00:00.000Z",
        completedAt: "2026-08-15T02:01:00.000Z",
      },
      source: { projectRef: "abcdefghijklmnopqrst" },
      result: { status: "complete", consistency: "verified" },
      coverageFile: "coverage.json",
      checksumFile: "checksums.sha256",
      checksumFileSha256: "0".repeat(64),
      components: [{ id: "database.roles", status: "backed_up" }],
      statistics: { files: 1, bytes: 1 },
    },
    coverage: {
      formatVersion: "1.0.0",
      components: [
        {
          id: "database.roles",
          status: "backed_up",
          sensitivity: "sensitive",
          artifacts: ["database/roles.sql"],
        },
      ],
    },
  };
}

async function setupConfig(contents: string): Promise<{
  directory: string;
  configPath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-cli-age-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "pgdumpster.yaml");
  await writeFile(configPath, contents);
  return { directory, configPath };
}

function ioBuffers() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("age-encrypted backup CLI", () => {
  it("forces archive publication, encrypts it, and removes plaintext staging", async () => {
    const { directory, configPath } = await setupConfig(
      `projectRef: abcdefghijklmnopqrst\nbackup:\n  output: ./backups\nencryption:\n  mode: age\n  recipient: ${recipient}\n`,
    );
    const { stdout, stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult()),
    );
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "plain archive");
    });
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>(
      async (archive, output, receivedRecipient) => {
        expect(receivedRecipient).toBe(recipient);
        expect(await readFile(archive, "utf8")).toBe("plain archive");
        await writeFile(output, "encrypted archive");
      },
    );

    const exitCode = await runCli(
      ["backup", "--linked", "--config", configPath, "--json"],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        archivePacker,
        ageEncryptor,
        now: () => new Date("2026-08-15T02:00:00.000Z"),
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(archivePacker).toHaveBeenCalledOnce();
    expect(ageEncryptor).toHaveBeenCalledOnce();
    expect(backupExecutor.mock.calls[0]?.[0]).toMatchObject({
      allowPlaintextSecrets: true,
    });
    const result = JSON.parse(stdout.join("")) as { output: string };
    expect(result.output).toMatch(/\.tar\.zst\.age$/u);
    expect(await readFile(result.output, "utf8")).toBe("encrypted archive");
    await expect(access(result.output.slice(0, -".age".length))).rejects.toThrow();
    const workspace = result.output.slice(0, -".tar.zst.age".length);
    await expect(access(workspace)).rejects.toThrow();
    expect(result.output.startsWith(path.join(directory, "backups"))).toBe(true);
  });

  it("requires a recipient before starting an encrypted backup", async () => {
    const { configPath } = await setupConfig(
      "projectRef: abcdefghijklmnopqrst\nencryption:\n  mode: age\n  identityFile: ./identity.txt\n",
    );
    const { stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>();

    const exitCode = await runCli(
      ["backup", "--linked", "--config", configPath, "--json"],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
      },
    );

    expect(exitCode).toBe(2);
    expect(backupExecutor).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("CONFIG_MISSING_REQUIRED");
  });

  it("removes plaintext staging when age publication fails", async () => {
    const { directory, configPath } = await setupConfig(
      `projectRef: abcdefghijklmnopqrst\nbackup:\n  output: ./backups\nencryption:\n  mode: age\n  recipient: ${recipient}\n`,
    );
    const { stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult()),
    );
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "plain archive");
    });
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>(() =>
      Promise.reject(
        new PgDumpsterError({
          code: "ENCRYPTION_FAILED",
          category: "encryption",
          message: "test encryption failure",
          retryable: false,
        }),
      ),
    );
    const workspace = path.join(
      directory,
      "backups",
      "pgdumpster-2026-08-15T02-00-00.000Z",
    );

    const exitCode = await runCli(
      ["backup", "--linked", "--config", configPath, "--json"],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        archivePacker,
        ageEncryptor,
        now: () => new Date("2026-08-15T02:00:00.000Z"),
      },
    );

    expect(exitCode).toBe(7);
    expect(stderr.join("")).toContain("ENCRYPTION_FAILED");
    await expect(access(workspace)).rejects.toThrow();
    await expect(access(`${workspace}.tar.zst`)).rejects.toThrow();
  });
});
