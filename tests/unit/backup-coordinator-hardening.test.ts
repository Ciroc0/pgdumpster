import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeBackup,
  type BackupStep,
} from "../../src/core/backup/coordinator.js";
import { loadBackupCheckpoint } from "../../src/core/checkpoint/backup.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

const temporaryDirectories: string[] = [];

const projectRef = "abcdefghijklmnopqrst";
const startedAt = "2026-08-14T22:00:00.000Z";
const configHash = createHash("sha256")
  .update("backup-coordinator-hardening")
  .digest("hex");

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

async function fixture(): Promise<{
  parent: string;
  workspaceRoot: string;
  checkpointPath: string;
}> {
  const parent = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-backup-coordinator-hardening-"),
  );

  temporaryDirectories.push(parent);

  const workspaceRoot = path.join(parent, "workspace");
  await mkdir(workspaceRoot);

  return {
    parent,
    workspaceRoot,
    checkpointPath: path.join(parent, "checkpoint.json"),
  };
}

function common(
  workspaceRoot: string,
  checkpointPath: string,
  steps: readonly BackupStep[],
) {
  return {
    workspaceRoot,
    checkpointPath,
    runId: randomUUID(),
    projectRef,
    immutableConfigSha256: configHash,
    toolVersion: "test",
    startedAt,
    consistency: "best-effort" as const,
    steps,
    now: () => "2026-08-14T22:00:01.000Z",
  };
}

describe("backup coordinator hardening", () => {
  it("rejects an empty backup pipeline before creating a checkpoint", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();

    await expect(
      executeBackup(common(workspaceRoot, checkpointPath, [])),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    await expect(readFile(checkpointPath)).rejects.toThrow();
  });

  it("rejects unsafe and duplicate backup step identifiers", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();

    const noop = vi.fn(() =>
      Promise.resolve({
        artifacts: [],
        coverage: [],
      }),
    );

    await expect(
      executeBackup(
        common(workspaceRoot, checkpointPath, [
          {
            id: "../unsafe",
            run: noop,
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    await expect(
      executeBackup(
        common(workspaceRoot, checkpointPath, [
          {
            id: "duplicate",
            run: noop,
          },
          {
            id: "duplicate",
            run: noop,
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    expect(noop).not.toHaveBeenCalled();
  });

  it("rejects a workspace path that is not a directory", async () => {
    const { parent, checkpointPath } = await fixture();

    const workspaceFile = path.join(parent, "workspace-file");
    await writeFile(workspaceFile, "not a directory");

    const run = vi.fn(() =>
      Promise.resolve({
        artifacts: [],
        coverage: [],
      }),
    );

    await expect(
      executeBackup(
        common(workspaceFile, checkpointPath, [
          {
            id: "step",
            run,
          },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "DESTINATION_INVALID",
    });

    expect(run).not.toHaveBeenCalled();
  });

  it("honors cancellation before touching the workspace", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();

    const controller = new AbortController();
    const reason = new Error("cancel before backup");
    controller.abort(reason);

    const run = vi.fn(() =>
      Promise.resolve({
        artifacts: [],
        coverage: [],
      }),
    );

    await expect(
      executeBackup({
        ...common(workspaceRoot, checkpointPath, [
          {
            id: "step",
            run,
          },
        ]),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(run).not.toHaveBeenCalled();
    await expect(readFile(checkpointPath)).rejects.toThrow();
  });

  it("refuses resume when the backup step order has changed", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();

    const runId = randomUUID();

    const firstRunOptions = {
      workspaceRoot,
      checkpointPath,
      runId,
      projectRef,
      immutableConfigSha256: configHash,
      toolVersion: "test",
      startedAt,
      consistency: "best-effort" as const,
      now: () => "2026-08-14T22:00:01.000Z",
    };

    const alpha: BackupStep = {
      id: "alpha",
      run: () => Promise.reject(new Error("stop after checkpoint")),
    };

    const beta: BackupStep = {
      id: "beta",
      run: () =>
        Promise.resolve({
          artifacts: [],
          coverage: [],
        }),
    };

    await expect(
      executeBackup({
        ...firstRunOptions,
        steps: [alpha, beta],
      }),
    ).rejects.toThrow("stop after checkpoint");

    await expect(
      executeBackup({
        ...firstRunOptions,
        steps: [beta, alpha],
        resume: true,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_CONFIG_MISMATCH",
    });
  });

  it("persists a PgDumpsterError failure code in the resumable checkpoint", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();

    const runId = randomUUID();

    const step: BackupStep = {
      id: "database",
      run: () =>
        Promise.reject(
          new PgDumpsterError({
            code: "DATABASE_DUMP_FAILED",
            category: "database",
            message: "fixture database failure",
            retryable: false,
          }),
        ),
    };

    await expect(
      executeBackup({
        ...common(workspaceRoot, checkpointPath, [step]),
        runId,
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_DUMP_FAILED",
    });

    const checkpoint = await loadBackupCheckpoint(
      checkpointPath,
      workspaceRoot,
      {
        runId,
        projectRef,
        immutableConfigSha256: configHash,
      },
    );

    expect(checkpoint.steps[0]).toMatchObject({
      id: "database",
      status: "failed",
      failureCode: "DATABASE_DUMP_FAILED",
    });
  });

  it("converts cancellation during a step into the stable cancellation error", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();

    const controller = new AbortController();

    const step: BackupStep = {
      id: "cancelled",
      run: () => {
        controller.abort(new Error("cancel during step"));
        return Promise.reject(new Error("upstream cancellation"));
      },
    };

    await expect(
      executeBackup({
        ...common(workspaceRoot, checkpointPath, [step]),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
      category: "cancelled",
      retryable: true,
    });
  });

  it("finalizes a complete best-effort backup and forwards the signal to steps", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const registry = await loadCoverageRegistry();
    const controller = new AbortController();

    let receivedSignal: AbortSignal | undefined;

    const step: BackupStep = {
      id: "all",
      async run(context) {
        receivedSignal = context.signal;

        await writeFile(
          path.join(context.workspaceRoot, "all.bin"),
          "complete fixture\n",
        );

        return {
          artifacts: ["all.bin"],
          coverage: registry.components.map(({ id, sensitivity }) => ({
            id,
            status: "backed_up" as const,
            sensitivity,
            artifacts: ["all.bin"],
          })),
        };
      },
    };

    const result = await executeBackup({
      ...common(workspaceRoot, checkpointPath, [step]),
      consistency: "best-effort",
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);

    expect(result.manifest.result).toEqual({
      status: "complete",
      consistency: "best_effort",
    });
  });
});
