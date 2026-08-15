import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";

export type ConsistencyMode = "verified" | "best-effort" | "quiesced";

export interface ConsistencyRunOptions<TSnapshot, TResult> {
  mode: ConsistencyMode;
  maxRetries: number;
  snapshot: (signal?: AbortSignal) => Promise<TSnapshot>;
  copy: (attempt: number, signal?: AbortSignal) => Promise<TResult>;
  cleanup?: (result: TResult, signal?: AbortSignal) => Promise<void>;
  cleanupPartial?: (signal?: AbortSignal) => Promise<void>;
  isDriftError?: (error: unknown) => boolean;
  equals?: (before: TSnapshot, after: TSnapshot) => boolean;
  signal?: AbortSignal | undefined;
}

export interface ConsistencyRunResult<TResult> {
  result: TResult;
  attempts: number;
  driftDetected: boolean;
  stable: boolean;
}

const MAX_CONSISTENCY_RETRIES = 20;

function validateRetryCount(maxRetries: number): void {
  if (
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > MAX_CONSISTENCY_RETRIES
  ) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message: `Consistency retry count must be an integer between 0 and ${MAX_CONSISTENCY_RETRIES}.`,
      retryable: false,
    });
  }
}

function defaultEquals<TSnapshot>(
  before: TSnapshot,
  after: TSnapshot,
): boolean {
  return canonicalJson(before) === canonicalJson(after);
}

function retryUnsafe(message: string): PgDumpsterError {
  return new PgDumpsterError({
    code: "CONSISTENCY_RETRY_UNSAFE",
    category: "consistency",
    message,
    retryable: false,
  });
}

async function cleanupCompletedCopy<TResult>(
  result: TResult,
  cleanup:
    ((result: TResult, signal?: AbortSignal) => Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (cleanup === undefined) {
    throw retryUnsafe(
      "The backup adapter cannot safely remove its provisional completed copy before retry or failure.",
    );
  }

  const cleanupSignal = signal?.aborted === true ? undefined : signal;
  try {
    await cleanup(result, cleanupSignal);
  } catch (error) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_PARTIAL_CLEANUP_FAILED",
      category: "consistency",
      message: "Failed to remove provisional backup artifacts.",
      retryable: false,
      cause: error,
    });
  }
}

async function cleanupAfterCopyFailure(
  cleanupPartial: ((signal?: AbortSignal) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
  required: boolean,
): Promise<void> {
  if (cleanupPartial === undefined) {
    if (!required) return;
    throw retryUnsafe(
      "Source drift interrupted the copy but the backup adapter cannot safely remove partial artifacts before retry.",
    );
  }

  const cleanupSignal = signal?.aborted === true ? undefined : signal;
  try {
    await cleanupPartial(cleanupSignal);
  } catch (error) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_PARTIAL_CLEANUP_FAILED",
      category: "consistency",
      message: "Failed to remove partial backup artifacts after copy failure.",
      retryable: false,
      cause: error,
    });
  }
}

function quiescedDriftError(attempt: number): PgDumpsterError {
  return new PgDumpsterError({
    code: "QUIESCED_SOURCE_CHANGED",
    category: "consistency",
    message: "Source state changed during a quiesced backup.",
    retryable: false,
    details: { attempt },
  });
}

function stabilizationError(
  attempt: number,
  maxRetries: number,
): PgDumpsterError {
  return new PgDumpsterError({
    code: "SOURCE_DID_NOT_STABILIZE",
    category: "consistency",
    message:
      "Source state continued changing beyond the configured consistency retry bound.",
    retryable: false,
    details: {
      attempts: attempt,
      maxRetries,
    },
  });
}

function driftAction(
  mode: ConsistencyMode,
  attempt: number,
  maxRetries: number,
): "retry" | "best-effort" {
  if (mode === "best-effort") return "best-effort";
  if (mode === "quiesced") throw quiescedDriftError(attempt);
  if (attempt > maxRetries) throw stabilizationError(attempt, maxRetries);
  return "retry";
}

export async function runConsistentCopy<TSnapshot, TResult>(
  options: ConsistencyRunOptions<TSnapshot, TResult>,
): Promise<ConsistencyRunResult<TResult>> {
  validateRetryCount(options.maxRetries);

  const equals = options.equals ?? defaultEquals;
  const isDriftError = options.isDriftError ?? (() => false);
  let driftDetected = false;

  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    options.signal?.throwIfAborted();

    let before: TSnapshot;
    try {
      before = await options.snapshot(options.signal);
    } catch (error) {
      if (options.signal?.aborted === true) options.signal.throwIfAborted();
      if (!isDriftError(error) || options.mode === "best-effort") throw error;
      driftDetected = true;
      driftAction(options.mode, attempt, options.maxRetries);
      continue;
    }

    options.signal?.throwIfAborted();

    let result: TResult;
    try {
      result = await options.copy(attempt, options.signal);
    } catch (error) {
      const driftError = isDriftError(error);
      await cleanupAfterCopyFailure(
        options.cleanupPartial,
        options.signal,
        driftError && options.mode !== "best-effort",
      );
      if (options.signal?.aborted === true) options.signal.throwIfAborted();
      if (!driftError || options.mode === "best-effort") throw error;

      driftDetected = true;
      driftAction(options.mode, attempt, options.maxRetries);
      continue;
    }

    if (options.signal?.aborted === true) {
      await cleanupCompletedCopy(result, options.cleanup, options.signal);
      options.signal.throwIfAborted();
    }

    let after: TSnapshot;
    try {
      after = await options.snapshot(options.signal);
    } catch (error) {
      const driftError = isDriftError(error);
      if (driftError && options.mode === "best-effort") {
        return {
          result,
          attempts: attempt,
          driftDetected: true,
          stable: false,
        };
      }

      await cleanupCompletedCopy(result, options.cleanup, options.signal);
      if (options.signal?.aborted === true) options.signal.throwIfAborted();
      if (!driftError) throw error;

      driftDetected = true;
      driftAction(options.mode, attempt, options.maxRetries);
      continue;
    }

    if (options.signal?.aborted === true) {
      await cleanupCompletedCopy(result, options.cleanup, options.signal);
      options.signal.throwIfAborted();
    }

    if (equals(before, after)) {
      return {
        result,
        attempts: attempt,
        driftDetected,
        stable: true,
      };
    }

    driftDetected = true;

    if (options.mode === "best-effort") {
      return {
        result,
        attempts: attempt,
        driftDetected: true,
        stable: false,
      };
    }

    await cleanupCompletedCopy(result, options.cleanup, options.signal);
    driftAction(options.mode, attempt, options.maxRetries);
  }

  throw new PgDumpsterError({
    code: "INTERNAL_INVARIANT_VIOLATION",
    category: "internal",
    message: "Consistency loop terminated unexpectedly.",
    retryable: false,
  });
}
