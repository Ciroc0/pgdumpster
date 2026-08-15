import type { Redactor } from "../../security/redactor.js";
import type { SecretValue } from "../../security/secret-value.js";
import type { ManagementClient } from "../../supabase/management/client.js";
import { createApiKeyRestoreHandler } from "./api-key-handler.js";
import { createAuthConfigRestoreHandler } from "./auth-config-handler.js";
import {
  createAuthSsoRestoreHandler,
  createAuthTpaRestoreHandler,
} from "./auth-provider-handlers.js";
import { createControlPlaneRestoreHandlers } from "./control-plane-handler.js";
import { createDatabaseRestoreHandlers } from "./database-handlers.js";
import { createDatabaseSupplementRestoreHandlers } from "./database-supplement-handlers.js";
import { createEdgeFunctionRestoreHandler } from "./edge-function-handler.js";
import type { RestoreActionHandler } from "./executor.js";
import { createFileStorageRestoreHandlers } from "./file-storage-handlers.js";
import { createLegacyApiKeyRestoreHandler } from "./legacy-api-key-handler.js";
import { createPublicationRestoreHandler } from "./publication-handler.js";
import { createVaultRootKeyRestoreHandler } from "./vault-root-key-handler.js";
import { createVectorStorageRestoreHandlers } from "./vector-storage-handlers.js";

export interface ProductRestoreHandlerOptions {
  bundleRoot: string;
  sourceProjectRef: string;
  targetProjectRef: string;
  targetDatabaseUrl: SecretValue;
  targetAccessToken: SecretValue;
  conflictPolicy: "fail" | "replace";
  rotationMapPath: string;
  management: ManagementClient;
  redactor: Redactor;
  storageKey?: SecretValue | undefined;
  fetch?: typeof fetch | undefined;
}

export function createProductRestoreHandlers(
  options: ProductRestoreHandlerOptions,
): Readonly<Record<string, RestoreActionHandler>> {
  const database = createDatabaseRestoreHandlers({
    bundleRoot: options.bundleRoot,
    targetDatabaseUrl: options.targetDatabaseUrl,
  });

  return {
    "database.extensions": database["database.extensions"]!,
    "database.roles": database["database.roles"]!,
    "database.schema": database["database.schema"]!,
    "database.data": database["database.data"]!,
    "auth.data": database["auth.data"]!,
    ...createDatabaseSupplementRestoreHandlers({
      bundleRoot: options.bundleRoot,
      targetDatabaseUrl: options.targetDatabaseUrl,
      conflictPolicy: options.conflictPolicy,
    }),
    "database.publications": createPublicationRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetDatabaseUrl: options.targetDatabaseUrl,
      conflictPolicy: options.conflictPolicy,
    }),
    "database.vault_root_key": createVaultRootKeyRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      targetDatabaseUrl: options.targetDatabaseUrl,
      client: options.management,
      redactor: options.redactor,
    }),
    ...createControlPlaneRestoreHandlers({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      conflictPolicy: options.conflictPolicy,
      client: options.management,
    }),
    ...(options.storageKey === undefined
      ? {}
      : {
          ...createFileStorageRestoreHandlers({
            bundleRoot: options.bundleRoot,
            targetProjectRef: options.targetProjectRef,
            targetDatabaseUrl: options.targetDatabaseUrl,
            storageKey: options.storageKey,
            conflictPolicy: options.conflictPolicy,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
          ...createVectorStorageRestoreHandlers({
            bundleRoot: options.bundleRoot,
            targetProjectRef: options.targetProjectRef,
            storageKey: options.storageKey,
            conflictPolicy: options.conflictPolicy,
          }),
        }),
    "edge.functions": createEdgeFunctionRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      accessToken: options.targetAccessToken,
      conflictPolicy: options.conflictPolicy,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    "auth.config": createAuthConfigRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      client: options.management,
    }),
    "auth.sso": createAuthSsoRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      conflictPolicy: options.conflictPolicy,
      client: options.management,
    }),
    "auth.tpa": createAuthTpaRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      conflictPolicy: options.conflictPolicy,
      client: options.management,
    }),
    "api.modern_keys": createApiKeyRestoreHandler({
      bundleRoot: options.bundleRoot,
      sourceProjectRef: options.sourceProjectRef,
      targetProjectRef: options.targetProjectRef,
      rotationMapPath: options.rotationMapPath,
      client: options.management,
      registerSecret: (value) => {
        options.redactor.register(value);
      },
    }),
    "api.legacy_keys_state": createLegacyApiKeyRestoreHandler({
      bundleRoot: options.bundleRoot,
      targetProjectRef: options.targetProjectRef,
      conflictPolicy: options.conflictPolicy,
      client: options.management,
    }),
  };
}
