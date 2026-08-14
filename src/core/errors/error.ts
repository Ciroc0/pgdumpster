import { z } from "zod";

export const errorCategorySchema = z.enum([
  "config",
  "auth",
  "dependency",
  "network",
  "rate_limit",
  "platform_contract",
  "database",
  "storage",
  "edge",
  "control_plane",
  "consistency",
  "integrity",
  "archive",
  "encryption",
  "destination",
  "restore_conflict",
  "restore_policy",
  "security",
  "io",
  "cancelled",
  "internal",
]);

export type ErrorCategory = z.infer<typeof errorCategorySchema>;

export interface PgDumpsterErrorOptions {
  code: string;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  component?: string;
  runId?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

export class PgDumpsterError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly component: string | undefined;
  readonly runId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(options: PgDumpsterErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "PgDumpsterError";
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.component = options.component;
    this.runId = options.runId;
    this.details = options.details;
  }
}
