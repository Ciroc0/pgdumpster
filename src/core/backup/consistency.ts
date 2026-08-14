import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";

export type ConsistencyMode = "verified" | "best-effort" | "quiesced";

export interface ConsistencyRunOptions<TSnapshot, TResult> {
  mode: ConsistencyMode;
  maxRetries: number;
  snapshot: (signal?: AbortSignal) => Promise<TSnapshot>;
  copy: (attempt: number, signal?: AbortSignal) => Promise<TResult>;
  cleanup?: (result: TResult, signal?: AbortSignal) => Promise<void>;
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

async function cleanupAfterDrift<TResult>(
  result: TResult,
  cleanup:
    | ((result: TResult, signal?: AbortSignal) => Promise<void>)
    | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (cleanup === undefined) {
    throw new PgDumpsterError({
      code: "CONSISTENCY_RETRY_UNSAFE",
      category: "consistency",
      message:
        "Source drift was detected but the backup adapter cannot safely remove its provisional copy before retry or failure.",
      retryable: false,
    });
  }

  signal?.throwIfAborted();
  await cleanup(result, signal);
  signal?.throwIfAborted();
}

export async function runConsistentCopy<TSnapshot, TResult>(
  options: ConsistencyRunOptions<TSnapshot, TResult>,
): Promise<ConsistencyRunResult<TResult>> {
  validateRetryCount(options.maxRetries);

  const equals = options.equals ?? defaultEquals;
  let driftDetected = false;

  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    options.signal?.throwIfAborted();

    const before = await options.snapshot(options.signal);

    options.signal?.throwIfAborted();

    const result = await options.copy(attempt, options.signal);

    options.signal?.throwIfAborted();

    const after = await options.snapshot(options.signal);

    options.signal?.throwIfAborted();

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

    await cleanupAfterDrift(result, options.cleanup, options.signal);

    if (options.mode === "quiesced") {
      throw new PgDumpsterError({
        code: "QUIESCED_SOURCE_CHANGED",
        category: "consistency",
        message: "Source state changed during a quiesced backup.",
        retryable: false,
        details: { attempt },
      });
    }

    if (attempt > options.maxRetries) {
      throw new PgDumpsterError({
        code: "SOURCE_DID_NOT_STABILIZE",
        category: "consistency",
        message:
          "Source state continued changing beyond the configured consistency retry bound.",
        retryable: false,
        details: {
          attempts: attempt,
          maxRetries: options.maxRetries,
        },
      });
    }
  }

  throw new PgDumpsterError({
    code: "INTERNAL_INVARIANT_VIOLATION",
    category: "internal",
    message: "Consistency loop terminated unexpectedly.",
    retryable: false,
  });
}
