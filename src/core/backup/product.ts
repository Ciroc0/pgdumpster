import path from "node:path";

import { StorageClient } from "@supabase/storage-js";

import {
  collectDatabaseCatalogState,
  collectLinkedDatabaseCatalogState,
  type DatabaseCatalogState,
} from "../../database/catalog-state.js";
import {
  dumpExcludedDatabaseState,
  dumpLogicalDatabase,
  dumpManagedSchemaCustomizations,
  dumpMigrationHistory,
  type DatabaseDumpArtifact,
  type DatabaseDumpOptions,
} from "../../database/dump.js";
import {
  collectDatabaseInventory,
  collectLinkedDatabaseInventory,
  type DatabaseInventory,
  type SchemaClassification,
} from "../../database/inventory.js";
import type { Redactor } from "../../security/redactor.js";
import type { SecretValue } from "../../security/secret-value.js";
import {
  collectFileStorageCatalog,
  collectLinkedFileStorageCatalog,
  type FileStorageCatalog,
} from "../../storage/catalog.js";
import { storageObjectEtag } from "../../storage/consistency.js";
import { downloadStorageObject } from "../../storage/download.js";
import { captureSpecializedStorage } from "../../storage/specialized.js";
import {
  captureApiKeys,
  discoverPrivilegedStorageKey,
} from "../../supabase/management/api-keys.js";
import { captureAuthControlPlane } from "../../supabase/management/auth.js";
import type { ManagementClient } from "../../supabase/management/client.js";
import { captureControlPlaneState } from "../../supabase/management/control-plane.js";
import { captureEdgeState } from "../../supabase/management/edge.js";
import { capturePlatformV2State } from "../../supabase/management/platform-v2.js";
import { captureProjectState } from "../../supabase/management/project-state.js";
import { captureVaultRootKey } from "../../supabase/management/vault-root-key.js";
import { mapBounded } from "../../utils/bounded-concurrency.js";
import { createDirectoryArtifactSink } from "../bundle/artifact-sink.js";
import type { CoverageDocument } from "../bundle/schemas.js";
import { PgDumpsterError } from "../errors/error.js";
import { createPlaintextProtectedArtifactSink } from "../../security/protected-artifact.js";
import { createDatabaseConsistencyAdapter } from "./database-consistency-adapter.js";
import { createEdgeConsistencyAdapter } from "./edge-consistency-adapter.js";
import { createFileStorageConsistencyAdapter } from "./file-storage-consistency-adapter.js";
import {
  createApiKeysConsistencyAdapter,
  createAuthConsistencyAdapter,
  createControlPlaneConsistencyAdapter,
  createPlatformV2ConsistencyAdapter,
  createProjectStateConsistencyAdapter,
} from "./management-consistency-adapters.js";
import { createSpecializedStorageConsistencyAdapter } from "./specialized-storage-consistency-adapter.js";
import { createVaultRootKeyConsistencyAdapter } from "./vault-root-key-consistency-adapter.js";
import {
  executeBackup,
  type BackupStep,
  type BackupStepResult,
} from "./coordinator.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface ProductBackupOptions {
  workspaceRoot: string;
  checkpointPath: string;
  runId: string;
  projectRef: string;
  immutableConfigSha256: string;
  toolVersion: string;
  startedAt: string;
  consistency: "verified" | "best-effort" | "quiesced";
  management: ManagementClient;
  redactor: Redactor;
  databaseUrl?: SecretValue | undefined;
  linked?: boolean | undefined;
  storageKey?: SecretValue | undefined;
  allowPlaintextSecrets: boolean;
  maxStorageConcurrency: number;
  maxApiConcurrency: number;
  resume?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

function coverageArtifacts(coverage: readonly CoverageEntry[]): string[] {
  return [...new Set(coverage.flatMap(({ artifacts }) => artifacts))];
}

function result(
  coverage: readonly CoverageEntry[],
  extra: readonly string[] = [],
): BackupStepResult {
  return {
    artifacts: [...new Set([...coverageArtifacts(coverage), ...extra])],
    coverage,
  };
}

function relativeArtifact(workspaceRoot: string, absolute: string): string {
  return path.relative(workspaceRoot, absolute).split(path.sep).join("/");
}

function hasSchema(
  inventory: DatabaseInventory,
  classification: SchemaClassification,
): boolean {
  return inventory.schemas.some(
    (schema) => schema.classification === classification,
  );
}

function dumpPaths(
  workspaceRoot: string,
  dumps: readonly DatabaseDumpArtifact[],
  id: DatabaseDumpArtifact["id"],
): string[] {
  return dumps
    .filter((dump) => dump.id === id)
    .map((dump) => relativeArtifact(workspaceRoot, dump.path));
}

function databaseCoverage(
  inventory: DatabaseInventory,
  catalog: DatabaseCatalogState,
  dumps: readonly DatabaseDumpArtifact[],
  workspaceRoot: string,
): CoverageEntry[] {
  const metadata = "database/metadata.json";
  const catalogArtifact = "database/catalog-state.json";
  const base = (
    id: "database.roles" | "database.schema" | "database.data",
    sensitivity: CoverageEntry["sensitivity"],
  ): CoverageEntry => ({
    id,
    status: "backed_up",
    sensitivity,
    artifacts: dumpPaths(workspaceRoot, dumps, id),
    sourceContract: { adapter: "supabase-cli-db-dump", mode: "logical" },
  });
  const specializedDump = (
    id:
      "auth.data" | "database.cron" | "database.queues" | "database.vault_data",
    dumpId: DatabaseDumpArtifact["id"],
    classification: SchemaClassification,
    sensitivity: CoverageEntry["sensitivity"],
  ): CoverageEntry => {
    const artifacts = dumpPaths(workspaceRoot, dumps, dumpId);
    return {
      id,
      status: hasSchema(inventory, classification)
        ? "backed_up"
        : "not_configured",
      sensitivity,
      artifacts: hasSchema(inventory, classification) ? artifacts : [metadata],
      sourceContract: { adapter: "supabase-cli-dedicated-schema-dump" },
    };
  };
  const vaultArtifacts = dumpPaths(workspaceRoot, dumps, "database.vault_data");
  const migrationArtifacts = [
    ...dumpPaths(workspaceRoot, dumps, "database.migrations_schema"),
    ...dumpPaths(workspaceRoot, dumps, "database.migrations_data"),
  ];
  const customizationArtifacts = [
    ...dumpPaths(workspaceRoot, dumps, "database.auth_storage_customizations"),
  ];
  return [
    base("database.roles", "sensitive"),
    base("database.schema", "sensitive"),
    base("database.data", "secret"),
    {
      id: "database.migrations",
      status: hasSchema(inventory, "migration_history")
        ? "backed_up"
        : "not_configured",
      sensitivity: "internal",
      artifacts: hasSchema(inventory, "migration_history")
        ? migrationArtifacts
        : [metadata],
      sourceContract: { adapter: "supabase-cli-migration-history-dump" },
    },
    {
      id: "database.auth_storage_customizations",
      status:
        customizationArtifacts.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "sensitive",
      artifacts:
        customizationArtifacts.length === 0
          ? [metadata]
          : customizationArtifacts,
      sourceContract: {
        adapter: "supabase-cli-managed-schema-diff",
        schemas: ["auth", "storage"],
      },
    },
    {
      id: "database.extensions",
      status:
        inventory.extensions.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "internal",
      artifacts: [metadata],
      children: inventory.extensions.map((extension) => ({
        ...extension,
        status: "backed_up",
      })),
      sourceContract: { adapter: "postgres-catalog-inventory" },
    },
    {
      id: "database.extension_state",
      status: "not_configured",
      sensitivity: "secret",
      artifacts: [metadata],
      message:
        "No unclassified persistent extension-owned schema was discovered; dedicated extension state is reported separately.",
      sourceContract: { adapter: "postgres-extension-state-discovery" },
    },
    specializedDump("database.cron", "database.cron", "cron", "sensitive"),
    specializedDump("database.queues", "database.queues", "queues", "secret"),
    {
      id: "database.webhooks",
      status: catalog.webhooks.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "sensitive",
      artifacts: [catalogArtifact],
      sourceContract: { adapter: "postgres-webhook-trigger-catalog" },
    },
    {
      id: "database.vault_data",
      status:
        (inventory.vaultSecretCount ?? 0) > 0 ? "backed_up" : "not_configured",
      sensitivity: "secret",
      artifacts:
        (inventory.vaultSecretCount ?? 0) > 0 ? vaultArtifacts : [metadata],
      sourceContract: {
        adapter: "supabase-cli-dedicated-schema-dump",
        captureFidelity: "exact_ciphertext_rows",
        restoreFidelity: "not_identically_restorable",
        restoreReason: "target_postgres_lacks_vault_secrets_insert_privilege",
      },
    },
    {
      id: "database.publications",
      status:
        catalog.publications.length === 0 ? "not_configured" : "backed_up",
      sensitivity: "internal",
      artifacts: [catalogArtifact],
      sourceContract: { adapter: "postgres-publication-catalog" },
    },
    specializedDump("auth.data", "auth.data", "auth_data", "secret"),
  ];
}

async function databaseStep(
  options: ProductBackupOptions,
  signal?: AbortSignal,
): Promise<BackupStepResult> {
  const direct = options.databaseUrl;
  const dumpOptions: DatabaseDumpOptions = {
    outputDirectory: options.workspaceRoot,
    ...(direct === undefined ? { linked: true } : { connectionString: direct }),
    ...(signal === undefined ? {} : { signal }),
  };
  const inventory =
    direct === undefined
      ? await collectLinkedDatabaseInventory(options.workspaceRoot, signal)
      : await collectDatabaseInventory(direct, options.workspaceRoot, signal);
  const catalog =
    direct === undefined
      ? await collectLinkedDatabaseCatalogState(options.workspaceRoot, signal)
      : await collectDatabaseCatalogState(
          direct,
          options.workspaceRoot,
          signal,
        );
  const dumps = [
    ...(await dumpLogicalDatabase(dumpOptions, inventory)),
    ...(await dumpMigrationHistory(dumpOptions, inventory)),
    ...(await dumpManagedSchemaCustomizations(dumpOptions, inventory)),
    ...(await dumpExcludedDatabaseState(dumpOptions, inventory)),
  ];
  const coverage = databaseCoverage(
    inventory,
    catalog,
    dumps,
    options.workspaceRoot,
  );
  return result(coverage, [
    "database/metadata.json",
    "database/catalog-state.json",
    ...dumps.map((dump) => relativeArtifact(options.workspaceRoot, dump.path)),
  ]);
}

async function fileStorageStep(
  options: ProductBackupOptions,
  storageKey: SecretValue,
  protectedSink: Awaited<
    ReturnType<typeof createPlaintextProtectedArtifactSink>
  >,
  signal?: AbortSignal,
): Promise<BackupStepResult> {
  const catalog: FileStorageCatalog =
    options.databaseUrl === undefined
      ? await collectLinkedFileStorageCatalog(options.workspaceRoot, signal)
      : await collectFileStorageCatalog(
          options.databaseUrl,
          options.workspaceRoot,
          signal,
        );
  const downloaded = await mapBounded(
    catalog.objects,
    options.maxStorageConcurrency,
    (object, _index, workerSignal) =>
      downloadStorageObject(
        {
          bucket: object.bucket,
          name: object.name,
          ...(object.expectedBytes === null
            ? {}
            : { expectedBytes: object.expectedBytes }),
          version: object.version,
          updatedAt: object.updatedAt,
          etag: storageObjectEtag(object.metadata),
        },
        {
          projectRef: options.projectRef,
          storageKey,
          outputDirectory: options.workspaceRoot,
          signal: workerSignal,
        },
      ),
    signal,
  );
  const indexArtifact = "secrets/storage/file-object-index.json";
  await protectedSink.writeJson(
    indexArtifact,
    { schemaVersion: 1, objects: downloaded },
    signal,
  );
  const catalogArtifact = "storage/file-catalog.json";
  const metadataDump = "database/storage-metadata.sql";
  const hasBuckets = catalog.buckets.length > 0;
  const coverage: CoverageEntry[] = [
    {
      id: "storage.file_buckets",
      status: hasBuckets ? "backed_up" : "not_configured",
      sensitivity: "sensitive",
      artifacts: [catalogArtifact],
      sourceContract: { adapter: "postgres-storage-catalog" },
    },
    {
      id: "storage.file_objects",
      status: hasBuckets ? "backed_up" : "not_configured",
      sensitivity: "secret",
      artifacts: [
        indexArtifact,
        ...downloaded.map(({ path: objectPath }) => objectPath),
      ],
      sourceContract: { adapter: "storage-authenticated-object-download" },
    },
    {
      id: "storage.file_metadata",
      status: hasBuckets ? "backed_up" : "not_configured",
      sensitivity: "sensitive",
      artifacts: [catalogArtifact, metadataDump],
      sourceContract: { adapter: "postgres-storage-metadata-dump-and-catalog" },
    },
  ];
  return result(coverage);
}

export async function executeProductBackup(options: ProductBackupOptions) {
  if ((options.databaseUrl === undefined) === (options.linked !== true)) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message:
        "Backup requires exactly one database source mode: --linked or an explicit database URL environment variable.",
      retryable: false,
    });
  }
  const ordinary = await createDirectoryArtifactSink(options.workspaceRoot);
  const protectedSink = await createPlaintextProtectedArtifactSink(
    options.workspaceRoot,
    {
      allowPlaintextSecrets: options.allowPlaintextSecrets,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const storageKey =
    options.storageKey ??
    (await discoverPrivilegedStorageKey(
      options.management,
      options.projectRef,
      options.redactor,
      options.signal,
    ));
  if (storageKey === undefined) {
    throw new Error(
      "No revealed privileged project API key is available for complete Storage capture.",
    );
  }
  const storage = new StorageClient(
    `https://${options.projectRef}.supabase.co/storage/v1`,
    {
      apikey: storageKey.expose(),
      authorization: `Bearer ${storageKey.expose()}`,
    },
  );
  const steps: BackupStep[] = [
    {
      id: "database",
      run: ({ signal }) => databaseStep(options, signal),
      consistency: createDatabaseConsistencyAdapter(options),
    },
    {
      id: "project-state",
      run: async ({ signal }) => {
        const captured = await captureProjectState(
          options.management,
          options.projectRef,
          ordinary,
          signal,
        );
        return result(captured.coverage);
      },
      consistency: createProjectStateConsistencyAdapter(options),
    },
    {
      id: "control-plane",
      run: async ({ signal }) => {
        const captured = await captureControlPlaneState(
          options.management,
          options.projectRef,
          ordinary,
          protectedSink,
          options.redactor,
          signal,
        );
        const customDomain = captured.coverage.find(
          ({ id }) => id === "domains.custom_hostname",
        );
        const dns: CoverageEntry =
          customDomain?.status === "backed_up"
            ? {
                id: "external.dns",
                status: "not_exportable",
                reasonCode: "external_dns_records_require_manual_restore",
                sensitivity: "internal",
                artifacts: customDomain.artifacts,
                sourceContract: customDomain.sourceContract,
              }
            : {
                id: "external.dns",
                status: "not_configured",
                sensitivity: "internal",
                artifacts: customDomain?.artifacts ?? [],
                sourceContract: customDomain?.sourceContract,
              };
        return result([...captured.coverage, dns]);
      },
      consistency: createControlPlaneConsistencyAdapter(options),
    },
    {
      id: "platform-v2",
      run: async ({ signal }) => {
        const captured = await capturePlatformV2State(
          options.management,
          options.projectRef,
          ordinary,
          protectedSink,
          options.redactor,
          signal,
        );
        return result(captured.coverage);
      },
      consistency: createPlatformV2ConsistencyAdapter(options),
    },
    {
      id: "auth",
      run: async ({ signal }) => {
        const captured = await captureAuthControlPlane(
          options.management,
          options.projectRef,
          options.redactor,
          protectedSink,
          signal,
        );
        return result(captured.coverage);
      },
      consistency: createAuthConsistencyAdapter(options),
    },
    {
      id: "api-keys",
      run: async ({ signal }) => {
        const captured = await captureApiKeys(
          options.management,
          options.projectRef,
          options.redactor,
          protectedSink,
          signal,
        );
        return result(captured.coverage);
      },
      consistency: createApiKeysConsistencyAdapter(options),
    },
    {
      id: "edge",
      run: async ({ signal }) => {
        const captured = await captureEdgeState(
          options.management,
          options.projectRef,
          protectedSink,
          ordinary,
          { maxConcurrency: options.maxApiConcurrency, signal },
        );
        return result(captured.coverage);
      },
      consistency: createEdgeConsistencyAdapter(options),
    },
    {
      id: "vault-root-key",
      run: async ({ signal }) => {
        const captured = await captureVaultRootKey(
          options.management,
          options.projectRef,
          options.redactor,
          protectedSink,
          signal,
        );
        return result([captured.coverage]);
      },
      consistency: createVaultRootKeyConsistencyAdapter(options),
    },
    {
      id: "file-storage",
      run: ({ signal }) =>
        fileStorageStep(options, storageKey, protectedSink, signal),
      consistency: createFileStorageConsistencyAdapter(options),
    },
    {
      id: "specialized-storage",
      run: async ({ signal }) => {
        const captured = await captureSpecializedStorage(
          storage,
          ordinary,
          protectedSink,
          signal,
        );
        return result(captured.coverage);
      },
      consistency: createSpecializedStorageConsistencyAdapter({ storage }),
    },
  ];
  return executeBackup({
    workspaceRoot: options.workspaceRoot,
    checkpointPath: options.checkpointPath,
    runId: options.runId,
    projectRef: options.projectRef,
    immutableConfigSha256: options.immutableConfigSha256,
    toolVersion: options.toolVersion,
    startedAt: options.startedAt,
    consistency: options.consistency,
    steps,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
