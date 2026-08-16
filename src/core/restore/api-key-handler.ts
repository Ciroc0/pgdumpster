import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import { apiKeyContractSchema } from "../../supabase/management/api-key-contract.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { writeFileAtomic } from "../../utils/atomic-file.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const ARTIFACT = "secrets/api-keys.json";
const documentSchema = z
  .object({ schemaVersion: z.literal(1), keys: z.array(z.unknown()) })
  .strict();
const rotationMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceProjectRef: z.string(),
    targetProjectRef: z.string(),
    entries: z.array(
      z.object({
        source: z.object({
          id: z.string(),
          type: z.enum(["legacy", "publishable", "secret"]),
          name: z.string(),
          api_key: z.string(),
        }),
        target: z.object({
          id: z.string(),
          type: z.enum(["legacy", "publishable", "secret"]),
          name: z.string(),
          api_key: z.string(),
        }),
      }),
    ),
  })
  .strict();
interface Key {
  id: string;
  type: "legacy" | "publishable" | "secret";
  name: string;
  api_key: string;
  description?: string | null;
  secret_jwt_template?: Record<string, unknown> | null;
}

export interface ApiKeyRestoreHandlerOptions {
  bundleRoot: string;
  sourceProjectRef: string;
  targetProjectRef: string;
  rotationMapPath: string;
  client: {
    get(
      pathname: string,
      schema: z.ZodType<unknown>,
      options?: { signal?: AbortSignal; query?: Record<string, string> },
    ): Promise<unknown>;
    post(
      pathname: string,
      body: unknown,
      bodySchema: z.ZodType<unknown>,
      responseSchema: z.ZodType<unknown>,
      options?: { signal?: AbortSignal; query?: Record<string, string> },
    ): Promise<unknown>;
  };
  registerSecret(value: string): void;
}

function fail(
  message: string,
  code:
    | "RESTORE_ARTIFACT_INVALID"
    | "RESTORE_TARGET_CONFLICT" = "RESTORE_ARTIFACT_INVALID",
): never {
  throw new PgDumpsterError({
    code,
    category:
      code === "RESTORE_TARGET_CONFLICT" ? "restore_policy" : "integrity",
    message,
    retryable: false,
    component: "api.modern_keys",
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function keyFrom(value: unknown, requireValue: boolean): Key {
  const key = value as Record<string, unknown>;
  const id = key["id"];
  const type = key["type"];
  const name = key["name"];
  const apiKey = key["api_key"];
  if (
    typeof id !== "string" ||
    !["legacy", "publishable", "secret"].includes(String(type)) ||
    typeof name !== "string" ||
    (requireValue && (typeof apiKey !== "string" || apiKey.length < 4))
  )
    fail(
      "API key artifact or target response is missing restorable key identity/value.",
    );
  return {
    id,
    type: type as Key["type"],
    name,
    ...(typeof apiKey === "string" ? { api_key: apiKey } : { api_key: "" }),
    ...(typeof key["description"] === "string" || key["description"] === null
      ? { description: key["description"] }
      : {}),
    ...(key["secret_jwt_template"] !== null &&
    typeof key["secret_jwt_template"] === "object" &&
    !Array.isArray(key["secret_jwt_template"])
      ? {
          secret_jwt_template: key["secret_jwt_template"] as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}

function identity(key: Pick<Key, "type" | "name">): string {
  return `${key.type}\0${key.name}`;
}

function isPlatformGeneratedKey(key: Key): boolean {
  switch (key.type) {
    case "legacy":
      return true;
    case "publishable":
    case "secret":
      return key.name === "default";
  }
}

async function source(options: ApiKeyRestoreHandlerOptions): Promise<Key[]> {
  const filename = await resolveBundleArtifact(options.bundleRoot, ARTIFACT);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304)
    fail("API key artifact must be a bounded regular file.");
  const parsed = documentSchema.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const keys = parsed.keys.map((entry) =>
    keyFrom(apiKeyContractSchema("ApiKeyResponse").parse(entry), true),
  );
  const seen = new Set<string>();
  for (const key of keys) {
    const keyIdentity = identity(key);
    if (seen.has(keyIdentity))
      fail("API key artifact contains duplicate key identities.");
    seen.add(keyIdentity);
    options.registerSecret(key.api_key);
  }
  return keys.sort((left, right) =>
    identity(left).localeCompare(identity(right), "en"),
  );
}

async function target(
  options: ApiKeyRestoreHandlerOptions,
  signal?: AbortSignal,
): Promise<Key[]> {
  const value = await options.client.get(
    `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/api-keys`,
    apiKeyContractSchema("ApiKeyResponse").array(),
    { query: { reveal: "true" }, ...(signal === undefined ? {} : { signal }) },
  );
  if (!Array.isArray(value))
    throw new Error("Validated API key response must be an array.");
  return value.map((entry) => keyFrom(entry, false));
}

async function writeMap(
  options: ApiKeyRestoreHandlerOptions,
  sourceKeys: Key[],
  targetKeys: Key[],
  signal?: AbortSignal,
): Promise<void> {
  const targetByIdentity = new Map(
    targetKeys.map((key) => [identity(key), key]),
  );
  const entries = sourceKeys.map((sourceKey) => {
    const targetKey = targetByIdentity.get(identity(sourceKey));
    if (targetKey === undefined || targetKey.api_key.length < 4)
      fail(
        "Target did not reveal a generated API key for the protected rotation map.",
      );
    options.registerSecret(targetKey.api_key);
    return {
      source: {
        id: sourceKey.id,
        type: sourceKey.type,
        name: sourceKey.name,
        api_key: sourceKey.api_key,
      },
      target: {
        id: targetKey.id,
        type: targetKey.type,
        name: targetKey.name,
        api_key: targetKey.api_key,
      },
    };
  });
  const value = {
    schemaVersion: 1 as const,
    sourceFingerprint: fingerprint(sourceKeys),
    sourceProjectRef: options.sourceProjectRef,
    targetProjectRef: options.targetProjectRef,
    entries,
  };
  signal?.throwIfAborted();
  await writeFileAtomic(options.rotationMapPath, canonicalJson(value), {
    signal,
    mode: 0o600,
  });
}

export function createApiKeyRestoreHandler(
  options: ApiKeyRestoreHandlerOptions,
): RestoreActionHandler {
  const endpoint = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/api-keys`;
  return {
    async apply(context): Promise<RestoreActionResult> {
      if (
        context.action.artifacts.length !== 1 ||
        context.action.artifacts[0] !== ARTIFACT
      )
        fail("Modern API key restore requires secrets/api-keys.json.");
      const sourceKeys = await source(options);
      const sourceFingerprint = fingerprint(sourceKeys);
      const current = await target(options, context.signal);
      const currentIdentities = new Set(current.map(identity));
      if (
        sourceKeys.some(
          (key) =>
            !isPlatformGeneratedKey(key) &&
            currentIdentities.has(identity(key)),
        )
      )
        fail(
          "Target already has an API key with a source key identity.",
          "RESTORE_TARGET_CONFLICT",
        );
      if (
        sourceKeys.some(
          (key) =>
            isPlatformGeneratedKey(key) &&
            !currentIdentities.has(identity(key)),
        )
      )
        fail(
          "Target does not expose a generated API key required for the protected rotation map.",
        );
      for (const key of sourceKeys) {
        if (isPlatformGeneratedKey(key)) continue;
        await options.client.post(
          endpoint,
          {
            type: key.type,
            name: key.name,
            ...(key.description === undefined
              ? {}
              : { description: key.description }),
            ...(key.secret_jwt_template === undefined
              ? {}
              : { secret_jwt_template: key.secret_jwt_template }),
          },
          apiKeyContractSchema("CreateApiKeyBody"),
          apiKeyContractSchema("ApiKeyResponse"),
          {
            query: { reveal: "true" },
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
        );
      }
      await writeMap(
        options,
        sourceKeys,
        await target(options, context.signal),
        context.signal,
      );
      return { fingerprint: sourceFingerprint };
    },
    async verify(context): Promise<boolean> {
      const sourceKeys = await source(options);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== fingerprint(sourceKeys)
      )
        return false;
      try {
        const stat = await lstat(options.rotationMapPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304)
          return false;
        const map = rotationMapSchema.parse(
          JSON.parse(await readFile(options.rotationMapPath, "utf8")),
        );
        if (
          map.sourceFingerprint !== fingerprint(sourceKeys) ||
          map.sourceProjectRef !== options.sourceProjectRef ||
          map.targetProjectRef !== options.targetProjectRef
        )
          return false;
        const actual = await target(options, context.signal);
        const byId = new Map(actual.map((key) => [key.id, key]));
        return (
          map.entries.length === sourceKeys.length &&
          map.entries.every(
            ({ source: sourceKey, target: targetKey }) =>
              sourceKey.api_key.length >= 4 &&
              targetKey.api_key.length >= 4 &&
              byId.get(targetKey.id)?.type === targetKey.type &&
              byId.get(targetKey.id)?.name === targetKey.name,
          )
        );
      } catch {
        return false;
      }
    },
  };
}
