import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { PgDumpsterError } from "../errors/error.js";
import { coverageEntrySchema } from "../bundle/schemas.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import { writeFileAtomic } from "../../utils/atomic-file.js";
import { canonicalJson } from "../../utils/canonical-json.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const checkpointArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const checkpointStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
    status: z.enum(["pending", "in_progress", "completed", "failed"]),
    attempts: z.number().int().nonnegative(),
    artifacts: z.array(checkpointArtifactSchema),
    coverage: z.array(coverageEntrySchema),
    consistencyDriftDetected: z.boolean().default(false),
    failureCode: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.status === "failed" && step.failureCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "A failed checkpoint step requires failureCode",
      });
    }
    if (step.status !== "failed" && step.failureCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Only a failed checkpoint step may contain failureCode",
      });
    }
  });

export const backupCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    projectRef: z.string().regex(/^[a-z0-9]{20}$/u),
    immutableConfigSha256: sha256Schema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    steps: z.array(checkpointStepSchema).min(1),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const ids = new Set<string>();
    for (const [index, step] of checkpoint.steps.entries()) {
      if (ids.has(step.id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: "Checkpoint step IDs must be unique",
        });
      }
      ids.add(step.id);
      const artifactPaths = new Set<string>();
      for (const artifact of step.artifacts) {
        try {
          assertSafeBundlePath(artifact.path);
        } catch {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "artifacts"],
            message: "Checkpoint artifact path is unsafe",
          });
        }
        if (artifactPaths.has(artifact.path)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "artifacts"],
            message: "Checkpoint artifact paths must be unique per step",
          });
        }
        artifactPaths.add(artifact.path);
      }
    }
  });

export type BackupCheckpoint = z.infer<typeof backupCheckpointSchema>;
export type CheckpointArtifact = z.infer<typeof checkpointArtifactSchema>;
export type CheckpointStepStatus = BackupCheckpoint["steps"][number]["status"];

export interface ResumeIdentity {
  runId: string;
  projectRef: string;
  immutableConfigSha256: string;
}

const MAX_CHECKPOINT_BYTES = 1_048_576;

function resumeError(code: string, message: string): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category: "config",
    message,
    retryable: false,
  });
}

async function sha256File(
  filename: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  signal?.throwIfAborted();
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename, { signal })) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    digest.update(value);
  }
  return { sha256: digest.digest("hex"), bytes };
}

export async function describeCheckpointArtifact(
  workspaceRoot: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<CheckpointArtifact> {
  assertSafeBundlePath(relativePath);
  const absolute = path.join(workspaceRoot, ...relativePath.split("/"));
  const workspaceStat = await lstat(workspaceRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw resumeError(
      "RESUME_STATE_INVALID",
      "Checkpoint workspace must be a real non-symlink directory.",
    );
  }
  const [resolvedWorkspace, resolvedArtifact] = await Promise.all([
    realpath(workspaceRoot),
    realpath(absolute),
  ]);
  const relativeResolved = path.relative(resolvedWorkspace, resolvedArtifact);
  if (
    relativeResolved === ".." ||
    relativeResolved.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeResolved)
  ) {
    throw resumeError(
      "RESUME_STATE_INVALID",
      `Checkpoint artifact escapes the workspace: ${relativePath}`,
    );
  }
  const fileStat = await lstat(absolute);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw resumeError(
      "RESUME_STATE_INVALID",
      `Checkpoint artifact is not a regular file: ${relativePath}`,
    );
  }
  const digest = await sha256File(absolute, signal);
  return { path: relativePath, ...digest };
}

export function createBackupCheckpoint(input: {
  runId: string;
  projectRef: string;
  immutableConfigSha256: string;
  stepIds: readonly string[];
  now: string;
}): BackupCheckpoint {
  return backupCheckpointSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    projectRef: input.projectRef,
    immutableConfigSha256: input.immutableConfigSha256,
    createdAt: input.now,
    updatedAt: input.now,
    steps: input.stepIds.map((id) => ({
      id,
      status: "pending",
      attempts: 0,
      artifacts: [],
      coverage: [],
      consistencyDriftDetected: false,
    })),
  });
}

export function transitionCheckpointStep(
  checkpoint: BackupCheckpoint,
  input: {
    id: string;
    status: CheckpointStepStatus;
    now: string;
    artifacts?: readonly CheckpointArtifact[];
    coverage?: readonly z.infer<typeof coverageEntrySchema>[];
    consistencyDriftDetected?: boolean;
    failureCode?: string;
  },
): BackupCheckpoint {
  const current = checkpoint.steps.find(({ id }) => id === input.id);
  if (current === undefined) {
    throw resumeError("RESUME_STATE_INVALID", "Unknown checkpoint step.");
  }
  if (current.status === "completed" && input.status !== "completed") {
    throw resumeError(
      "RESUME_STATE_INVALID",
      "A completed checkpoint step cannot be reopened without integrity failure.",
    );
  }
  const startsAttempt =
    input.status === "in_progress" && current.status !== "in_progress";
  return backupCheckpointSchema.parse({
    ...checkpoint,
    updatedAt: input.now,
    steps: checkpoint.steps.map((step) =>
      step.id === input.id
        ? {
            id: step.id,
            status: input.status,
            attempts: step.attempts + (startsAttempt ? 1 : 0),
            artifacts: input.artifacts ?? step.artifacts,
            coverage: input.coverage ?? step.coverage,
            consistencyDriftDetected:
              input.consistencyDriftDetected ?? step.consistencyDriftDetected,
            ...(input.failureCode === undefined
              ? {}
              : { failureCode: input.failureCode }),
          }
        : step,
    ),
  });
}

export async function writeBackupCheckpoint(
  filename: string,
  checkpoint: BackupCheckpoint,
  signal?: AbortSignal,
): Promise<void> {
  const validated = backupCheckpointSchema.parse(checkpoint);
  await writeFileAtomic(filename, canonicalJson(validated), {
    signal,
    mode: 0o600,
  });
}

export async function loadBackupCheckpoint(
  filename: string,
  workspaceRoot: string,
  expected: ResumeIdentity,
  signal?: AbortSignal,
): Promise<BackupCheckpoint> {
  signal?.throwIfAborted();
  const checkpointStat = await lstat(filename);
  if (
    !checkpointStat.isFile() ||
    checkpointStat.isSymbolicLink() ||
    checkpointStat.size > MAX_CHECKPOINT_BYTES
  ) {
    throw resumeError(
      "RESUME_STATE_INVALID",
      "Checkpoint must be a small regular non-symlink file.",
    );
  }
  let checkpoint: BackupCheckpoint;
  try {
    checkpoint = backupCheckpointSchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESUME_STATE_INVALID",
      category: "config",
      message: "Checkpoint JSON is invalid.",
      retryable: false,
      cause: error,
    });
  }
  if (
    checkpoint.runId !== expected.runId ||
    checkpoint.projectRef !== expected.projectRef
  ) {
    throw resumeError(
      "RESUME_STATE_INVALID",
      "Checkpoint source or run identity does not match this resume request.",
    );
  }
  if (checkpoint.immutableConfigSha256 !== expected.immutableConfigSha256) {
    throw resumeError(
      "RESUME_CONFIG_MISMATCH",
      "Immutable backup configuration changed since the run started.",
    );
  }
  for (const step of checkpoint.steps) {
    if (step.status !== "completed") continue;
    for (const artifact of step.artifacts) {
      const actual = await describeCheckpointArtifact(
        workspaceRoot,
        artifact.path,
        signal,
      );
      if (
        actual.sha256 !== artifact.sha256 ||
        actual.bytes !== artifact.bytes
      ) {
        throw resumeError(
          "RESUME_STATE_INVALID",
          `Completed checkpoint artifact failed integrity validation: ${artifact.path}`,
        );
      }
    }
  }
  return checkpoint;
}