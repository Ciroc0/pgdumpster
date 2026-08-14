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

type CoverageEntry = z.infer<typeof coverageEntrySchema>;

export interface BackupStepContext {
  workspaceRoot: string;
  attempt: number;
  signal?: AbortSignal | undefined;
}

export interface BackupStepResult {
  artifacts: readonly string[];
  coverage: readonly CoverageEntry[];
}

export interface BackupStep {
  id: string;
  run: (context: BackupStepContext) => Promise<BackupStepResult>;
}

export interface ExecuteBackupOptions {
  workspaceRoot: string;
  checkpointPath: string;
  runId: string;
  projectRef: string;
  immutableConfigSha256: string;
  toolVersion: string;
  startedAt: string;
  consistency: "verified" | "best-effort" | "quiesced";
  steps: readonly BackupStep[];
  resume?: boolean;
  signal?: AbortSignal | undefined;
  now?: () => string;
}

export interface BackupExecutionResult {
  manifest: Manifest;
  coverage: CoverageDocument;
}

function failureCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true) return "OPERATION_CANCELLED";
  const code = (error as Partial<PgDumpsterError> | undefined)?.code;
  return typeof code === "string" && code.length > 0
    ? code
    : "BACKUP_STEP_FAILED";
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
): Manifest["result"]["consistency"] {
  return consistency === "best-effort" ? "best_effort" : consistency;
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
      const result = await step.run({
        workspaceRoot: options.workspaceRoot,
        attempt,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const coverage = result.coverage.map((entry) =>
        coverageEntrySchema.parse(entry),
      );
      const artifacts = await Promise.all(
        result.artifacts.map((artifact) =>
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
      consistency: consistencyResult(options.consistency),
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
