import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import {
  authConfigSecretFieldNames,
  authConfigUpdateFieldNames,
  authContractSchema,
} from "../../supabase/management/auth-contract.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const ARTIFACT = "secrets/auth-config.json";
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface AuthConfigRestoreHandlerOptions {
  bundleRoot: string;
  targetProjectRef: string;
  client: {
    get(
      pathname: string,
      schema: z.ZodType<unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    patch(
      pathname: string,
      body: unknown,
      bodySchema: z.ZodType<unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function sourceConfig(options: AuthConfigRestoreHandlerOptions) {
  const filename = await resolveBundleArtifact(options.bundleRoot, ARTIFACT);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Auth config artifact must be a bounded regular file.",
      retryable: false,
      component: "auth.config",
    });
  }
  const parsed = documentSchema.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const allowed = new Set(authConfigUpdateFieldNames());
  const secrets = new Set(authConfigSecretFieldNames());
  return Object.fromEntries(
    Object.entries(parsed.config).filter(
      ([key, value]) =>
        allowed.has(key) && !secrets.has(key) && value !== undefined,
    ),
  );
}

async function targetConfig(
  options: AuthConfigRestoreHandlerOptions,
  signal?: AbortSignal,
) {
  const value = await options.client.get(
    `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/config/auth`,
    authContractSchema("AuthConfigResponse"),
    ...(signal === undefined ? [] : [{ signal }]),
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PgDumpsterError({
      code: "PLATFORM_API_CONTRACT_CHANGED",
      category: "platform_contract",
      message: "Target Auth config is not an object.",
      retryable: false,
      component: "auth.config",
    });
  }
  return value as Record<string, unknown>;
}

function matches(
  source: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>,
): boolean {
  return (
    canonicalJson(source) ===
    canonicalJson(
      Object.fromEntries(Object.keys(source).map((key) => [key, target[key]])),
    )
  );
}

export function createAuthConfigRestoreHandler(
  options: AuthConfigRestoreHandlerOptions,
): RestoreActionHandler {
  const endpoint = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/config/auth`;
  return {
    async apply(context): Promise<RestoreActionResult> {
      if (
        context.action.artifacts.length !== 1 ||
        context.action.artifacts[0] !== ARTIFACT
      ) {
        throw new PgDumpsterError({
          code: "RESTORE_ARTIFACT_INVALID",
          category: "restore_policy",
          message: "Auth config restore requires secrets/auth-config.json.",
          retryable: false,
          component: "auth.config",
        });
      }
      const source = await sourceConfig(options);
      const expected = fingerprint(source);
      if (matches(source, await targetConfig(options, context.signal)))
        return { fingerprint: expected };
      await options.client.patch(
        endpoint,
        source,
        authContractSchema("UpdateAuthConfigBody"),
        ...(context.signal === undefined ? [] : [{ signal: context.signal }]),
      );
      return { fingerprint: expected };
    },
    async verify(context): Promise<boolean> {
      const source = await sourceConfig(options);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== fingerprint(source)
      )
        return false;
      return matches(source, await targetConfig(options, context.signal));
    },
  };
}
