import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import { apiKeyContractSchema } from "../../supabase/management/api-key-contract.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const ARTIFACT = "secrets/api-legacy-keys-state.json";
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.object({ enabled: z.boolean() }).passthrough(),
  })
  .strict();

export interface LegacyApiKeyRestoreHandlerOptions {
  bundleRoot: string;
  targetProjectRef: string;
  conflictPolicy: "fail" | "replace";
  client: {
    get(
      pathname: string,
      schema: z.ZodType<unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    putEmpty(
      pathname: string,
      schema: z.ZodType<unknown>,
      options?: { signal?: AbortSignal; query?: Record<string, string> },
    ): Promise<unknown>;
  };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function desired(
  options: LegacyApiKeyRestoreHandlerOptions,
): Promise<{ enabled: boolean }> {
  const filename = await resolveBundleArtifact(options.bundleRoot, ARTIFACT);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304)
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Legacy API key artifact must be a bounded regular file.",
      retryable: false,
      component: "api.legacy_keys_state",
    });
  return documentSchema.parse(JSON.parse(await readFile(filename, "utf8")))
    .state;
}

export function createLegacyApiKeyRestoreHandler(
  options: LegacyApiKeyRestoreHandlerOptions,
): RestoreActionHandler {
  const endpoint = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/api-keys/legacy`;
  const current = async (signal?: AbortSignal) =>
    options.client.get(
      endpoint,
      apiKeyContractSchema("LegacyApiKeysResponse"),
      ...(signal === undefined ? [] : [{ signal }]),
    ) as Promise<{ enabled: boolean }>;
  return {
    async apply(context): Promise<RestoreActionResult> {
      if (
        context.action.artifacts.length !== 1 ||
        context.action.artifacts[0] !== ARTIFACT
      )
        throw new PgDumpsterError({
          code: "RESTORE_ARTIFACT_INVALID",
          category: "restore_policy",
          message:
            "Legacy API key restore requires secrets/api-legacy-keys-state.json.",
          retryable: false,
          component: "api.legacy_keys_state",
        });
      const source = await desired(options);
      const expected = fingerprint(source);
      if ((await current(context.signal)).enabled === source.enabled)
        return { fingerprint: expected };
      if (options.conflictPolicy === "fail")
        throw new PgDumpsterError({
          code: "RESTORE_TARGET_CONFLICT",
          category: "restore_policy",
          message: "Target legacy API key state differs from source.",
          retryable: false,
          component: "api.legacy_keys_state",
        });
      await options.client.putEmpty(
        endpoint,
        apiKeyContractSchema("LegacyApiKeysResponse"),
        {
          query: { enabled: String(source.enabled) },
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
      );
      return { fingerprint: expected };
    },
    async verify(context): Promise<boolean> {
      const source = await desired(options);
      return (
        (context.expectedFingerprint === undefined ||
          context.expectedFingerprint === fingerprint(source)) &&
        (await current(context.signal)).enabled === source.enabled
      );
    },
  };
}
