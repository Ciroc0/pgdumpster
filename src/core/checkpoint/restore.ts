import { readFile } from "node:fs/promises";

import { z } from "zod";

import { PgDumpsterError } from "../errors/error.js";
import { writeFileAtomic } from "../../utils/atomic-file.js";
import { canonicalJson } from "../../utils/canonical-json.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const restoreCheckpointActionSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum([
      "pending",
      "in_progress",
      "completed",
      "skipped",
      "failed",
    ]),
    attempts: z.number().int().nonnegative(),
    completedAt: z.iso.datetime({ offset: true }).optional(),
    failureCode: z.string().min(1).optional(),
    fingerprint: sha256Schema.optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.status === "failed" && action.failureCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "A failed restore action requires failureCode",
      });
    }
    if (action.status !== "failed" && action.failureCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Only a failed restore action may have failureCode",
      });
    }
    if (action.status !== "completed" && action.fingerprint !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "Only a completed restore action may have a fingerprint",
      });
    }
  });

export const restoreCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    planSha256: sha256Schema,
    backupOperationId: z.string().uuid(),
    sourceProjectRef: z.string().regex(/^[a-z0-9]{20}$/u),
    targetProjectRef: z.string().regex(/^[a-z0-9]{20}$/u),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    actions: restoreCheckpointActionSchema.array().min(1),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const ids = new Set<string>();
    for (const [index, action] of checkpoint.actions.entries()) {
      if (ids.has(action.id)) {
        context.addIssue({
          code: "custom",
          path: ["actions", index, "id"],
          message: "Restore checkpoint action IDs must be unique",
        });
      }
      ids.add(action.id);
    }
  });

export type RestoreCheckpoint = z.infer<typeof restoreCheckpointSchema>;
export type RestoreCheckpointActionStatus =
  RestoreCheckpoint["actions"][number]["status"];

const MAX_RESTORE_CHECKPOINT_BYTES = 4_194_304;

function checkpointError(code: string, message: string): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category: "restore_policy",
    message,
    retryable: false,
  });
}

export function createRestoreCheckpoint(input: {
  planId: string;
  planSha256: string;
  backupOperationId: string;
  sourceProjectRef: string;
  targetProjectRef: string;
  actions: readonly { id: string; planned: boolean }[];
  now: string;
}): RestoreCheckpoint {
  return restoreCheckpointSchema.parse({
    schemaVersion: 1,
    planId: input.planId,
    planSha256: input.planSha256,
    backupOperationId: input.backupOperationId,
    sourceProjectRef: input.sourceProjectRef,
    targetProjectRef: input.targetProjectRef,
    createdAt: input.now,
    updatedAt: input.now,
    actions: input.actions.map(({ id, planned }) => ({
      id,
      status: planned ? "pending" : "skipped",
      attempts: 0,
    })),
  });
}

export function transitionRestoreAction(
  checkpoint: RestoreCheckpoint,
  input: {
    id: string;
    status: RestoreCheckpointActionStatus;
    now: string;
    failureCode?: string | undefined;
    fingerprint?: string | undefined;
  },
): RestoreCheckpoint {
  const current = checkpoint.actions.find(({ id }) => id === input.id);
  if (current === undefined)
    throw checkpointError(
      "RESTORE_CHECKPOINT_INVALID",
      "Unknown restore checkpoint action.",
    );
  if (current.status === "completed" && input.status !== "completed") {
    throw checkpointError(
      "RESTORE_CHECKPOINT_INVALID",
      "A completed restore action cannot be reopened.",
    );
  }
  const startsAttempt =
    input.status === "in_progress" && current.status !== "in_progress";
  return restoreCheckpointSchema.parse({
    ...checkpoint,
    updatedAt: input.now,
    actions: checkpoint.actions.map((action) =>
      action.id === input.id
        ? {
            id: action.id,
            status: input.status,
            attempts: action.attempts + (startsAttempt ? 1 : 0),
            ...(input.status === "completed"
              ? {
                  completedAt: input.now,
                  ...(input.fingerprint === undefined
                    ? {}
                    : { fingerprint: input.fingerprint }),
                }
              : {}),
            ...(input.failureCode === undefined
              ? {}
              : { failureCode: input.failureCode }),
          }
        : action,
    ),
  });
}

export async function writeRestoreCheckpoint(
  filename: string,
  checkpoint: RestoreCheckpoint,
  signal?: AbortSignal,
): Promise<void> {
  await writeFileAtomic(
    filename,
    canonicalJson(restoreCheckpointSchema.parse(checkpoint)),
    { signal, mode: 0o600 },
  );
}

export async function loadRestoreCheckpoint(
  filename: string,
  expected: {
    planId: string;
    planSha256: string;
    backupOperationId: string;
    sourceProjectRef: string;
    targetProjectRef: string;
    actionIds: readonly string[];
  },
): Promise<RestoreCheckpoint> {
  let raw: string;
  try {
    raw = await readFile(filename, "utf8");
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESTORE_CHECKPOINT_INVALID",
      category: "restore_policy",
      message: "Restore checkpoint could not be read.",
      retryable: false,
      cause: error,
    });
  }
  if (Buffer.byteLength(raw) > MAX_RESTORE_CHECKPOINT_BYTES)
    throw checkpointError(
      "RESTORE_CHECKPOINT_INVALID",
      "Restore checkpoint exceeds its size limit.",
    );
  let checkpoint: RestoreCheckpoint;
  try {
    checkpoint = restoreCheckpointSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESTORE_CHECKPOINT_INVALID",
      category: "restore_policy",
      message: "Restore checkpoint JSON is invalid.",
      retryable: false,
      cause: error,
    });
  }
  if (
    checkpoint.planId !== expected.planId ||
    checkpoint.planSha256 !== expected.planSha256 ||
    checkpoint.backupOperationId !== expected.backupOperationId ||
    checkpoint.sourceProjectRef !== expected.sourceProjectRef ||
    checkpoint.targetProjectRef !== expected.targetProjectRef ||
    checkpoint.actions.map(({ id }) => id).join("\0") !==
      expected.actionIds.join("\0")
  ) {
    throw checkpointError(
      "RESTORE_CHECKPOINT_MISMATCH",
      "Restore checkpoint identity or immutable plan changed.",
    );
  }
  return checkpoint;
}
