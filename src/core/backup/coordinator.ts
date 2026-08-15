import { lstat } from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";

import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../bundle/finalize.js";
import {
  coverageDocumentSchema,
  coverageEntrySchema,
  type CoverageDocument,
  type Manifest,
} from "../bundle/schemas.js";
import {
  createBackupCheckpoint,
  describeCheckpointArtifact,
  loadBackupCheckpoint,
  transitionCheckpointStep,
  writeBackupCheckpoint,
  type BackupCheckpoint,
} from "../checkpoint/backup.js";
import {
  deriveBackupResult,
  validateCoverageOutcomes,
} from "../coverage/result.js";
import { loadCoverageRegistry } from "../coverage/registry.js";
import { PgDumpsterError } from "../errors/error.js";
import { writeFileAtomic } from "../../utils/atomic-file.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { runConsistentCopy, type ConsistencyMode } from "./consistency.js";

type CoverageEntry = z.infer<typeof coverageEntrySchema>;

const DEFAULT_CONSISTENCY_RETRIES = 3;
const COPY_DRIFT_CODES = new Set([
  "BACKUP_SOURCE_DRIFT_DETECTED",
  "STORAGE_OBJECT_CHANGED_DURING_COPY",
  "STORAGE_SPECIALIZED_IDENTITY_DRIFT",
]);

export interface BackupStepContext {
  workspaceRoot: string;
  attempt: number;
  signal?: AbortSignal | undefined;
}

export interface BackupStepResult {
  artifacts: readonly string[];
  coverage: readonly CoverageEntry[];
}

export interface BackupStepConsistencyContext {
  workspaceRoot: string;
  signal?: AbortSignal | undefined;
}

export interface BackupStepConsistencyAdapter {
  snapshot: (context: BackupStepConsistencyContext) => Promise<unknown>;
  cleanup: (
    result: BackupStepResult,
    context: BackupStepConsistencyContext,
  ) => Promise<void>;
  cleanupPartial?:
    | ((context: BackupStepConsistencyContext) => Promise<void>)
    | undefined;
  equals?: ((before: unknown, after: unknown) => boolean) | undefined;
  maxRetries?: number | undefined;
}

export interface BackupStep {
  id: string;
  run: (context: BackupStepContext) => Promise<BackupStepResult>;
  consistency?: BackupStepConsistencyAdapter | undefined;
}

export interface ExecuteBackupOptions {
  workspaceRoot: string;
  checkpointPath: string;
  runId: string;
  projectRef: string;
  immutableConfigSha256: string;
  toolVersion: string;
  startedAt: string;
  consistency: ConsistencyMode;
  steps: readonly BackupStep[];
  maxConsistencyRetries?: number | undefined;
  resume?: boolean;
  signal?: AbortSignal | undefined;
  now?: () => string;
}

export interface BackupExecutionResult {
  manifest: Manifest;
  coverage: CoverageDocument;
}

interface ExecutedStepResult {
  result: BackupStepResult;
  consistencyDriftDetected: boolean;
}

function failureCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true) return "OPERATION_CANCELLED";
  const code = (error as Partial<PgDumpsterError> | undefined)?.code;
  return typeof code === "string" && code.length > 0
    ? code
    : "BACKUP_STEP_FAILED";
}

function copyErrorIsDrift(error: unknown): boolean {
  const candidate = error as Partial<PgDumpsterError> | undefined;
  return (
    candidate?.category === "consistency" &&
    typeof candidate.code === "string" &&
    COPY_DRIFT_CODES.has(candidate.code)
  );
}

function cancellationError(signal: AbortSignal): PgDumpsterError {
  return new PgDumpsterError({
    code: "OPERATION_CANCELLED",
    category: "cancelled",
    message: "Backup was cancelled. The checkpoint is safe to resume.",
    retryable: true,
    cause: signal.reason,
  });
}

function consistencyResult(
  consistency: ExecuteBackupOptions["consistency"],
  checkpoint: BackupCheckpoint,
): Manifest["result"]["consistency"] {
  if (consistency !== "best-effort") return consistency;
  return checkpoint.steps.some(({ consistencyDriftDetected }) =>
    consistencyDriftDetected,
  )
    ? "drift_detected"
    : "best_effort";
}

function assertUniqueStepIds(steps: readonly BackupStep[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!/^[a-z][a-z0-9_.-]*$/u.test(step.id) || ids.has(step.id)) {
      throw new PgDumpsterError({
        code: "CONFIG_INVALID",
        category: "config",
        message: "Backup step IDs must be unique safe identifiers.",
        retryable: false,
      });
    }
    ids.add(step.id);
  }
  if (ids.size === 0) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message: "A backup run requires at least one step.",
      retryable: false,
    });
  }
}

function assertConsistencyAdapters(
  mode: ConsistencyMode,
  steps: readonly BackupStep[],
): void {
  if (mode === "best-effort") return;
  const missing = steps
    .filter(({ consistency }) => consistency === undefined)
    .map(({ id }) => id);
  if (missing.length > 0) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_ADAPTER_REQUIRED",
      category: "consistency",
      message: `${mode} backup requires a consistency adapter for every backup step.`,
      retryable: false,
      details: { mode, steps: missing },
    });
  }

  const unsafeResume = steps
    .filter(({ consistency }) => consistency?.cleanupPartial === undefined)
    .map(({ id }) => id);
  if (unsafeResume.length > 0) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_PARTIAL_CLEANUP_REQUIRED",
      category: "consistency",
      message: `${mode} backup requires partial-artifact cleanup for every backup step.`,
      retryable: false,
      details: { mode, steps: unsafeResume },
    });
  }
}

function stepContext(
  workspaceRoot: string,
  attempt: number,
  signal?: AbortSignal,
): BackupStepContext {
  return {
    workspaceRoot,
    attempt,
    ...(signal === undefined ? {} : { signal }),
  };
}

function consistencyContext(
  workspaceRoot: string,
  signal?: AbortSignal,
): BackupStepConsistencyContext {
  return {
    workspaceRoot,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function cleanupInterruptedStepBeforeResume(
  step: BackupStep,
  options: ExecuteBackupOptions,
  savedStatus: BackupCheckpoint["steps"][number]["status"],
): Promise<void> {
  if (
    options.resume !== true ||
    savedStatus === "pending" ||
    savedStatus === "completed"
  ) {
    return;
  }
  const cleanupPartial = step.consistency?.cleanupPartial;
  if (cleanupPartial === undefined) return;

  try {
    await cleanupPartial(
      consistencyContext(options.workspaceRoot, options.signal),
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "CONSISTENCY_PARTIAL_CLEANUP_FAILED",
      category: "consistency",
      message: `Failed to clean interrupted artifacts before resuming backup step ${step.id}.`,
      retryable: false,
      component: step.id,
      cause: error,
    });
  }
}

async function executeStep(
  step: BackupStep,
  options: ExecuteBackupOptions,
  checkpointAttempt: number,
): Promise<ExecutedStepResult> {
  const adapter = step.consistency;
  if (adapter === undefined) {
    return {
      result: await step.run(
        stepContext(options.workspaceRoot, checkpointAttempt, options.signal),
      ),
      consistencyDriftDetected: false,
    };
  }

  const cleanupPartial = adapter.cleanupPartial;
  const run = await runConsistentCopy({
    mode: options.consistency,
    maxRetries:
      adapter.maxRetries ??
      options.maxConsistencyRetries ??
      DEFAULT_CONSISTENCY_RETRIES,
    snapshot: (signal) =>
      adapter.snapshot(consistencyContext(options.workspaceRoot, signal)),
    copy: (consistencyAttempt, signal) =>
      step.run(
        stepContext(
          options.workspaceRoot,
          checkpointAttempt + consistencyAttempt - 1,
          signal,
        ),
      ),
    cleanup: (result, signal) =>
      adapter.cleanup(
        result,
        consistencyContext(options.workspaceRoot, signal),
      ),
    ...(cleanupPartial === undefined
      ? {}
      : {
          cleanupPartial: (signal?: AbortSignal) =>
            cleanupPartial(consistencyContext(options.workspaceRoot, signal)),
        }),
    isDriftError: copyErrorIsDrift,
    ...(adapter.equals === undefined ? {} : { equals: adapter.equals }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    result: run.result,
    consistencyDriftDetected: run.driftDetected,
  };
}

async function checkpointForRun(
  options: ExecuteBackupOptions,
): Promise<BackupCheckpoint> {
  if (options.resume === true) {
    return loadBackupCheckpoint(
      options.checkpointPath,
      options.workspaceRoot,
      {
        runId: options.runId,
        projectRef: options.projectRef,
        immutableConfigSha256: options.immutableConfigSha256,
      },
      options.signal,
    );
  }
  const checkpoint = createBackupCheckpoint({
    runId: options.runId,
    projectRef: options.projectRef,
    immutableConfigSha256: options.immutableConfigSha256,
    stepIds: options.steps.map(({ id }) => id),
    now: options.startedAt,
  });
  await writeBackupCheckpoint(
    options.checkpointPath,
    checkpoint,
    options.signal,
  );
  return checkpoint;
}

export async function executeBackup(
  options: ExecuteBackupOptions,
): Promise<BackupExecutionResult> {
  assertUniqueStepIds(options.steps);
  options.signal?.throwIfAborted();
  const workspaceStat = await lstat(options.workspaceRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new PgDumpsterError({
      code: "DESTINATION_INVALID",
      category: "config",
      message: "Backup workspace must be a real non-symlink directory.",
      retryable: false,
    });
  }
  assertConsistencyAdapters(options.consistency, options.steps);
  const now = options.now ?? (() => new Date().toISOString());
  let checkpoint = await checkpointForRun(options);
  if (
    checkpoint.steps.map(({ id }) => id).join("\0") !==
    options.steps.map(({ id }) => id).join("\0")
  ) {
    throw new PgDumpsterError({
      code: "RESUME_CONFIG_MISMATCH",
      category: "config",
      message: "Backup step order changed since the run started.",
      retryable: false,
    });
  }

  for (const step of options.steps) {
    const saved = checkpoint.steps.find(({ id }) => id === step.id)!;
    if (saved.status === "completed") continue;
    await cleanupInterruptedStepBeforeResume(step, options, saved.status);
    checkpoint = transitionCheckpointStep(checkpoint, {
      id: step.id,
      status: "in_progress",
      now: now(),
    });
    await writeBackupCheckpoint(
      options.checkpointPath,
      checkpoint,
      options.signal,
    );
    const attempt = checkpoint.steps.find(({ id }) => id === step.id)!.attempts;
    try {
      const executed = await executeStep(step, options, attempt);
      const coverage = executed.result.coverage.map((entry) =>
        coverageEntrySchema.parse(entry),
      );
      const artifacts = await Promise.all(
        executed.result.artifacts.map((artifact) =>
          describeCheckpointArtifact(
            options.workspaceRoot,
            artifact,
            options.signal,
          ),
        ),
      );
      checkpoint = transitionCheckpointStep(checkpoint, {
        id: step.id,
        status: "completed",
        now: now(),
        artifacts,
        coverage,
        consistencyDriftDetected: executed.consistencyDriftDetected,
      });
      await writeBackupCheckpoint(
        options.checkpointPath,
        checkpoint,
        options.signal,
      );
    } catch (error) {
      checkpoint = transitionCheckpointStep(checkpoint, {
        id: step.id,
        status: "failed",
        now: now(),
        failureCode: failureCode(error, options.signal),
      });
      await writeBackupCheckpoint(options.checkpointPath, checkpoint);
      if (options.signal?.aborted === true)
        throw cancellationError(options.signal);
      throw error;
    }
  }

  const coverage = coverageDocumentSchema.parse({
    formatVersion: "1.0.0",
    components: checkpoint.steps.flatMap(({ coverage: entries }) => entries),
  });
  const registry = await loadCoverageRegistry();
  validateCoverageOutcomes(registry, coverage.components);
  await writeFileAtomic(
    path.join(options.workspaceRoot, "coverage.json"),
    canonicalJson(coverage),
    { signal: options.signal },
  );
  const completedAt = now();
  const manifestInput: ManifestBeforeFinalization = {
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: options.toolVersion },
    operation: {
      id: options.runId,
      startedAt: options.startedAt,
      completedAt,
    },
    source: { projectRef: options.projectRef },
    result: {
      status: deriveBackupResult(registry, coverage.components),
      consistency: consistencyResult(options.consistency, checkpoint),
    },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    components: coverage.components.map(({ id, status }) => ({ id, status })),
  };
  const manifest = await finalizeBundle(options.workspaceRoot, manifestInput, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { manifest, coverage };
}