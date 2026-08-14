import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRestoreCheckpoint,
  loadRestoreCheckpoint,
  restoreCheckpointSchema,
  transitionRestoreAction,
  writeRestoreCheckpoint,
} from "../../src/core/checkpoint/restore.js";

const temporaryDirectories: string[] = [];

const planSha256 = "a".repeat(64);
const sourceProjectRef = "abcdefghijklmnopqrst";
const targetProjectRef = "qrstabcdefghijklmnop";

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
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-restore-checkpoint-hardening-"),
  );

  temporaryDirectories.push(root);

  return {
    root,
    checkpointPath: path.join(root, "restore-checkpoint.json"),
  };
}

function create() {
  return createRestoreCheckpoint({
    planId: randomUUID(),
    planSha256,
    backupOperationId: randomUUID(),
    sourceProjectRef,
    targetProjectRef,
    actions: [
      {
        id: "database.schema",
        planned: true,
      },
      {
        id: "storage.vector",
        planned: false,
      },
    ],
    now: "2026-08-14T21:00:00.000Z",
  });
}

describe("restore checkpoint hardening", () => {
  it("maps planned and unplanned actions to pending and skipped", () => {
    expect(create().actions.map(({ status }) => status)).toEqual([
      "pending",
      "skipped",
    ]);
  });

  it("requires at least one unique action", () => {
    expect(() =>
      createRestoreCheckpoint({
        planId: randomUUID(),
        planSha256,
        backupOperationId: randomUUID(),
        sourceProjectRef,
        targetProjectRef,
        actions: [],
        now: "2026-08-14T21:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      createRestoreCheckpoint({
        planId: randomUUID(),
        planSha256,
        backupOperationId: randomUUID(),
        sourceProjectRef,
        targetProjectRef,
        actions: [
          {
            id: "same",
            planned: true,
          },
          {
            id: "same",
            planned: true,
          },
        ],
        now: "2026-08-14T21:00:00.000Z",
      }),
    ).toThrow();
  });

  it("enforces failureCode and fingerprint schema invariants", () => {
    const base = create();

    expect(
      restoreCheckpointSchema.safeParse({
        ...base,
        actions: [
          {
            ...base.actions[0]!,
            status: "failed",
          },
          base.actions[1]!,
        ],
      }).success,
    ).toBe(false);

    expect(
      restoreCheckpointSchema.safeParse({
        ...base,
        actions: [
          {
            ...base.actions[0]!,
            failureCode: "INVALID",
          },
          base.actions[1]!,
        ],
      }).success,
    ).toBe(false);

    expect(
      restoreCheckpointSchema.safeParse({
        ...base,
        actions: [
          {
            ...base.actions[0]!,
            fingerprint: "b".repeat(64),
          },
          base.actions[1]!,
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown restore checkpoint actions", () => {
    expect(() =>
      transitionRestoreAction(create(), {
        id: "unknown",
        status: "in_progress",
        now: "2026-08-14T21:00:01.000Z",
      }),
    ).toThrow("Unknown restore checkpoint action");
  });

  it("increments attempts only when entering in-progress", () => {
    let checkpoint = create();

    checkpoint = transitionRestoreAction(checkpoint, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T21:00:01.000Z",
    });

    expect(checkpoint.actions[0]?.attempts).toBe(1);

    checkpoint = transitionRestoreAction(checkpoint, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T21:00:02.000Z",
    });

    expect(checkpoint.actions[0]?.attempts).toBe(1);

    checkpoint = transitionRestoreAction(checkpoint, {
      id: "database.schema",
      status: "failed",
      failureCode: "RESTORE_FAILED",
      now: "2026-08-14T21:00:03.000Z",
    });

    checkpoint = transitionRestoreAction(checkpoint, {
      id: "database.schema",
      status: "in_progress",
      now: "2026-08-14T21:00:04.000Z",
    });

    expect(checkpoint.actions[0]?.attempts).toBe(2);
  });

  it("records completion time with and without fingerprints", () => {
    const withoutFingerprint = transitionRestoreAction(create(), {
      id: "database.schema",
      status: "completed",
      now: "2026-08-14T21:00:05.000Z",
    });

    expect(withoutFingerprint.actions[0]).toMatchObject({
      status: "completed",
      completedAt: "2026-08-14T21:00:05.000Z",
    });

    expect(withoutFingerprint.actions[0]?.fingerprint).toBeUndefined();

    const fingerprint = "b".repeat(64);

    const withFingerprint = transitionRestoreAction(create(), {
      id: "database.schema",
      status: "completed",
      fingerprint,
      now: "2026-08-14T21:00:06.000Z",
    });

    expect(withFingerprint.actions[0]).toMatchObject({
      fingerprint,
      completedAt: "2026-08-14T21:00:06.000Z",
    });
  });

  it("never reopens a completed restore action", () => {
    const completed = transitionRestoreAction(create(), {
      id: "database.schema",
      status: "completed",
      now: "2026-08-14T21:00:01.000Z",
    });

    expect(() =>
      transitionRestoreAction(completed, {
        id: "database.schema",
        status: "in_progress",
        now: "2026-08-14T21:00:02.000Z",
      }),
    ).toThrow("cannot be reopened");
  });

  it("round-trips a valid restore checkpoint", async () => {
    const { checkpointPath } = await fixture();

    const checkpoint = create();

    await writeRestoreCheckpoint(checkpointPath, checkpoint);

    await expect(
      loadRestoreCheckpoint(checkpointPath, {
        planId: checkpoint.planId,
        planSha256: checkpoint.planSha256,
        backupOperationId: checkpoint.backupOperationId,
        sourceProjectRef: checkpoint.sourceProjectRef,
        targetProjectRef: checkpoint.targetProjectRef,
        actionIds: checkpoint.actions.map(({ id }) => id),
      }),
    ).resolves.toEqual(checkpoint);
  });

  it("wraps missing, malformed and oversized restore checkpoints", async () => {
    const checkpoint = create();

    const expected = {
      planId: checkpoint.planId,
      planSha256: checkpoint.planSha256,
      backupOperationId: checkpoint.backupOperationId,
      sourceProjectRef: checkpoint.sourceProjectRef,
      targetProjectRef: checkpoint.targetProjectRef,
      actionIds: checkpoint.actions.map(({ id }) => id),
    };

    const first = await fixture();

    await expect(
      loadRestoreCheckpoint(first.checkpointPath, expected),
    ).rejects.toMatchObject({
      code: "RESTORE_CHECKPOINT_INVALID",
    });

    const second = await fixture();

    await writeFile(second.checkpointPath, "{broken");

    await expect(
      loadRestoreCheckpoint(second.checkpointPath, expected),
    ).rejects.toMatchObject({
      code: "RESTORE_CHECKPOINT_INVALID",
    });

    const third = await fixture();

    await writeFile(third.checkpointPath, "x".repeat(4_194_305));

    await expect(
      loadRestoreCheckpoint(third.checkpointPath, expected),
    ).rejects.toMatchObject({
      code: "RESTORE_CHECKPOINT_INVALID",
    });
  });

  it("rejects immutable restore checkpoint drift", async () => {
    const { checkpointPath } = await fixture();

    const checkpoint = create();

    await writeRestoreCheckpoint(checkpointPath, checkpoint);

    const expected = {
      planId: checkpoint.planId,
      planSha256: checkpoint.planSha256,
      backupOperationId: checkpoint.backupOperationId,
      sourceProjectRef: checkpoint.sourceProjectRef,
      targetProjectRef: checkpoint.targetProjectRef,
      actionIds: checkpoint.actions.map(({ id }) => id),
    };

    await expect(
      loadRestoreCheckpoint(checkpointPath, {
        ...expected,
        planSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_CHECKPOINT_MISMATCH",
    });

    await expect(
      loadRestoreCheckpoint(checkpointPath, {
        ...expected,
        actionIds: [...expected.actionIds].reverse(),
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_CHECKPOINT_MISMATCH",
    });
  });
});
