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

import { afterEach, describe, expect, it, vi } from "vitest";

import type { packBundle } from "../../src/core/bundle/archive.js";
import type { encryptArchiveWithAge } from "../../src/core/bundle/encryption.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";
import {
  publishBackupOutput,
  type BackupOutputPublicationOptions,
} from "../../src/destination/backup-output.js";
import type { publishS3Backup } from "../../src/destination/s3.js";

const temporaryDirectories: string[] = [];
const recipient = `age1${"q".repeat(58)}`;

async function fixture(): Promise<{
  directory: string;
  workspaceRoot: string;
  checkpointPath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-output-s3-"));
  temporaryDirectories.push(directory);
  const workspaceRoot = path.join(directory, "pgdumpster-run");
  const checkpointPath = `${workspaceRoot}.checkpoint.json`;
  await writeFile(checkpointPath, "checkpoint");
  await mkdir(workspaceRoot, { mode: 0o700 });
  await writeFile(path.join(workspaceRoot, "payload"), "secret payload");
  return { directory, workspaceRoot, checkpointPath };
}

function baseOptions(
  workspaceRoot: string,
  checkpointPath: string,
): Pick<
  BackupOutputPublicationOptions,
  "workspaceRoot" | "checkpointPath" | "runId" | "archiveRequested" | "resume"
> {
  return {
    workspaceRoot,
    checkpointPath,
    runId: "11111111-1111-4111-8111-111111111111",
    archiveRequested: false,
    resume: false,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("backup output publication", () => {
  it("forces archive+age for S3, publishes it, and removes local staging after commit", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "archive");
    });
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>(
      async (input, output) => {
        expect(await readFile(input, "utf8")).toBe("archive");
        await writeFile(output, "encrypted");
      },
    );
    const s3Publisher = vi.fn<typeof publishS3Backup>(
      (localFile, _config, options) =>
        Promise.resolve({
          locator: `s3://bucket/backups/${options.runId}/`,
          objectUri: `s3://bucket/backups/${options.runId}/${path.basename(localFile)}`,
          markerUri: `s3://bucket/backups/${options.runId}/COMPLETE.json`,
          size: 9,
          sha256: "0".repeat(64),
          recovered: false,
        }),
    );

    const result = await publishBackupOutput({
      ...baseOptions(workspaceRoot, checkpointPath),
      destination: { type: "s3", bucket: "bucket" },
      encryption: { mode: "age", recipient },
      archivePacker,
      ageEncryptor,
      s3Publisher,
    });

    expect(result.output).toMatch(/^s3:\/\/bucket\//u);
    expect(archivePacker).toHaveBeenCalledOnce();
    expect(ageEncryptor).toHaveBeenCalledOnce();
    expect(s3Publisher.mock.calls[0]?.[0]).toBe(`${workspaceRoot}.tar.zst.age`);
    expect(s3Publisher.mock.calls[0]?.[2]).toMatchObject({
      statePath: `${workspaceRoot}.s3-upload.json`,
    });
    await expect(access(workspaceRoot)).rejects.toThrow();
    await expect(access(checkpointPath)).rejects.toThrow();
    await expect(access(`${workspaceRoot}.tar.zst`)).rejects.toThrow();
    await expect(access(`${workspaceRoot}.tar.zst.age`)).rejects.toThrow();
  });

  it("preserves resumable staging when remote publication fails", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "archive");
    });
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>(
      async (_input, output) => {
        await writeFile(output, "encrypted");
      },
    );
    const s3Publisher = vi.fn<typeof publishS3Backup>(() =>
      Promise.reject(
        new PgDumpsterError({
          code: "S3_UPLOAD_PART_FAILED",
          category: "destination",
          message: "interrupted",
          retryable: false,
        }),
      ),
    );

    await expect(
      publishBackupOutput({
        ...baseOptions(workspaceRoot, checkpointPath),
        destination: { type: "s3", bucket: "bucket" },
        encryption: { mode: "age", recipient },
        archivePacker,
        ageEncryptor,
        s3Publisher,
      }),
    ).rejects.toMatchObject({ code: "S3_UPLOAD_PART_FAILED" });

    await expect(access(workspaceRoot)).resolves.toBeUndefined();
    await expect(access(checkpointPath)).resolves.toBeUndefined();
    await expect(
      access(`${workspaceRoot}.tar.zst.age`),
    ).resolves.toBeUndefined();
    await expect(access(`${workspaceRoot}.tar.zst`)).rejects.toThrow();
  });

  it("reuses an existing remote transport during resume when multipart state binds it", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const transport = `${workspaceRoot}.tar.zst.age`;
    const statePath = `${workspaceRoot}.s3-upload.json`;
    await writeFile(transport, "existing encrypted transport");
    await writeFile(statePath, "resume state");
    const archivePacker = vi.fn<typeof packBundle>();
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>();
    const s3Publisher = vi.fn<typeof publishS3Backup>(
      async (localFile, _config, options) => {
        expect(await readFile(localFile, "utf8")).toBe(
          "existing encrypted transport",
        );
        expect(options.statePath).toBe(statePath);
        return {
          locator: `s3://bucket/${options.runId}/`,
          objectUri: `s3://bucket/${options.runId}/${path.basename(localFile)}`,
          markerUri: `s3://bucket/${options.runId}/COMPLETE.json`,
          size: 28,
          sha256: "1".repeat(64),
          recovered: true,
        };
      },
    );

    await publishBackupOutput({
      ...baseOptions(workspaceRoot, checkpointPath),
      resume: true,
      destination: { type: "s3", bucket: "bucket" },
      encryption: { mode: "age", recipient },
      archivePacker,
      ageEncryptor,
      s3Publisher,
    });

    expect(archivePacker).not.toHaveBeenCalled();
    expect(ageEncryptor).not.toHaveBeenCalled();
    expect(s3Publisher).toHaveBeenCalledOnce();
  });

  it("regenerates an orphaned transport during resume when multipart state is absent", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const transport = `${workspaceRoot}.tar.zst.age`;
    await writeFile(transport, "orphaned transport");
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "fresh archive");
    });
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>(
      async (input, output) => {
        expect(await readFile(input, "utf8")).toBe("fresh archive");
        await writeFile(output, "fresh encrypted transport");
      },
    );
    const s3Publisher = vi.fn<typeof publishS3Backup>(
      async (localFile, _config, options) => {
        expect(await readFile(localFile, "utf8")).toBe(
          "fresh encrypted transport",
        );
        return {
          locator: `s3://bucket/${options.runId}/`,
          objectUri: `s3://bucket/${options.runId}/${path.basename(localFile)}`,
          markerUri: `s3://bucket/${options.runId}/COMPLETE.json`,
          size: 25,
          sha256: "3".repeat(64),
          recovered: false,
        };
      },
    );

    await publishBackupOutput({
      ...baseOptions(workspaceRoot, checkpointPath),
      resume: true,
      destination: { type: "s3", bucket: "bucket" },
      encryption: { mode: "age", recipient },
      archivePacker,
      ageEncryptor,
      s3Publisher,
    });

    expect(archivePacker).toHaveBeenCalledOnce();
    expect(ageEncryptor).toHaveBeenCalledOnce();
    expect(s3Publisher).toHaveBeenCalledOnce();
  });

  it("automatically archives an explicitly permitted plaintext S3 backup", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "plain remote archive");
    });
    const s3Publisher = vi.fn<typeof publishS3Backup>(
      async (localFile, _config, options) => {
        expect(localFile.endsWith(".tar.zst")).toBe(true);
        expect(await readFile(localFile, "utf8")).toBe("plain remote archive");
        return {
          locator: `s3://bucket/${options.runId}/`,
          objectUri: `s3://bucket/${options.runId}/${path.basename(localFile)}`,
          markerUri: `s3://bucket/${options.runId}/COMPLETE.json`,
          size: 20,
          sha256: "2".repeat(64),
          recovered: false,
        };
      },
    );

    const result = await publishBackupOutput({
      ...baseOptions(workspaceRoot, checkpointPath),
      destination: { type: "s3", bucket: "bucket" },
      encryption: { mode: "none" },
      archivePacker,
      s3Publisher,
    });

    expect(result.output).toMatch(/^s3:\/\/bucket\//u);
    expect(archivePacker).toHaveBeenCalledOnce();
  });
});
