import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeBackup,
  type BackupStep,
  type BackupStepResult,
  type ExecuteBackupOptions,
} from "../../src/core/backup/coordinator.js";
import { loadBackupCheckpoint } from "../../src/core/checkpoint/backup.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

const temporaryDirectories: string[] = [];
const projectRef = "abcdefghijklmnopqrst";
const startedAt = "2026-08-15T00:00:00.000Z";
const configHash = createHash("sha256")
  .update("backup-coordinator-consistency")
  .digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  workspaceRoot: string;
  checkpointPath: string;
}> {
  const parent = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-coordinator-consistency-"),
  );
  temporaryDirectories.push(parent);
  const workspaceRoot = path.join(parent, "workspace");
  await mkdir(workspaceRoot);
  return {
    workspaceRoot,
    checkpointPath: path.join(parent, "checkpoint.json"),
  };
}

async function completeResult(
  workspaceRoot: string,
  filename: string,
): Promise<BackupStepResult> {
  const registry = await loadCoverageRegistry();
  await writeFile(path.join(workspaceRoot, filename), `${filename}\n`);
  return {
    artifacts: [filename],
    coverage: registry.components.map(({ id, sensitivity }) => ({
      id,
      status: "backed_up" as const,
      sensitivity,
      artifacts: [filename],
    })),
  };
}

function options(
  workspaceRoot: string,
  checkpointPath: string,
  step: BackupStep,
  consistency: ExecuteBackupOptions["consistency"],
): ExecuteBackupOptions {
  return {
    workspaceRoot,
    checkpointPath,
    runId: randomUUID(),
    projectRef,
    immutableConfigSha256: configHash,
    toolVersion: "test",
    startedAt,
    consistency,
    steps: [step],
    now: () => "2026-08-15T00:00:01.000Z",
  };
}

function noPartialCleanup(): Promise<void> {
  return Promise.resolve();
}

describe("backup coordinator consistency integration", () => {
  it.each(["verified", "quiesced"] as const)(
    "fails closed before checkpoint creation when %s lacks an adapter",
    async (mode) => {
      const { workspaceRoot, checkpointPath } = await fixture();
      const run = vi.fn(() => completeResult(workspaceRoot, "payload.bin"));

      await expect(
        executeBackup(
          options(workspaceRoot, checkpointPath, { id: "all", run }, mode),
        ),
      ).rejects.toMatchObject({
        code: "CONSISTENCY_ADAPTER_REQUIRED",
        category: "consistency",
        details: { mode, steps: ["all"] },
      });

      expect(run).not.toHaveBeenCalled();
      await expect(readFile(checkpointPath)).rejects.toThrow();
    },
  );

  it.each(["verified", "quiesced"] as const)(
    "fails closed before checkpoint creation when %s lacks partial cleanup",
    async (mode) => {
      const { workspaceRoot, checkpointPath } = await fixture();
      const run = vi.fn(() => completeResult(workspaceRoot, "payload.bin"));

      await expect(
        executeBackup(
          options(
            workspaceRoot,
            checkpointPath,
            {
              id: "all",
              run,
              consistency: {
                snapshot: () => Promise.resolve({ revision: 1 }),
                cleanup: () => Promise.resolve(),
              },
            },
            mode,
          ),
        ),
      ).rejects.toMatchObject({
        code: "CONSISTENCY_PARTIAL_CLEANUP_REQUIRED",
        category: "consistency",
        details: { mode, steps: ["all"] },
      });

      expect(run).not.toHaveBeenCalled();
      await expect(readFile(checkpointPath)).rejects.toThrow();
    },
  );

  it("finalizes verified only after a stable pre/post snapshot", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const snapshot = vi.fn(() => Promise.resolve({ revision: 1 }));
    const cleanup = vi.fn(() => Promise.resolve());
    const cleanupPartial = vi.fn(noPartialCleanup);
    const run = vi.fn(() => completeResult(workspaceRoot, "stable.bin"));

    const completed = await executeBackup(
      options(
        workspaceRoot,
        checkpointPath,
        {
          id: "all",
          run,
          consistency: { snapshot, cleanup, cleanupPartial },
        },
        "verified",
      ),
    );

    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(cleanupPartial).not.toHaveBeenCalled();
    expect(completed.manifest.result.consistency).toBe("verified");
  });

  it("retries only the affected verified step after drift and cleans its provisional result", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const snapshots = [
      { revision: 1 },
      { revision: 2 },
      { revision: 2 },
      { revision: 2 },
    ];
    const attempts: number[] = [];
    const cleaned: string[] = [];

    const step: BackupStep = {
      id: "all",
      run: async ({ attempt }) => {
        attempts.push(attempt);
        return completeResult(workspaceRoot, `payload-${attempt}.bin`);
      },
      consistency: {
        snapshot: () => Promise.resolve(snapshots.shift()!),
        cleanup: async (result) => {
          cleaned.push(...result.artifacts);
          await Promise.all(
            result.artifacts.map((artifact) =>
              rm(path.join(workspaceRoot, artifact), { force: true }),
            ),
          );
        },
        cleanupPartial: noPartialCleanup,
      },
    };

    const completed = await executeBackup(
      options(workspaceRoot, checkpointPath, step, "verified"),
    );

    expect(attempts).toEqual([1, 2]);
    expect(cleaned).toEqual(["payload-1.bin"]);
    expect(completed.manifest.result.consistency).toBe("verified");
  });

  it("retries recognized copy-time drift after partial cleanup", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const attempts: number[] = [];
    const cleanupPartial = vi.fn(async () => {
      await rm(path.join(workspaceRoot, "partial.bin"), { force: true });
    });

    const step: BackupStep = {
      id: "all",
      async run({ attempt }) {
        attempts.push(attempt);
        if (attempt === 1) {
          await writeFile(path.join(workspaceRoot, "partial.bin"), "partial\n");
          throw new PgDumpsterError({
            code: "STORAGE_OBJECT_CHANGED_DURING_COPY",
            category: "consistency",
            message: "object changed",
            retryable: false,
          });
        }
        return completeResult(workspaceRoot, "stable.bin");
      },
      consistency: {
        snapshot: () => Promise.resolve({ revision: 1 }),
        cleanup: () => Promise.resolve(),
        cleanupPartial,
      },
    };

    const completed = await executeBackup(
      options(workspaceRoot, checkpointPath, step, "verified"),
    );

    expect(attempts).toEqual([1, 2]);
    expect(cleanupPartial).toHaveBeenCalledOnce();
    expect(completed.manifest.result.consistency).toBe("verified");
    await expect(
      readFile(path.join(workspaceRoot, "partial.bin")),
    ).rejects.toThrow();
  });

  it("cleans partial artifacts after an ordinary copy failure so resume can rerun", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const runId = randomUUID();
    let shouldFail = true;
    let runs = 0;
    const cleanupPartial = vi.fn(async () => {
      await rm(path.join(workspaceRoot, "partial.bin"), { force: true });
    });
    const step: BackupStep = {
      id: "all",
      async run() {
        runs += 1;
        if (shouldFail) {
          await writeFile(path.join(workspaceRoot, "partial.bin"), "partial\n");
          throw new Error("interrupted copy");
        }
        return completeResult(workspaceRoot, "complete.bin");
      },
      consistency: {
        snapshot: () => Promise.resolve({ revision: 1 }),
        cleanup: () => Promise.resolve(),
        cleanupPartial,
      },
    };
    const common = {
      ...options(workspaceRoot, checkpointPath, step, "verified"),
      runId,
    };

    await expect(executeBackup(common)).rejects.toThrow("interrupted copy");
    expect(cleanupPartial).toHaveBeenCalledOnce();
    await expect(
      readFile(path.join(workspaceRoot, "partial.bin")),
    ).rejects.toThrow();

    shouldFail = false;
    const completed = await executeBackup({ ...common, resume: true });
    expect(runs).toBe(2);
    expect(completed.manifest.result.consistency).toBe("verified");
  });

  it("fails quiesced immediately after observable drift and records the stable failure code", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const runId = randomUUID();
    const cleanup = vi.fn(async (result: BackupStepResult) => {
      await Promise.all(
        result.artifacts.map((artifact) =>
          rm(path.join(workspaceRoot, artifact), { force: true }),
        ),
      );
    });
    const snapshots = [{ revision: 1 }, { revision: 2 }];

    const runOptions = {
      ...options(
        workspaceRoot,
        checkpointPath,
        {
          id: "all",
          run: () => completeResult(workspaceRoot, "quiesced.bin"),
          consistency: {
            snapshot: () => Promise.resolve(snapshots.shift()!),
            cleanup,
            cleanupPartial: noPartialCleanup,
          },
        },
        "quiesced",
      ),
      runId,
    };

    await expect(executeBackup(runOptions)).rejects.toMatchObject({
      code: "QUIESCED_SOURCE_CHANGED",
    });
    expect(cleanup).toHaveBeenCalledOnce();

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
      status: "failed",
      failureCode: "QUIESCED_SOURCE_CHANGED",
    });
  });

  it("observes best-effort drift without retrying or cleaning the completed copy", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const snapshots = [{ revision: 1 }, { revision: 2 }];
    const cleanup = vi.fn(() => Promise.resolve());
    const run = vi.fn(() => completeResult(workspaceRoot, "best-effort.bin"));

    const completed = await executeBackup(
      options(
        workspaceRoot,
        checkpointPath,
        {
          id: "all",
          run,
          consistency: {
            snapshot: () => Promise.resolve(snapshots.shift()!),
            cleanup,
          },
        },
        "best-effort",
      ),
    );

    expect(run).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(completed.manifest.result.consistency).toBe("drift_detected");
  });

  it("applies the coordinator retry bound and persists SOURCE_DID_NOT_STABILIZE", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const runId = randomUUID();
    let revision = 0;
    const cleanup = vi.fn(async (result: BackupStepResult) => {
      await Promise.all(
        result.artifacts.map((artifact) =>
          rm(path.join(workspaceRoot, artifact), { force: true }),
        ),
      );
    });

    const runOptions: ExecuteBackupOptions = {
      ...options(
        workspaceRoot,
        checkpointPath,
        {
          id: "all",
          run: ({ attempt }) =>
            completeResult(workspaceRoot, `unstable-${attempt}.bin`),
          consistency: {
            snapshot: () => Promise.resolve({ revision: (revision += 1) }),
            cleanup,
            cleanupPartial: noPartialCleanup,
          },
        },
        "verified",
      ),
      runId,
      maxConsistencyRetries: 1,
    };

    await expect(executeBackup(runOptions)).rejects.toMatchObject({
      code: "SOURCE_DID_NOT_STABILIZE",
      details: { attempts: 2, maxRetries: 1 },
    });
    expect(cleanup).toHaveBeenCalledTimes(2);

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
      status: "failed",
      failureCode: "SOURCE_DID_NOT_STABILIZE",
    });
  });
});
