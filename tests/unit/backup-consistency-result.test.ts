import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeBackup,
  type BackupStep,
} from "../../src/core/backup/coordinator.js";
import {
  backupCheckpointSchema,
  loadBackupCheckpoint,
} from "../../src/core/checkpoint/backup.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";

const temporaryDirectories: string[] = [];
const configHash = createHash("sha256")
  .update("consistency-result-config")
  .digest("hex");
const projectRef = "abcdefghijklmnopqrst";
const startedAt = "2026-08-15T00:00:00.000Z";

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
    path.join(tmpdir(), "pgdumpster-consistency-result-"),
  );
  temporaryDirectories.push(parent);
  const workspaceRoot = path.join(parent, "workspace");
  await mkdir(workspaceRoot);
  return {
    workspaceRoot,
    checkpointPath: path.join(parent, "checkpoint.json"),
  };
}

describe("backup consistency result", () => {
  it("marks a completed best-effort backup as drift_detected", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const registry = await loadCoverageRegistry();
    let snapshotCalls = 0;
    const step: BackupStep = {
      id: "all-components",
      consistency: {
        snapshot: () => Promise.resolve({ revision: ++snapshotCalls }),
        cleanup: () => Promise.resolve(),
      },
      async run({ workspaceRoot: root }) {
        await writeFile(path.join(root, "payload.bin"), "payload\n");
        return {
          artifacts: ["payload.bin"],
          coverage: registry.components.map(({ id, sensitivity }) => ({
            id,
            status: "backed_up" as const,
            sensitivity,
            artifacts: ["payload.bin"],
          })),
        };
      },
    };
    const runId = randomUUID();

    const result = await executeBackup({
      workspaceRoot,
      checkpointPath,
      runId,
      projectRef,
      immutableConfigSha256: configHash,
      toolVersion: "test",
      startedAt,
      consistency: "best-effort",
      steps: [step],
      now: () => "2026-08-15T00:00:01.000Z",
    });

    expect(result.manifest.result.consistency).toBe("drift_detected");
    const checkpoint = await loadBackupCheckpoint(
      checkpointPath,
      workspaceRoot,
      { runId, projectRef, immutableConfigSha256: configHash },
    );
    expect(checkpoint.steps[0]?.consistencyDriftDetected).toBe(true);
  });

  it("preserves observed best-effort drift across interruption and resume", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const registry = await loadCoverageRegistry();
    const split = Math.floor(registry.components.length / 2);
    const runId = randomUUID();
    let firstRuns = 0;
    let secondRuns = 0;
    let firstSnapshotCalls = 0;
    let interruptSecond = true;

    const first: BackupStep = {
      id: "first",
      consistency: {
        snapshot: () => Promise.resolve({ revision: ++firstSnapshotCalls }),
        cleanup: () => Promise.resolve(),
      },
      async run({ workspaceRoot: root }) {
        firstRuns += 1;
        await writeFile(path.join(root, "first.bin"), "first\n");
        return {
          artifacts: ["first.bin"],
          coverage: registry.components
            .slice(0, split)
            .map(({ id, sensitivity }) => ({
              id,
              status: "backed_up" as const,
              sensitivity,
              artifacts: ["first.bin"],
            })),
        };
      },
    };
    const second: BackupStep = {
      id: "second",
      consistency: {
        snapshot: () => Promise.resolve({ revision: 1 }),
        cleanup: () => Promise.resolve(),
      },
      async run({ workspaceRoot: root }) {
        secondRuns += 1;
        if (interruptSecond) throw new Error("simulated interruption");
        await writeFile(path.join(root, "second.bin"), "second\n");
        return {
          artifacts: ["second.bin"],
          coverage: registry.components
            .slice(split)
            .map(({ id, sensitivity }) => ({
              id,
              status: "backed_up" as const,
              sensitivity,
              artifacts: ["second.bin"],
            })),
        };
      },
    };
    const common = {
      workspaceRoot,
      checkpointPath,
      runId,
      projectRef,
      immutableConfigSha256: configHash,
      toolVersion: "test",
      startedAt,
      consistency: "best-effort" as const,
      steps: [first, second],
      now: () => "2026-08-15T00:00:01.000Z",
    };

    await expect(executeBackup(common)).rejects.toThrow(
      "simulated interruption",
    );
    const interrupted = await loadBackupCheckpoint(
      checkpointPath,
      workspaceRoot,
      { runId, projectRef, immutableConfigSha256: configHash },
    );
    expect(interrupted.steps[0]?.consistencyDriftDetected).toBe(true);
    expect(interrupted.steps.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
    ]);

    interruptSecond = false;
    const result = await executeBackup({ ...common, resume: true });

    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(2);
    expect(result.manifest.result.consistency).toBe("drift_detected");
  });

  it("parses pre-drift-field schema-version-1 checkpoints as no drift", () => {
    const parsed = backupCheckpointSchema.parse({
      schemaVersion: 1,
      runId: randomUUID(),
      projectRef,
      immutableConfigSha256: configHash,
      createdAt: startedAt,
      updatedAt: startedAt,
      steps: [
        {
          id: "database",
          status: "pending",
          attempts: 0,
          artifacts: [],
          coverage: [],
        },
      ],
    });

    expect(parsed.steps[0]?.consistencyDriftDetected).toBe(false);
  });
});
