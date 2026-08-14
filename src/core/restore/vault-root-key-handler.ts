import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import pg from "pg";
import { z } from "zod";

import { PgDumpsterError } from "../errors/error.js";
import type { Redactor } from "../../security/redactor.js";
import { SecretValue } from "../../security/secret-value.js";
import type { ManagementClient } from "../../supabase/management/client.js";
import { VAULT_ROOT_KEY_ARTIFACT } from "../../supabase/management/vault-root-key.js";
import type { RestoreActionHandler } from "./executor.js";
import { resolveBundleArtifact } from "./database-handlers.js";

const { Client } = pg;

const rootKeySchema = z
  .object({ root_key: z.string().regex(/^[a-fA-F0-9]{64}$/u) })
  .passthrough();
const rootKeyBodySchema = z
  .object({ root_key: z.string().regex(/^[a-fA-F0-9]{64}$/u) })
  .strict();
const rootKeyArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal("pgsodium-root-key-32-byte-hex"),
    rootKey: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  })
  .strict();
const vaultEmptyRowSchema = z.object({ empty: z.boolean() }).passthrough();

interface VaultSafetyClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface VaultRootKeyRestoreHandlerOptions {
  bundleRoot: string;
  targetProjectRef: string;
  targetDatabaseUrl: SecretValue;
  client: Pick<ManagementClient, "get" | "put">;
  redactor: Redactor;
  createDatabaseClient?:
    ((connectionString: string) => VaultSafetyClient) | undefined;
}

function sameRootKey(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rootKeyFingerprint(rootKey: string): string {
  return createHash("sha256")
    .update("pgdumpster-vault-root-key-v1\0")
    .update(Buffer.from(rootKey, "hex"))
    .digest("hex");
}

async function readRootKey(options: VaultRootKeyRestoreHandlerOptions) {
  const filename = await resolveBundleArtifact(
    options.bundleRoot,
    VAULT_ROOT_KEY_ARTIFACT,
  );
  const fileStat = await lstat(filename);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.size > 16_384
  ) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Vault root-key artifact is not a bounded regular file.",
      retryable: false,
      component: "database.vault_root_key",
    });
  }
  try {
    const artifact = rootKeyArtifactSchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
    return new SecretValue(artifact.rootKey.toLowerCase(), options.redactor);
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Vault root-key artifact is invalid.",
      retryable: false,
      component: "database.vault_root_key",
      cause: error,
    });
  }
}

async function targetVaultIsEmpty(
  options: VaultRootKeyRestoreHandlerOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  const client =
    options.createDatabaseClient?.(options.targetDatabaseUrl.expose()) ??
    new Client({
      connectionString: options.targetDatabaseUrl.expose(),
      application_name: "pgdumpster-vault-root-key-safety",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
    });
  try {
    signal?.throwIfAborted();
    await client.connect();
    const result = await client.query(
      "select not exists (select 1 from vault.secrets) as empty",
    );
    return vaultEmptyRowSchema.parse(result.rows[0]).empty;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "VAULT_ROOT_KEY_SAFETY_CHECK_FAILED",
      category: "database",
      message:
        "Target Vault emptiness could not be proven before key replacement.",
      retryable: false,
      component: "database.vault_root_key",
      cause: error,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function createVaultRootKeyRestoreHandler(
  options: VaultRootKeyRestoreHandlerOptions,
): RestoreActionHandler {
  const endpoint = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/pgsodium`;
  return {
    async apply(context) {
      const source = await readRootKey(options);
      const currentResponse = await options.client.get(
        endpoint,
        rootKeySchema,
        {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        },
      );
      const current = new SecretValue(
        currentResponse.root_key.toLowerCase(),
        options.redactor,
      );
      if (!sameRootKey(source.expose(), current.expose())) {
        if (!(await targetVaultIsEmpty(options, context.signal))) {
          throw new PgDumpsterError({
            code: "VAULT_ROOT_KEY_TARGET_NOT_EMPTY",
            category: "restore_policy",
            message:
              "Target Vault contains encrypted data; root-key replacement is refused.",
            retryable: false,
            component: "database.vault_root_key",
          });
        }
        const updated = await options.client.put(
          endpoint,
          { root_key: source.expose() },
          rootKeyBodySchema,
          rootKeySchema,
          context.signal === undefined ? {} : { signal: context.signal },
        );
        new SecretValue(updated.root_key, options.redactor);
        if (!sameRootKey(source.expose(), updated.root_key)) {
          throw new PgDumpsterError({
            code: "VAULT_ROOT_KEY_RESTORE_FAILED",
            category: "consistency",
            message:
              "Management API did not confirm the requested Vault root key.",
            retryable: false,
            component: "database.vault_root_key",
          });
        }
      }
      return { fingerprint: rootKeyFingerprint(source.expose()) };
    },

    async verify(context) {
      const source = await readRootKey(options);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== rootKeyFingerprint(source.expose())
      )
        return false;
      const current = await options.client.get(endpoint, rootKeySchema, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      new SecretValue(current.root_key, options.redactor);
      return sameRootKey(source.expose(), current.root_key);
    },
  };
}
