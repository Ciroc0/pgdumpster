import { z } from "zod";

import {
  resolveSupabaseCommand,
  runProcess,
  type ResolvedCommand,
  type RunProcessOptions,
  type ProcessResult,
} from "../utils/process.js";

export interface LinkedDatabaseQueryDependencies {
  resolveSupabaseCommand?: () => Promise<ResolvedCommand>;
  runProcess?: (
    command: string,
    args: readonly string[],
    options: RunProcessOptions,
  ) => Promise<ProcessResult>;
}

const linkedQueryResponseSchema = z
  .object({
    boundary: z.string().regex(/^[a-f0-9]{32}$/u),
    rows: z.array(z.unknown()),
    warning: z.string().min(1),
  })
  .passthrough();

export type LinkedDatabaseQuery = (sql: string) => Promise<unknown[]>;

// The CLI creates and removes a short-lived login role for every linked query.
// Live validation showed that overlapping invocations can block each other, so
// all linked query executors in one pgDumpster process share a single lane.
let linkedQueryQueue: Promise<void> = Promise.resolve();

function serializeLinkedQuery<T>(operation: () => Promise<T>): Promise<T> {
  const result = linkedQueryQueue.then(operation, operation);
  linkedQueryQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function createLinkedDatabaseQuery(
  signal?: AbortSignal,
  dependencies: LinkedDatabaseQueryDependencies = {},
): Promise<LinkedDatabaseQuery> {
  signal?.throwIfAborted();
  const resolved = await (
    dependencies.resolveSupabaseCommand ?? resolveSupabaseCommand
  )();
  const processRunner = dependencies.runProcess ?? runProcess;
  return (sql: string): Promise<unknown[]> =>
    serializeLinkedQuery(async () => {
      signal?.throwIfAborted();
      const result = await processRunner(
        resolved.command,
        [
          ...resolved.prefixArgs,
          "db",
          "query",
          "--linked",
          "--output",
          "json",
          sql,
        ],
        {
          signal,
          timeoutMs: 120_000,
          maxOutputBytes: 16_777_216,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error("Supabase CLI linked database query failed");
      }
      const raw: unknown = JSON.parse(result.stdout);
      return linkedQueryResponseSchema.parse(raw).rows;
    });
}
