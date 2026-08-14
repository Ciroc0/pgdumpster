import { PgDumpsterError } from "./error.js";
import type { Redactor } from "../../security/redactor.js";

export interface SerializedError {
  schemaVersion: 1;
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  component?: string;
  runId?: string;
  details?: unknown;
}

export function serializeError(
  error: unknown,
  redactor: Redactor,
): SerializedError {
  const safe =
    error instanceof PgDumpsterError
      ? error
      : new PgDumpsterError({
          code: "INTERNAL_INVARIANT_VIOLATION",
          category: "internal",
          message:
            error instanceof Error
              ? error.message
              : "Unexpected internal error.",
          retryable: false,
          cause: error,
        });

  return {
    schemaVersion: 1,
    code: safe.code,
    category: safe.category,
    message: redactor.redact(safe.message),
    retryable: safe.retryable,
    ...(safe.component === undefined ? {} : { component: safe.component }),
    ...(safe.runId === undefined ? {} : { runId: safe.runId }),
    ...(safe.details === undefined
      ? {}
      : { details: redactor.sanitize(safe.details) }),
  };
}
