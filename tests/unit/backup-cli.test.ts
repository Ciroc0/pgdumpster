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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function completedResult(): {
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
        consistency: "best_effort",
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

describe("backup CLI", () => {
  it("resolves a linked plaintext backup and emits one stable JSON result", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "pgdumpster-cli-backup-"));
    temporaryDirectories.push(output);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult()),
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
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
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
      consistency: "best-effort",
      allowPlaintextSecrets: true,
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      type: "backup.result",
      runId: "11111111-1111-4111-8111-111111111111",
      status: "complete_with_platform_limits",
      coverageCount: 1,
    });
    expect(stdout.join("")).not.toContain("management-secret");
  });

  it("rejects plaintext output and unimplemented verified consistency before execution", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "pgdumpster-cli-backup-"));
    temporaryDirectories.push(output);
    const backupExecutor = vi.fn<typeof executeProductBackup>();
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    const context = {
      environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
      backupExecutor,
    };

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
        context,
      ),
    ).resolves.toBe(7);
    await expect(
      runCli(
        [
          "backup",
          "--project-ref",
          "abcdefghijklmnopqrst",
          "--linked",
          "--output",
          output,
          "--allow-plaintext-secrets",
        ],
        io,
        context,
      ),
    ).resolves.toBe(7);
    expect(backupExecutor).not.toHaveBeenCalled();
  });
});
