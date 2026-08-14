import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBackupCheckpoint,
  describeCheckpointArtifact,
  loadBackupCheckpoint,
  transitionCheckpointStep,
  writeBackupCheckpoint,
} from "../../src/core/checkpoint/backup.js";

const temporaryDirectories: string[] = [];
const configHash = createHash("sha256").update("immutable").digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  checkpointPath: string;
  runId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-checkpoint-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".work"));
  const runId = randomUUID();
  return {
    root,
    runId,
    checkpointPath: path.join(root, ".work", "checkpoint.json"),
  };
}

describe("backup checkpoints", () => {
  it("atomically persists and revalidates completed artifact bytes", async () => {
    const { root, checkpointPath, runId } = await fixture();
    await mkdir(path.join(root, "database"));
    await writeFile(path.join(root, "database", "schema.sql"), "select 1;\n");
    const artifact = await describeCheckpointArtifact(
      root,
      "database/schema.sql",
    );
    let checkpoint = createBackupCheckpoint({
      runId,
      projectRef: "abcdefghijklmnopqrst",
      immutableConfigSha256: configHash,
      stepIds: ["database.schema"],
      now: "2026-08-14T00:00:00.000Z",
    });
    checkpoint = transitionCheckpointStep(checkpoint, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T00:00:01.000Z",
    });
    checkpoint = transitionCheckpointStep(checkpoint, {
      id: "database.schema",
      status: "completed",
      artifacts: [artifact],
      now: "2026-08-14T00:00:02.000Z",
    });
    await writeBackupCheckpoint(checkpointPath, checkpoint);
    await expect(
      loadBackupCheckpoint(checkpointPath, root, {
        runId,
        projectRef: "abcdefghijklmnopqrst",
        immutableConfigSha256: configHash,
      }),
    ).resolves.toMatchObject({ steps: [{ status: "completed", attempts: 1 }] });

    await writeFile(path.join(root, "database", "schema.sql"), "changed\n");
    await expect(
      loadBackupCheckpoint(checkpointPath, root, {
        runId,
        projectRef: "abcdefghijklmnopqrst",
        immutableConfigSha256: configHash,
      }),
    ).rejects.toMatchObject({ code: "RESUME_STATE_INVALID" });
  });

  it("rejects identity/config drift and unsafe artifact paths", async () => {
    const { root, checkpointPath, runId } = await fixture();
    const checkpoint = createBackupCheckpoint({
      runId,
      projectRef: "abcdefghijklmnopqrst",
      immutableConfigSha256: configHash,
      stepIds: ["database.schema"],
      now: "2026-08-14T00:00:00.000Z",
    });
    await writeBackupCheckpoint(checkpointPath, checkpoint);
    await expect(
      loadBackupCheckpoint(checkpointPath, root, {
        runId,
        projectRef: "abcdefghijklmnopqrst",
        immutableConfigSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "RESUME_CONFIG_MISMATCH" });
    await expect(
      describeCheckpointArtifact(root, "../escaped"),
    ).rejects.toThrow(/unsafe|traversal|dot segments/iu);
  });

  it("rejects artifacts reached through a directory link escape", async () => {
    const { root } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "pgdumpster-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.sql"), "outside\n");
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      describeCheckpointArtifact(root, "linked/secret.sql"),
    ).rejects.toMatchObject({ code: "RESUME_STATE_INVALID" });
  });

  it("never reopens a completed step", () => {
    const runId = randomUUID();
    let checkpoint = createBackupCheckpoint({
      runId,
      projectRef: "abcdefghijklmnopqrst",
      immutableConfigSha256: configHash,
      stepIds: ["database.schema"],
      now: "2026-08-14T00:00:00.000Z",
    });
    checkpoint = transitionCheckpointStep(checkpoint, {
      id: "database.schema",
      status: "completed",
      now: "2026-08-14T00:00:01.000Z",
    });
    expect(() =>
      transitionCheckpointStep(checkpoint, {
        id: "database.schema",
        status: "in_progress",
        now: "2026-08-14T00:00:02.000Z",
      }),
    ).toThrow(/cannot be reopened/u);
  });
});
