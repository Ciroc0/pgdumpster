import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeBackup,
  type BackupStep,
} from "../../src/core/backup/coordinator.js";
import { loadBackupCheckpoint } from "../../src/core/checkpoint/backup.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";

const temporaryDirectories: string[] = [];
const configHash = createHash("sha256")
  .update("coordinator-config")
  .digest("hex");
const projectRef = "abcdefghijklmnopqrst";
const startedAt = "2026-08-14T01:00:00.000Z";

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
  workspaceRoot: string;
  checkpointPath: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-coordinator-"));
  temporaryDirectories.push(parent);
  const workspaceRoot = path.join(parent, "pgdumpster-2026-08-14T010000.000Z");
  await mkdir(workspaceRoot);
  return {
    workspaceRoot,
    checkpointPath: path.join(parent, "checkpoint.json"),
  };
}

describe("backup coordinator", () => {
  it("resumes after interruption without rerunning a completed step", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const registry = await loadCoverageRegistry();
    const split = Math.floor(registry.components.length / 2);
    const runId = randomUUID();
    let firstRuns = 0;
    let secondRuns = 0;
    let interruptSecond = true;

    const step = (
      id: string,
      filename: string,
      components: typeof registry.components,
      runCounter: () => void,
      shouldInterrupt: () => boolean,
    ): BackupStep => ({
      id,
      consistency: {
        snapshot: () => Promise.resolve({ revision: 1 }),
        cleanup: () => Promise.resolve(),
        cleanupPartial: async ({ workspaceRoot: root }) => {
          await rm(path.join(root, filename), { force: true });
        },
      },
      async run({ workspaceRoot: root }) {
        runCounter();
        if (shouldInterrupt()) throw new Error("simulated interruption");
        await writeFile(path.join(root, filename), `${id}\n`);
        return {
          artifacts: [filename],
          coverage: components.map(({ id: componentId, sensitivity }) => ({
            id: componentId,
            status: "backed_up" as const,
            sensitivity,
            artifacts: [filename],
          })),
        };
      },
    });
    const steps = [
      step(
        "first",
        "first.bin",
        registry.components.slice(0, split),
        () => {
          firstRuns += 1;
        },
        () => false,
      ),
      step(
        "second",
        "second.bin",
        registry.components.slice(split),
        () => {
          secondRuns += 1;
        },
        () => interruptSecond,
      ),
    ];
    const common = {
      workspaceRoot,
      checkpointPath,
      runId,
      projectRef,
      immutableConfigSha256: configHash,
      toolVersion: "test",
      startedAt,
      consistency: "verified" as const,
      steps,
      now: () => "2026-08-14T01:00:01.000Z",
    };

    await expect(executeBackup(common)).rejects.toThrow(
      "simulated interruption",
    );
    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(1);
    await expect(
      readFile(path.join(workspaceRoot, "manifest.json")),
    ).rejects.toThrow();
    const interrupted = await loadBackupCheckpoint(
      checkpointPath,
      workspaceRoot,
      {
        runId,
        projectRef,
        immutableConfigSha256: configHash,
      },
    );
    expect(interrupted.steps.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
    ]);

    interruptSecond = false;
    const result = await executeBackup({ ...common, resume: true });
    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(2);
    expect(result.manifest.result).toEqual({
      status: "complete",
      consistency: "verified",
    });
    expect(result.coverage.components).toHaveLength(registry.components.length);
  });

  it("refuses to finalize when any registered component is unclassified", async () => {
    const { workspaceRoot, checkpointPath } = await fixture();
    const registry = await loadCoverageRegistry();
    const runId = randomUUID();
    const incomplete: BackupStep = {
      id: "incomplete",
      async run({ workspaceRoot: root }) {
        await writeFile(path.join(root, "partial.bin"), "partial\n");
        const component = registry.components[0]!;
        return {
          artifacts: ["partial.bin"],
          coverage: [
            {
              id: component.id,
              status: "backed_up",
              sensitivity: component.sensitivity,
              artifacts: ["partial.bin"],
            },
          ],
        };
      },
    };

    await expect(
      executeBackup({
        workspaceRoot,
        checkpointPath,
        runId,
        projectRef,
        immutableConfigSha256: configHash,
        toolVersion: "test",
        startedAt,
        consistency: "best-effort",
        steps: [incomplete],
      }),
    ).rejects.toThrow(/Missing coverage outcomes/u);
    await expect(
      readFile(path.join(workspaceRoot, "manifest.json")),
    ).rejects.toThrow();
  });
});
