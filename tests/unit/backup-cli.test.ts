import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import type { executeProductBackup } from "../../src/core/backup/product.js";
import type {
  CoverageDocument,
  Manifest,
} from "../../src/core/bundle/schemas.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function completedResult(
  consistency: Manifest["result"]["consistency"] = "verified",
): {
  manifest: Manifest;
  coverage: CoverageDocument;
} {
  return {
    manifest: {
      formatVersion: "1.0.0",
      tool: { name: "pgdumpster", version: "0.0.0-development" },
      operation: {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:01:00.000Z",
      },
      source: { projectRef: "abcdefghijklmnopqrst" },
      result: {
        status: "complete_with_platform_limits",
        consistency,
      },
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

async function outputDirectory(): Promise<string> {
  const output = await mkdtemp(path.join(tmpdir(), "pgdumpster-cli-backup-"));
  temporaryDirectories.push(output);
  return output;
}

describe("backup CLI", () => {
  it("uses verified consistency by default and emits one stable JSON result", async () => {
    const output = await outputDirectory();
    const { stdout, stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult("verified")),
    );

    const exitCode = await runCli(
      [
        "backup",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--linked",
        "--output",
        output,
        "--allow-plaintext-secrets",
        "--json",
      ],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        now: () => new Date("2026-08-14T00:00:00.000Z"),
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(backupExecutor).toHaveBeenCalledOnce();
    expect(backupExecutor.mock.calls[0]?.[0]).toMatchObject({
      projectRef: "abcdefghijklmnopqrst",
      linked: true,
      consistency: "verified",
      allowPlaintextSecrets: true,
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      type: "backup.result",
      runId: "11111111-1111-4111-8111-111111111111",
      status: "complete_with_platform_limits",
      consistency: "verified",
      coverageCount: 1,
    });
    expect(stdout.join("")).not.toContain("management-secret");
  });

  it("forwards explicit quiesced consistency to the backup executor", async () => {
    const output = await outputDirectory();
    const { stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult("quiesced")),
    );

    const exitCode = await runCli(
      [
        "backup",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--linked",
        "--output",
        output,
        "--consistency",
        "quiesced",
        "--allow-plaintext-secrets",
      ],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(backupExecutor.mock.calls[0]?.[0]).toMatchObject({
      consistency: "quiesced",
    });
  });

  it("emits drift_detected when a best-effort backup observed source drift", async () => {
    const output = await outputDirectory();
    const { stdout, stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult("drift_detected")),
    );

    const exitCode = await runCli(
      [
        "backup",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--linked",
        "--output",
        output,
        "--consistency",
        "best-effort",
        "--allow-plaintext-secrets",
        "--json",
      ],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      consistency: "drift_detected",
    });
    expect(backupExecutor.mock.calls[0]?.[0]).toMatchObject({
      consistency: "best-effort",
    });
  });

  it("rejects plaintext output before backup execution", async () => {
    const output = await outputDirectory();
    const backupExecutor = vi.fn<typeof executeProductBackup>();
    const io = { stdout: vi.fn(), stderr: vi.fn() };

    await expect(
      runCli(
        [
          "backup",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--linked",
          "--output",
          output,
        ],
        io,
        {
          environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
          backupExecutor,
        },
      ),
    ).resolves.toBe(7);

    expect(backupExecutor).not.toHaveBeenCalled();
  });

  it("maps consistency verification failures to exit code 6", async () => {
    const output = await outputDirectory();
    const { stdout, stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.reject(
        new PgDumpsterError({
          code: "SOURCE_DID_NOT_STABILIZE",
          category: "consistency",
          message: "Source did not stabilize.",
          retryable: false,
        }),
      ),
    );

    const exitCode = await runCli(
      [
        "backup",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--linked",
        "--output",
        output,
        "--allow-plaintext-secrets",
        "--json",
      ],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        now: () => new Date("2026-08-14T00:00:00.000Z"),
      },
    );

    expect(exitCode).toBe(6);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("SOURCE_DID_NOT_STABILIZE");
    expect(stderr.join("")).not.toContain("management-secret");
  });
});
