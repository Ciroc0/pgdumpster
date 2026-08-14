import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function checkpointPath(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-executor-branch-"),
  );

  temporaryDirectories.push(directory);

  return path.join(directory, "restore-checkpoint.json");
}

function plan(): RestorePlan {
  return restorePlanSchema.parse({
    schemaVersion: 1,
    planId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-14T22:00:00.000Z",
    source: {
      projectRef: "abcdefghijklmnopqrst",
      backupOperationId: "11111111-1111-4111-8111-111111111111",
      backupResult: "complete",
    },
    target: {
      projectRef: "zyxwvutsrqponmlkjihg",
    },
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

function successfulHandler(): RestoreActionHandler {
  return {
    apply: () => Promise.resolve({}),
    verify: () => Promise.resolve(true),
  };
}

describe("restore executor branch hardening", () => {
  it("refuses a blocked plan before execution", async () => {
    const value = plan();
    value.status = "blocked";

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: await checkpointPath(),
        handlers: {},
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_PLAN_BLOCKED",
    });
  });

  it("rejects an unknown dependency", async () => {
    const value = plan();

    value.actions[0]!.dependsOn = ["restore.unknown"];

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: await checkpointPath(),
        handlers: {
          "database.extensions": successfulHandler(),
          "database.roles": successfulHandler(),
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_PLAN_INVALID",
    });
  });

  it("rejects a planned action depending on a policy-blocked action", async () => {
    const value = plan();

    value.actions[0]!.status = "blocked_by_policy";

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: await checkpointPath(),
        handlers: {
          "database.roles": successfulHandler(),
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_PLAN_INVALID",
    });
  });

  it("detects an unsatisfied dependency caused by unsafe plan ordering", async () => {
    const value = plan();

    value.actions = [value.actions[1]!, value.actions[0]!];

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: await checkpointPath(),
        handlers: {
          "database.extensions": successfulHandler(),
          "database.roles": successfulHandler(),
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_DEPENDENCY_UNSATISFIED",
    });
  });

  it("returns restored_with_platform_limits for manual work and skipped actions", async () => {
    const value = plan();

    value.status = "ready_with_platform_limits";

    value.actions = [
      {
        ...value.actions[0]!,
        status: "skipped",
      },
    ];

    value.manualActions = [
      {
        id: "manual.smtp",
        component: "external.smtp_provider",
        reasonCode: "manual_external_restore",
        message: "Restore externally.",
      },
    ];

    const result = await executeRestore({
      plan: value,
      checkpointPath: await checkpointPath(),
      handlers: {},
    });

    expect(result).toMatchObject({
      status: "restored_with_platform_limits",
      completedActions: 0,
      skippedActions: 1,
    });
  });

  it("refuses resume when a completed action no longer verifies", async () => {
    const value = plan();

    value.actions = [value.actions[0]!];

    const filename = await checkpointPath();

    const apply = vi.fn(() =>
      Promise.resolve({
        fingerprint: "a".repeat(64),
      }),
    );

    await executeRestore({
      plan: value,
      checkpointPath: filename,
      handlers: {
        "database.extensions": {
          apply,
          verify: () => Promise.resolve(true),
        },
      },
    });

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: filename,
        resume: true,
        handlers: {
          "database.extensions": {
            apply,
            verify: () => Promise.resolve(false),
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_RESUME_PARITY_FAILED",
    });

    expect(apply).toHaveBeenCalledOnce();
  });

  it("persists the stable cancellation failure code", async () => {
    const value = plan();
    value.actions = [value.actions[0]!];

    const filename = await checkpointPath();

    const controller = new AbortController();

    const reason = new Error("cancel restore action");

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: filename,
        signal: controller.signal,
        handlers: {
          "database.extensions": {
            apply: () => {
              controller.abort(reason);
              return Promise.reject(reason);
            },
            verify: () => Promise.resolve(true),
          },
        },
      }),
    ).rejects.toBe(reason);

    const checkpoint = JSON.parse(await readFile(filename, "utf8")) as {
      actions: {
        status: string;
        failureCode?: string;
      }[];
    };

    expect(checkpoint.actions[0]).toMatchObject({
      status: "failed",
      failureCode: "OPERATION_CANCELLED",
    });
  });
});
