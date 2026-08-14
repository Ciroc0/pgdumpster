import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeRestore,
  type RestoreActionHandler,
} from "../../src/core/restore/executor.js";
import {
  restorePlanSchema,
  type RestorePlan,
} from "../../src/core/restore/plan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function plan(): RestorePlan {
  return restorePlanSchema.parse({
    schemaVersion: 1,
    planId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-14T02:00:00.000Z",
    source: {
      projectRef: "abcdefghijklmnopqrst",
      backupOperationId: "11111111-1111-4111-8111-111111111111",
      backupResult: "complete",
    },
    target: { projectRef: "zyxwvutsrqponmlkjihg" },
    conflictPolicy: "fail",
    allowBillableResources: false,
    status: "ready",
    actions: [
      {
        id: "restore.database.extensions",
        component: "database.extensions",
        phase: 2,
        operation: "apply_logical_database_state",
        risk: "mutation",
        billable: false,
        dependsOn: [],
        status: "planned",
        sourceStatus: "backed_up",
        restorePolicy: "restore",
        fidelity: "semantic",
        artifacts: ["payload/database/extensions.sql"],
      },
      {
        id: "restore.database.roles",
        component: "database.roles",
        phase: 4,
        operation: "apply_logical_database_state",
        risk: "mutation",
        billable: false,
        dependsOn: ["restore.database.extensions"],
        status: "planned",
        sourceStatus: "backed_up",
        restorePolicy: "restore",
        fidelity: "semantic",
        artifacts: ["payload/database/roles.sql"],
      },
    ],
    manualActions: [],
  });
}

async function checkpointPath(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-restore-executor-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "restore-checkpoint.json");
}

describe("restore executor", () => {
  it("resumes after interruption without reapplying a completed action", async () => {
    const filename = await checkpointPath();
    const extensionsApply = vi.fn(() =>
      Promise.resolve({ fingerprint: "a".repeat(64) }),
    );
    const extensionsVerify = vi.fn(() => Promise.resolve(true));
    const extensions: RestoreActionHandler = {
      apply: extensionsApply,
      verify: extensionsVerify,
    };
    const rolesApply = vi
      .fn<RestoreActionHandler["apply"]>()
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockResolvedValueOnce({ fingerprint: "b".repeat(64) });
    const rolesVerify = vi
      .fn<RestoreActionHandler["verify"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const handlers = {
      "database.extensions": extensions,
      "database.roles": { apply: rolesApply, verify: rolesVerify },
    };

    await expect(
      executeRestore({ plan: plan(), checkpointPath: filename, handlers }),
    ).rejects.toThrow("interrupted");
    expect(extensionsApply).toHaveBeenCalledOnce();
    expect(rolesApply).toHaveBeenCalledOnce();

    const result = await executeRestore({
      plan: plan(),
      checkpointPath: filename,
      handlers,
      resume: true,
    });

    expect(result).toMatchObject({ status: "restored", completedActions: 2 });
    expect(extensionsApply).toHaveBeenCalledOnce();
    expect(extensionsVerify).toHaveBeenCalledTimes(2);
    expect(rolesApply).toHaveBeenCalledTimes(2);
    expect(rolesVerify).toHaveBeenCalledTimes(2);
    const checkpoint = JSON.parse(await readFile(filename, "utf8")) as {
      actions: { id: string; attempts: number; status: string }[];
    };
    expect(checkpoint.actions).toEqual([
      expect.objectContaining({
        id: "restore.database.extensions",
        attempts: 1,
        status: "completed",
      }),
      expect.objectContaining({
        id: "restore.database.roles",
        attempts: 2,
        status: "completed",
      }),
    ]);
  });

  it("recovers a crash-after-apply by verifying before retrying", async () => {
    const filename = await checkpointPath();
    const extensions: RestoreActionHandler = {
      apply: vi.fn(() => Promise.resolve({})),
      verify: vi.fn(() => Promise.resolve(true)),
    };
    const rolesApply = vi.fn(() =>
      Promise.reject(new Error("checkpoint interrupted")),
    );
    const rolesVerify = vi.fn(() => Promise.resolve(true));
    const roles: RestoreActionHandler = {
      apply: rolesApply,
      verify: rolesVerify,
    };
    const handlers = {
      "database.extensions": extensions,
      "database.roles": roles,
    };

    await expect(
      executeRestore({ plan: plan(), checkpointPath: filename, handlers }),
    ).rejects.toThrow("checkpoint interrupted");
    const result = await executeRestore({
      plan: plan(),
      checkpointPath: filename,
      handlers,
      resume: true,
    });

    expect(result.completedActions).toBe(2);
    expect(rolesApply).toHaveBeenCalledOnce();
    expect(rolesVerify).toHaveBeenCalledOnce();
  });

  it("preflights every adapter and dependency before creating a checkpoint", async () => {
    const missingAdapterCheckpoint = await checkpointPath();
    await expect(
      executeRestore({
        plan: plan(),
        checkpointPath: missingAdapterCheckpoint,
        handlers: {},
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ADAPTER_MISSING" });
    await expect(stat(missingAdapterCheckpoint)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const cyclic = plan();
    cyclic.actions[0]!.dependsOn = ["restore.database.roles"];
    const cycleCheckpoint = await checkpointPath();
    await expect(
      executeRestore({
        plan: cyclic,
        checkpointPath: cycleCheckpoint,
        handlers: {
          "database.extensions": {
            apply: vi.fn(),
            verify: vi.fn(),
          },
          "database.roles": { apply: vi.fn(), verify: vi.fn() },
        },
      }),
    ).rejects.toMatchObject({ code: "RESTORE_PLAN_INVALID" });
    await expect(stat(cycleCheckpoint)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records semantic verification failure and refuses plan drift on resume", async () => {
    const filename = await checkpointPath();
    const handlers: Record<string, RestoreActionHandler> = {
      "database.extensions": {
        apply: vi.fn(() => Promise.resolve({})),
        verify: vi.fn(() => Promise.resolve(false)),
      },
      "database.roles": {
        apply: vi.fn(() => Promise.resolve({})),
        verify: vi.fn(() => Promise.resolve(true)),
      },
    };
    await expect(
      executeRestore({ plan: plan(), checkpointPath: filename, handlers }),
    ).rejects.toMatchObject({ code: "RESTORE_PARITY_FAILED" });
    const checkpoint = JSON.parse(await readFile(filename, "utf8")) as {
      actions: { status: string; failureCode?: string }[];
    };
    expect(checkpoint.actions[0]).toMatchObject({
      status: "failed",
      failureCode: "RESTORE_PARITY_FAILED",
    });

    const drifted = plan();
    drifted.target.projectRef = "bbbbbbbbbbbbbbbbbbbb";
    await expect(
      executeRestore({
        plan: drifted,
        checkpointPath: filename,
        handlers,
        resume: true,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_CHECKPOINT_MISMATCH" });
  });
});
