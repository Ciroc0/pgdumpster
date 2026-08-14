import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  backupCheckpointSchema,
  createBackupCheckpoint,
  describeCheckpointArtifact,
  loadBackupCheckpoint,
  transitionCheckpointStep,
  writeBackupCheckpoint,
} from "../../src/core/checkpoint/backup.js";

const temporaryDirectories: string[] = [];

const projectRef = "abcdefghijklmnopqrst";
const configHash = createHash("sha256")
  .update("checkpoint-hardening")
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
  root: string;
  checkpointPath: string;
  runId: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-checkpoint-hardening-"),
  );

  temporaryDirectories.push(root);

  return {
    root,
    checkpointPath: path.join(root, "checkpoint.json"),
    runId: randomUUID(),
  };
}

function checkpoint(runId: string = randomUUID()) {
  return createBackupCheckpoint({
    runId,
    projectRef,
    immutableConfigSha256: configHash,
    stepIds: ["database.schema"],
    now: "2026-08-14T20:00:00.000Z",
  });
}

describe("backup checkpoint hardening", () => {
  it("requires at least one unique safe checkpoint step", () => {
    expect(() =>
      createBackupCheckpoint({
        runId: randomUUID(),
        projectRef,
        immutableConfigSha256: configHash,
        stepIds: [],
        now: "2026-08-14T20:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      createBackupCheckpoint({
        runId: randomUUID(),
        projectRef,
        immutableConfigSha256: configHash,
        stepIds: ["same", "same"],
        now: "2026-08-14T20:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      createBackupCheckpoint({
        runId: randomUUID(),
        projectRef,
        immutableConfigSha256: configHash,
        stepIds: ["../unsafe"],
        now: "2026-08-14T20:00:00.000Z",
      }),
    ).toThrow();
  });

  it("enforces failure-code state invariants directly in the schema", () => {
    const base = checkpoint();

    expect(
      backupCheckpointSchema.safeParse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            status: "failed",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      backupCheckpointSchema.safeParse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            failureCode: "INVALID",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate and unsafe checkpoint artifact paths", () => {
    const base = checkpoint();
    const artifact = {
      path: "database/schema.sql",
      sha256: "a".repeat(64),
      bytes: 1,
    };

    expect(
      backupCheckpointSchema.safeParse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            artifacts: [artifact, artifact],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      backupCheckpointSchema.safeParse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            artifacts: [
              {
                ...artifact,
                path: "../escape.sql",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects transitions for unknown checkpoint steps", () => {
    expect(() =>
      transitionCheckpointStep(checkpoint(), {
        id: "unknown",
        status: "in_progress",
        now: "2026-08-14T20:00:01.000Z",
      }),
    ).toThrow("Unknown checkpoint step");
  });

  it("increments attempts only when entering in-progress", () => {
    let current = checkpoint();

    current = transitionCheckpointStep(current, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T20:00:01.000Z",
    });

    expect(current.steps[0]?.attempts).toBe(1);

    current = transitionCheckpointStep(current, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T20:00:02.000Z",
    });

    expect(current.steps[0]?.attempts).toBe(1);

    current = transitionCheckpointStep(current, {
      id: "database.schema",
      status: "failed",
      failureCode: "DATABASE_DUMP_FAILED",
      now: "2026-08-14T20:00:03.000Z",
    });

    current = transitionCheckpointStep(current, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T20:00:04.000Z",
    });

    expect(current.steps[0]?.attempts).toBe(2);
  });

  it("never reopens a completed checkpoint step", () => {
    const completed = transitionCheckpointStep(checkpoint(), {
      id: "database.schema",
      status: "completed",
      now: "2026-08-14T20:00:01.000Z",
    });

    expect(() =>
      transitionCheckpointStep(completed, {
        id: "database.schema",
        status: "failed",
        failureCode: "INVALID",
        now: "2026-08-14T20:00:02.000Z",
      }),
    ).toThrow("cannot be reopened");
  });

  it("rejects a checkpoint workspace that is not a directory", async () => {
    const { root } = await fixture();
    const file = path.join(root, "workspace-file");

    await writeFile(file, "file");

    await expect(
      describeCheckpointArtifact(file, "artifact.sql"),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });
  });

  it("rejects checkpoint artifacts that are not regular files", async () => {
    const { root } = await fixture();

    await mkdir(path.join(root, "artifact.sql"));

    await expect(
      describeCheckpointArtifact(root, "artifact.sql"),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });
  });

  it("honors cancellation while describing an artifact", async () => {
    const { root } = await fixture();

    await writeFile(path.join(root, "artifact.sql"), "select 1;\n");

    const controller = new AbortController();
    const reason = new Error("cancel checkpoint hash");

    controller.abort(reason);

    await expect(
      describeCheckpointArtifact(root, "artifact.sql", controller.signal),
    ).rejects.toBe(reason);
  });

  it("rejects non-file, oversized and malformed checkpoint state", async () => {
    const first = await fixture();

    await mkdir(first.checkpointPath);

    await expect(
      loadBackupCheckpoint(first.checkpointPath, first.root, {
        runId: first.runId,
        projectRef,
        immutableConfigSha256: configHash,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });

    const second = await fixture();

    await writeFile(second.checkpointPath, "x".repeat(1_048_577));

    await expect(
      loadBackupCheckpoint(second.checkpointPath, second.root, {
        runId: second.runId,
        projectRef,
        immutableConfigSha256: configHash,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });

    const third = await fixture();

    await writeFile(third.checkpointPath, "{broken");

    await expect(
      loadBackupCheckpoint(third.checkpointPath, third.root, {
        runId: third.runId,
        projectRef,
        immutableConfigSha256: configHash,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });
  });

  it("rejects run, project and immutable-config drift", async () => {
    const { root, checkpointPath, runId } = await fixture();

    await writeBackupCheckpoint(checkpointPath, checkpoint(runId));

    await expect(
      loadBackupCheckpoint(checkpointPath, root, {
        runId: randomUUID(),
        projectRef,
        immutableConfigSha256: configHash,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });

    await expect(
      loadBackupCheckpoint(checkpointPath, root, {
        runId,
        projectRef: "zzzzzzzzzzzzzzzzzzzz",
        immutableConfigSha256: configHash,
      }),
    ).rejects.toMatchObject({
      code: "RESUME_STATE_INVALID",
    });

    await expect(
      loadBackupCheckpoint(checkpointPath, root, {
        runId,
        projectRef,
        immutableConfigSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "RESUME_CONFIG_MISMATCH",
    });
  });
});
