import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeBackup,
  type BackupStep,
} from "../../src/core/backup/coordinator.js";
import {
  createBackupCheckpoint,
  transitionCheckpointStep,
  writeBackupCheckpoint,
} from "../../src/core/checkpoint/backup.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";

const temporaryDirectories: string[] = [];
const projectRef = "abcdefghijklmnopqrst";
const startedAt = "2026-08-15T00:00:00.000Z";
const configHash = createHash("sha256")
  .update("hard-interruption-resume")
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
  const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-hard-resume-"));
  temporaryDirectories.push(parent);
  const workspaceRoot = path.join(parent, "workspace");
  await mkdir(workspaceRoot);
  return {
    workspaceRoot,
    checkpointPath: path.join(parent, "checkpoint.json"),
  };
}

describe("backup resume partial cleanup", () => {
  it("removes artifacts left by a hard interruption before rerunning an in-progress step", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const registry = await loadCoverageRegistry();
    const runId = randomUUID();
    const staleArtifact = path.join(workspaceRoot, "partial.bin");
    await writeFile(staleArtifact, "stale partial\n");

    let checkpoint = createBackupCheckpoint({
      runId,
      projectRef,
      immutableConfigSha256: configHash,
      stepIds: ["all"],
      now: startedAt,
    });
    checkpoint = transitionCheckpointStep(checkpoint, {
      id: "all",
      status: "in_progress",
      now: "2026-08-15T00:00:01.000Z",
    });
    await writeBackupCheckpoint(checkpointPath, checkpoint);

    const cleanupPartial = vi.fn(async () => {
      await rm(staleArtifact, { force: true });
    });
    const step: BackupStep = {
      id: "all",
      consistency: {
        snapshot: () => Promise.resolve({ revision: 1 }),
        cleanup: () => Promise.resolve(),
        cleanupPartial,
      },
      async run({ workspaceRoot: root }) {
        await expect(access(staleArtifact)).rejects.toThrow();
        await writeFile(path.join(root, "complete.bin"), "complete\n");
        return {
          artifacts: ["complete.bin"],
          coverage: registry.components.map(({ id, sensitivity }) => ({
            id,
            status: "backed_up" as const,
            sensitivity,
            artifacts: ["complete.bin"],
          })),
        };
      },
    };

    const result = await executeBackup({
      workspaceRoot,
      checkpointPath,
      runId,
      projectRef,
      immutableConfigSha256: configHash,
      toolVersion: "test",
      startedAt,
      consistency: "verified",
      steps: [step],
      resume: true,
      now: () => "2026-08-15T00:00:02.000Z",
    });

    expect(cleanupPartial).toHaveBeenCalledOnce();
    expect(result.manifest.result.consistency).toBe("verified");
  });
});