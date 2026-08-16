import { describe, expect, it } from "vitest";

import {
  coverageDocumentSchema,
  manifestSchema,
} from "../../src/core/bundle/schemas.js";
import {
  AUTOMATIC_RESTORE_COMPONENTS,
  requiresDatabaseRestoreCredential,
  requiresManagementRestoreCredential,
  requiresStorageRestoreCredential,
  supportsAutomaticRestore,
} from "../../src/core/restore/capabilities.js";
import { createApiKeyRestoreHandler } from "../../src/core/restore/api-key-handler.js";
import { createAuthConfigRestoreHandler } from "../../src/core/restore/auth-config-handler.js";
import {
  createAuthSsoRestoreHandler,
  createAuthTpaRestoreHandler,
} from "../../src/core/restore/auth-provider-handlers.js";
import { createControlPlaneRestoreHandlers } from "../../src/core/restore/control-plane-handler.js";
import { createDatabaseRestoreHandlers } from "../../src/core/restore/database-handlers.js";
import { createDatabaseSupplementRestoreHandlers } from "../../src/core/restore/database-supplement-handlers.js";
import { createEdgeFunctionRestoreHandler } from "../../src/core/restore/edge-function-handler.js";
import { createFileStorageRestoreHandlers } from "../../src/core/restore/file-storage-handlers.js";
import { createLegacyApiKeyRestoreHandler } from "../../src/core/restore/legacy-api-key-handler.js";
import { buildRestorePlan } from "../../src/core/restore/plan.js";
import { createPublicationRestoreHandler } from "../../src/core/restore/publication-handler.js";
import { createVaultRootKeyRestoreHandler } from "../../src/core/restore/vault-root-key-handler.js";
import { createVectorStorageRestoreHandlers } from "../../src/core/restore/vector-storage-handlers.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";

const sourceProjectRef = "abcdefghijklmnopqrst";
const targetProjectRef = "zyxwvutsrqponmlkjihg";

async function sourceWith(
  backedUp: readonly string[],
  sourceContracts: Readonly<Record<string, Record<string, unknown>>> = {},
) {
  const registry = await loadCoverageRegistry();
  const backedUpSet = new Set(backedUp);
  const coverage = coverageDocumentSchema.parse({
    formatVersion: "1.0.0",
    components: registry.components.map((component) => ({
      id: component.id,
      status: backedUpSet.has(component.id) ? "backed_up" : "not_configured",
      sensitivity: component.sensitivity,
      artifacts: backedUpSet.has(component.id)
        ? [`payload/${component.id}.json`]
        : [],
      ...(sourceContracts[component.id] === undefined
        ? {}
        : { sourceContract: sourceContracts[component.id] }),
    })),
  });
  const manifest = manifestSchema.parse({
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: "0.0.0-test" },
    operation: {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-16T00:00:00.000Z",
      completedAt: "2026-08-16T00:01:00.000Z",
    },
    source: { projectRef: sourceProjectRef },
    result: { status: "complete", consistency: "verified" },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    checksumFileSha256: "0".repeat(64),
    components: coverage.components.map(({ id, status }) => ({ id, status })),
    statistics: { files: 1, bytes: 1 },
  });
  return { manifest, coverage };
}

async function planFor(
  backedUp: readonly string[],
  allowBillableResources = true,
) {
  const source = await sourceWith(backedUp);
  return buildRestorePlan(source.manifest, source.coverage, {
    planId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-08-16T00:02:00.000Z",
    targetProjectRef,
    conflictPolicy: "fail",
    allowBillableResources,
  });
}

function constructedHandlers() {
  const redactor = new Redactor();
  const targetDatabaseUrl = new SecretValue(
    "postgresql://postgres:secret@example.invalid/postgres",
    redactor,
  );
  const accessToken = new SecretValue("management-access-token", redactor);
  const storageKey = new SecretValue("service-role-test-key", redactor);
  const management = {} as ManagementClient;
  const bundleRoot = "/verified-bundle";
  const conflictPolicy = "fail" as const;
  const database = createDatabaseRestoreHandlers({
    bundleRoot,
    targetDatabaseUrl,
  });
  return {
    ...database,
    ...createDatabaseSupplementRestoreHandlers({
      bundleRoot,
      targetDatabaseUrl,
      conflictPolicy,
    }),
    "database.publications": createPublicationRestoreHandler({
      bundleRoot,
      targetDatabaseUrl,
      conflictPolicy,
    }),
    "database.vault_root_key": createVaultRootKeyRestoreHandler({
      bundleRoot,
      targetProjectRef,
      targetDatabaseUrl,
      client: management,
      redactor,
    }),
    ...createControlPlaneRestoreHandlers({
      bundleRoot,
      targetProjectRef,
      conflictPolicy,
      client: management,
    }),
    ...createFileStorageRestoreHandlers({
      bundleRoot,
      targetProjectRef,
      targetDatabaseUrl,
      storageKey,
      conflictPolicy,
    }),
    ...createVectorStorageRestoreHandlers({
      bundleRoot,
      targetProjectRef,
      storageKey,
      conflictPolicy,
    }),
    "edge.functions": createEdgeFunctionRestoreHandler({
      bundleRoot,
      targetProjectRef,
      accessToken,
      conflictPolicy,
    }),
    "auth.config": createAuthConfigRestoreHandler({
      bundleRoot,
      targetProjectRef,
      client: management,
    }),
    "auth.sso": createAuthSsoRestoreHandler({
      bundleRoot,
      targetProjectRef,
      conflictPolicy,
      client: management,
    }),
    "auth.tpa": createAuthTpaRestoreHandler({
      bundleRoot,
      targetProjectRef,
      conflictPolicy,
      client: management,
    }),
    "api.modern_keys": createApiKeyRestoreHandler({
      bundleRoot,
      sourceProjectRef,
      targetProjectRef,
      rotationMapPath: "/protected/api-key-rotation.json",
      client: management,
      registerSecret: () => undefined,
    }),
    "api.legacy_keys_state": createLegacyApiKeyRestoreHandler({
      bundleRoot,
      targetProjectRef,
      conflictPolicy,
      client: management,
    }),
  };
}

describe("restore capability boundary", () => {
  it("never trusts missing source fidelity metadata to invent automatic restore support", async () => {
    const plan = await planFor(["project.addons", "database.vault_data"]);

    expect(
      plan.actions.find(({ component }) => component === "project.addons"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      fidelity: "manual",
      reasonCode: "automatic_restore_not_supported",
    });
    expect(
      plan.actions.find(({ component }) => component === "database.vault_data"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      fidelity: "manual",
      reasonCode: "automatic_restore_not_supported",
    });
    expect(plan.status).toBe("ready_with_platform_limits");
  });

  it("keeps unsupported billable work policy-blocked until explicit opt-in", async () => {
    const plan = await planFor(["project.addons"], false);

    expect(
      plan.actions.find(({ component }) => component === "project.addons"),
    ).toMatchObject({
      status: "blocked_by_policy",
      reasonCode: "billable_resource_opt_in_required",
    });
    expect(plan.status).toBe("blocked");
  });

  it("classifies Edge Functions as manual when no deployable source adapter exists", async () => {
    const plan = await planFor(["edge.secrets", "edge.functions"]);

    expect(
      plan.actions.find(({ component }) => component === "edge.secrets"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      reasonCode: "automatic_restore_not_supported",
    });
    expect(
      plan.actions.find(({ component }) => component === "edge.functions"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      reasonCode: "automatic_restore_not_supported",
    });
  });

  it("continues to plan an explicitly supported automatic component", async () => {
    const plan = await planFor(["database.postgres_config"]);

    expect(
      plan.actions.find(
        ({ component }) => component === "database.postgres_config",
      ),
    ).toMatchObject({ status: "planned" });
  });

  it("declares target Storage credential requirements only for automatic Storage handlers", () => {
    const credentialComponents = AUTOMATIC_RESTORE_COMPONENTS.filter(
      requiresStorageRestoreCredential,
    );

    expect(credentialComponents).toEqual([
      "storage.file_buckets",
      "storage.file_objects",
      "storage.file_metadata",
      "storage.vector_buckets",
      "storage.vector_indexes",
      "storage.vectors",
    ]);
  });

  it("declares Database and Management credential requirements for their handler capabilities", () => {
    expect(
      AUTOMATIC_RESTORE_COMPONENTS.filter(requiresDatabaseRestoreCredential),
    ).toEqual([
      "database.extensions",
      "database.roles",
      "database.schema",
      "database.data",
      "auth.data",
      "database.cron",
      "database.queues",
      "database.webhooks",
      "database.migrations",
      "database.auth_storage_customizations",
      "database.publications",
      "storage.file_buckets",
      "storage.file_objects",
      "storage.file_metadata",
      "database.vault_root_key",
    ]);
    expect(
      AUTOMATIC_RESTORE_COMPONENTS.filter(requiresManagementRestoreCredential),
    ).toEqual([
      "storage.service_config",
      "storage.file_buckets",
      "storage.file_objects",
      "storage.file_metadata",
      "storage.vector_buckets",
      "storage.vector_indexes",
      "storage.vectors",
      "auth.config",
      "auth.sso",
      "auth.tpa",
      "api.modern_keys",
      "api.legacy_keys_state",
      "database.postgres_config",
      "database.pooler",
      "database.ssl",
      "realtime.config",
      "rest.postgrest_config",
      "network.restrictions",
      "database.vault_root_key",
    ]);
  });

  it("has a constructed handler for every automatic restore capability", () => {
    const handlers: Readonly<Record<string, unknown>> = constructedHandlers();
    const missing = AUTOMATIC_RESTORE_COMPONENTS.filter(
      (component) => handlers[component] === undefined,
    );
    const dormant = Object.keys(handlers)
      .filter((component) => !supportsAutomaticRestore(component))
      .sort();

    expect(missing).toEqual([]);
    expect(dormant).toEqual(["database.vault_data", "edge.functions"]);
  });
});
