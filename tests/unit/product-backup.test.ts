import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/backup/coordinator.js", () => ({
  executeBackup: vi.fn(),
}));

vi.mock("../../src/database/catalog-state.js", () => ({
  collectDatabaseCatalogState: vi.fn(),
  collectLinkedDatabaseCatalogState: vi.fn(),
}));

vi.mock("../../src/database/dump.js", () => ({
  dumpExcludedDatabaseState: vi.fn(),
  dumpLogicalDatabase: vi.fn(),
  dumpManagedSchemaCustomizations: vi.fn(),
  dumpMigrationHistory: vi.fn(),
}));

vi.mock("../../src/database/inventory.js", () => ({
  collectDatabaseInventory: vi.fn(),
  collectLinkedDatabaseInventory: vi.fn(),
}));

vi.mock("../../src/storage/catalog.js", () => ({
  collectFileStorageCatalog: vi.fn(),
  collectLinkedFileStorageCatalog: vi.fn(),
}));

vi.mock("../../src/storage/download.js", () => ({
  downloadStorageObject: vi.fn(),
}));

vi.mock("../../src/storage/specialized.js", () => ({
  captureSpecializedStorage: vi.fn(),
}));

vi.mock("../../src/supabase/management/api-keys.js", () => ({
  captureApiKeys: vi.fn(),
  discoverPrivilegedStorageKey: vi.fn(),
}));

vi.mock("../../src/supabase/management/auth.js", () => ({
  captureAuthControlPlane: vi.fn(),
}));

vi.mock("../../src/supabase/management/control-plane.js", () => ({
  captureControlPlaneState: vi.fn(),
}));

vi.mock("../../src/supabase/management/edge.js", () => ({
  captureEdgeState: vi.fn(),
}));

vi.mock("../../src/supabase/management/platform-v2.js", () => ({
  capturePlatformV2State: vi.fn(),
}));

vi.mock("../../src/supabase/management/project-state.js", () => ({
  captureProjectState: vi.fn(),
}));

vi.mock("../../src/supabase/management/vault-root-key.js", () => ({
  captureVaultRootKey: vi.fn(),
}));

import {
  executeBackup,
  type BackupStepResult,
  type ExecuteBackupOptions,
} from "../../src/core/backup/coordinator.js";
import {
  executeProductBackup,
  type ProductBackupOptions,
} from "../../src/core/backup/product.js";
import {
  collectDatabaseCatalogState,
  collectLinkedDatabaseCatalogState,
  type DatabaseCatalogState,
} from "../../src/database/catalog-state.js";
import {
  dumpExcludedDatabaseState,
  dumpLogicalDatabase,
  dumpManagedSchemaCustomizations,
  dumpMigrationHistory,
  type DatabaseDumpArtifact,
} from "../../src/database/dump.js";
import {
  collectDatabaseInventory,
  collectLinkedDatabaseInventory,
  type DatabaseInventory,
} from "../../src/database/inventory.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import {
  collectFileStorageCatalog,
  collectLinkedFileStorageCatalog,
  type FileStorageCatalog,
} from "../../src/storage/catalog.js";
import { downloadStorageObject } from "../../src/storage/download.js";
import { captureSpecializedStorage } from "../../src/storage/specialized.js";
import {
  captureApiKeys,
  discoverPrivilegedStorageKey,
} from "../../src/supabase/management/api-keys.js";
import { captureAuthControlPlane } from "../../src/supabase/management/auth.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";
import { captureControlPlaneState } from "../../src/supabase/management/control-plane.js";
import { captureEdgeState } from "../../src/supabase/management/edge.js";
import { capturePlatformV2State } from "../../src/supabase/management/platform-v2.js";
import { captureProjectState } from "../../src/supabase/management/project-state.js";
import { captureVaultRootKey } from "../../src/supabase/management/vault-root-key.js";

const temporaryDirectories: string[] = [];
const STOP = "stop-before-finalization";

let capturedExecution: ExecuteBackupOptions | undefined;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  capturedExecution = undefined;

  vi.mocked(executeBackup).mockImplementation((options) => {
    capturedExecution = options;
    return Promise.reject(new Error(STOP));
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-product-backup-"));
  temporaryDirectories.push(root);
  return root;
}

function baseOptions(
  root: string,
  redactor: Redactor,
): Omit<ProductBackupOptions, "databaseUrl" | "linked" | "storageKey"> {
  return {
    workspaceRoot: root,
    checkpointPath: path.join(root, "checkpoint.json"),
    runId: "product-backup-test-run",
    projectRef: "abcdefghijklmnopqrst",
    immutableConfigSha256: "a".repeat(64),
    toolVersion: "0.0.0-test",
    startedAt: "2026-08-14T20:00:00.000Z",
    consistency: "verified",
    management: {} as ManagementClient,
    redactor,
    allowPlaintextSecrets: true,
    maxStorageConcurrency: 2,
    maxApiConcurrency: 2,
  };
}

function coverage(
  id: string,
  status: "backed_up" | "not_configured" = "backed_up",
  artifacts: string[] = [],
) {
  return {
    id,
    status,
    sensitivity: "internal",
    artifacts,
    sourceContract: { adapter: "test-fixture" },
  };
}

function configureCaptureMocks(customDomain: boolean): void {
  vi.mocked(captureProjectState).mockResolvedValue({
    coverage: [coverage("project.metadata")],
  } as never);

  vi.mocked(captureControlPlaneState).mockResolvedValue({
    coverage: [
      coverage("realtime.config"),
      ...(customDomain
        ? [coverage("domains.custom_hostname", "backed_up", ["domain.json"])]
        : []),
    ],
  } as never);

  vi.mocked(capturePlatformV2State).mockResolvedValue({
    coverage: [coverage("network.privatelink", "not_configured")],
  } as never);

  vi.mocked(captureAuthControlPlane).mockResolvedValue({
    coverage: [coverage("auth.config")],
  } as never);

  vi.mocked(captureApiKeys).mockResolvedValue({
    coverage: [coverage("api.keys")],
  } as never);

  vi.mocked(captureEdgeState).mockResolvedValue({
    coverage: [coverage("edge.functions")],
  } as never);

  vi.mocked(captureVaultRootKey).mockResolvedValue({
    coverage: coverage("database.vault_root_key"),
  } as never);

  vi.mocked(captureSpecializedStorage).mockResolvedValue({
    coverage: [coverage("storage.vector", "not_configured")],
  } as never);
}

function configureDumps(root: string, rich: boolean): void {
  const logical: DatabaseDumpArtifact[] = [
    {
      id: "database.roles",
      path: path.join(root, "database", "roles.sql"),
      bytes: 1,
    },
    {
      id: "database.schema",
      path: path.join(root, "database", "schema.sql"),
      bytes: 1,
    },
    {
      id: "database.data",
      path: path.join(root, "database", "data.sql"),
      bytes: 1,
    },
  ];

  const migrations: DatabaseDumpArtifact[] = rich
    ? [
        {
          id: "database.migrations_schema",
          path: path.join(root, "database", "migrations-schema.sql"),
          bytes: 1,
        },
        {
          id: "database.migrations_data",
          path: path.join(root, "database", "migrations-data.sql"),
          bytes: 1,
        },
      ]
    : [];

  const customizations: DatabaseDumpArtifact[] = rich
    ? [
        {
          id: "database.auth_storage_customizations",
          path: path.join(root, "database", "managed-schema-diff.sql"),
          bytes: 1,
        },
      ]
    : [];

  const excluded: DatabaseDumpArtifact[] = rich
    ? [
        {
          id: "auth.data",
          path: path.join(root, "database", "auth-data.sql"),
          bytes: 1,
        },
        {
          id: "storage.file_metadata",
          path: path.join(root, "database", "storage-metadata.sql"),
          bytes: 1,
        },
        {
          id: "database.cron",
          path: path.join(root, "database", "cron.sql"),
          bytes: 1,
        },
        {
          id: "database.queues",
          path: path.join(root, "database", "queues.sql"),
          bytes: 1,
        },
        {
          id: "database.vault_data",
          path: path.join(root, "database", "vault.sql"),
          bytes: 1,
        },
      ]
    : [];

  vi.mocked(dumpLogicalDatabase).mockResolvedValue(logical);
  vi.mocked(dumpMigrationHistory).mockResolvedValue(migrations);
  vi.mocked(dumpManagedSchemaCustomizations).mockResolvedValue(customizations);
  vi.mocked(dumpExcludedDatabaseState).mockResolvedValue(excluded);
}

const richInventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [
    {
      name: "pg_cron",
      version: "1.0",
      schema: "cron",
    },
  ],
  schemas: [
    {
      name: "public",
      extension: null,
      persistentTableCount: 2,
      persistentBytes: "1024",
      classification: "base_dump",
    },
    {
      name: "supabase_migrations",
      extension: null,
      persistentTableCount: 1,
      persistentBytes: "128",
      classification: "migration_history",
    },
    {
      name: "auth",
      extension: null,
      persistentTableCount: 2,
      persistentBytes: "256",
      classification: "auth_data",
    },
    {
      name: "cron",
      extension: "pg_cron",
      persistentTableCount: 1,
      persistentBytes: "128",
      classification: "cron",
    },
    {
      name: "pgmq",
      extension: "pgmq",
      persistentTableCount: 1,
      persistentBytes: "128",
      classification: "queues",
    },
    {
      name: "vault",
      extension: "supabase_vault",
      persistentTableCount: 1,
      persistentBytes: "128",
      classification: "vault_data",
    },
  ],
  unclassifiedPersistentSchemas: [],
  vaultSecretCount: 1,
};

const minimalInventory: DatabaseInventory = {
  schemaVersion: 1,
  extensions: [],
  schemas: [
    {
      name: "public",
      extension: null,
      persistentTableCount: 1,
      persistentBytes: "128",
      classification: "base_dump",
    },
  ],
  unclassifiedPersistentSchemas: [],
};

const richCatalog: DatabaseCatalogState = {
  schemaVersion: 1,
  publications: [
    {
      name: "supabase_realtime",
      owner: "postgres",
      allTables: false,
      publish: {
        insert: true,
        update: true,
        delete: true,
        truncate: true,
      },
    },
  ],
  publicationTables: [],
  webhooks: [
    {
      schema: "public",
      table: "events",
      name: "events_webhook",
      enabled: "O",
      functionSchema: "supabase_functions",
      functionName: "http_request",
      definition: "CREATE TRIGGER events_webhook ...",
    },
  ],
};

const emptyCatalog: DatabaseCatalogState = {
  schemaVersion: 1,
  publications: [],
  publicationTables: [],
  webhooks: [],
};

const richStorageCatalog: FileStorageCatalog = {
  schemaVersion: 1,
  buckets: [
    {
      id: "files",
      name: "files",
      public: false,
      type: "STANDARD",
      fileSizeLimit: null,
      allowedMimeTypes: null,
      createdAt: null,
      updatedAt: null,
    },
  ],
  objects: [
    {
      id: "one",
      bucket: "files",
      name: "one.txt",
      owner: null,
      ownerId: null,
      version: null,
      createdAt: null,
      updatedAt: null,
      lastAccessedAt: null,
      expectedBytes: 3,
      metadata: null,
      userMetadata: null,
    },
    {
      id: "two",
      bucket: "files",
      name: "two.txt",
      owner: null,
      ownerId: null,
      version: null,
      createdAt: null,
      updatedAt: null,
      lastAccessedAt: null,
      expectedBytes: null,
      metadata: null,
      userMetadata: null,
    },
  ],
};

const emptyStorageCatalog: FileStorageCatalog = {
  schemaVersion: 1,
  buckets: [],
  objects: [],
};

async function runCapturedSteps(): Promise<Map<string, BackupStepResult>> {
  const execution = capturedExecution;

  if (execution === undefined) {
    throw new Error("executeBackup was not called");
  }

  const results = new Map<string, BackupStepResult>();

  for (const step of execution.steps) {
    const result = await step.run({
      workspaceRoot: execution.workspaceRoot,
      attempt: 1,
      ...(execution.signal === undefined ? {} : { signal: execution.signal }),
    });

    results.set(step.id, result);
  }

  return results;
}

describe("product backup orchestration", () => {
  it("runs the complete direct-mode product surface and preserves configured coverage", async () => {
    const root = await workspace();
    const redactor = new Redactor();
    const databaseUrl = new SecretValue(
      "postgresql://postgres:secret@example.invalid/postgres",
      redactor,
    );
    const storageKey = new SecretValue(
      "service-role-product-test-key",
      redactor,
    );
    const controller = new AbortController();

    configureCaptureMocks(true);
    configureDumps(root, true);

    vi.mocked(collectDatabaseInventory).mockResolvedValue(richInventory);
    vi.mocked(collectDatabaseCatalogState).mockResolvedValue(richCatalog);
    vi.mocked(collectFileStorageCatalog).mockResolvedValue(richStorageCatalog);

    vi.mocked(downloadStorageObject).mockImplementation((object) =>
      Promise.resolve({
        path: `storage/objects/${object.name}`,
        bytes: object.expectedBytes ?? 0,
        sha256: "b".repeat(64),
      } as never),
    );

    await expect(
      executeProductBackup({
        ...baseOptions(root, redactor),
        databaseUrl,
        storageKey,
        signal: controller.signal,
        resume: false,
      }),
    ).rejects.toThrow(STOP);

    expect(capturedExecution?.steps.map(({ id }) => id)).toEqual([
      "database",
      "project-state",
      "control-plane",
      "platform-v2",
      "auth",
      "api-keys",
      "edge",
      "vault-root-key",
      "file-storage",
      "specialized-storage",
    ]);

    const results = await runCapturedSteps();

    expect(results.get("database")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "database.migrations",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "database.auth_storage_customizations",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "database.extensions",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "database.webhooks",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "database.vault_data",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "database.publications",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "auth.data",
          status: "backed_up",
        }),
      ]),
    );

    expect(results.get("control-plane")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external.dns",
          status: "not_exportable",
          reasonCode: "external_dns_records_require_manual_restore",
        }),
      ]),
    );

    expect(results.get("file-storage")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "storage.file_buckets",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "storage.file_objects",
          status: "backed_up",
        }),
        expect.objectContaining({
          id: "storage.file_metadata",
          status: "backed_up",
        }),
      ]),
    );

    expect(downloadStorageObject).toHaveBeenCalledTimes(2);
    expect(collectDatabaseInventory).toHaveBeenCalledTimes(1);
    expect(collectLinkedDatabaseInventory).not.toHaveBeenCalled();
    expect(collectFileStorageCatalog).toHaveBeenCalledTimes(1);
    expect(collectLinkedFileStorageCatalog).not.toHaveBeenCalled();
  });

  it("runs linked mode and classifies absent optional state as not configured", async () => {
    const root = await workspace();
    const redactor = new Redactor();
    const discoveredStorageKey = new SecretValue(
      "service-role-discovered-test-key",
      redactor,
    );

    configureCaptureMocks(false);
    configureDumps(root, false);

    vi.mocked(collectLinkedDatabaseInventory).mockResolvedValue(
      minimalInventory,
    );
    vi.mocked(collectLinkedDatabaseCatalogState).mockResolvedValue(
      emptyCatalog,
    );
    vi.mocked(collectLinkedFileStorageCatalog).mockResolvedValue(
      emptyStorageCatalog,
    );
    vi.mocked(discoverPrivilegedStorageKey).mockResolvedValue(
      discoveredStorageKey,
    );

    await expect(
      executeProductBackup({
        ...baseOptions(root, redactor),
        linked: true,
      }),
    ).rejects.toThrow(STOP);

    const results = await runCapturedSteps();

    expect(results.get("database")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "database.migrations",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "database.auth_storage_customizations",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "database.extensions",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "database.webhooks",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "database.vault_data",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "database.publications",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "auth.data",
          status: "not_configured",
        }),
      ]),
    );

    expect(results.get("control-plane")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external.dns",
          status: "not_configured",
        }),
      ]),
    );

    expect(results.get("file-storage")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "storage.file_buckets",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "storage.file_objects",
          status: "not_configured",
        }),
        expect.objectContaining({
          id: "storage.file_metadata",
          status: "not_configured",
        }),
      ]),
    );

    expect(discoverPrivilegedStorageKey).toHaveBeenCalledTimes(1);
    expect(collectLinkedDatabaseInventory).toHaveBeenCalledTimes(1);
    expect(collectDatabaseInventory).not.toHaveBeenCalled();
    expect(collectLinkedFileStorageCatalog).toHaveBeenCalledTimes(1);
    expect(collectFileStorageCatalog).not.toHaveBeenCalled();
    expect(downloadStorageObject).not.toHaveBeenCalled();
  });

  it("captures 10k small Storage objects with bounded download concurrency", async () => {
    const root = await workspace();
    const redactor = new Redactor();
    const databaseUrl = new SecretValue(
      "postgresql://postgres:secret@example.invalid/postgres",
      redactor,
    );
    const storageKey = new SecretValue(
      "service-role-product-scale-test-key",
      redactor,
    );
    const objectCount = 10_000;
    const maxStorageConcurrency = 8;
    let activeDownloads = 0;
    let peakDownloads = 0;

    configureCaptureMocks(true);
    configureDumps(root, true);
    vi.mocked(collectDatabaseInventory).mockResolvedValue(richInventory);
    vi.mocked(collectDatabaseCatalogState).mockResolvedValue(richCatalog);
    vi.mocked(collectFileStorageCatalog).mockResolvedValue({
      schemaVersion: 1,
      buckets: richStorageCatalog.buckets,
      objects: Array.from({ length: objectCount }, (_, index) => ({
        id: `small-object-${index}`,
        bucket: "files",
        name: `small/${String(index).padStart(5, "0")}.bin`,
        owner: null,
        ownerId: null,
        version: null,
        createdAt: null,
        updatedAt: null,
        lastAccessedAt: null,
        expectedBytes: 1,
        metadata: null,
        userMetadata: null,
      })),
    });
    vi.mocked(downloadStorageObject).mockImplementation(async (object) => {
      activeDownloads += 1;
      peakDownloads = Math.max(peakDownloads, activeDownloads);
      await Promise.resolve();
      activeDownloads -= 1;
      return {
        bucket: object.bucket,
        name: object.name,
        contentId: `content-${object.name}`,
        path: `storage/file-objects/${object.name}`,
        sha256: "a".repeat(64),
        bytes: object.expectedBytes ?? 0,
      };
    });

    await expect(
      executeProductBackup({
        ...baseOptions(root, redactor),
        databaseUrl,
        storageKey,
        maxStorageConcurrency,
        resume: false,
      }),
    ).rejects.toThrow(STOP);

    const results = await runCapturedSteps();
    const index = JSON.parse(
      await readFile(
        path.join(root, "secrets", "storage", "file-object-index.json"),
        "utf8",
      ),
    ) as { objects: { name: string; bytes: number }[] };

    expect(results.get("file-storage")?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "storage.file_objects",
          status: "backed_up",
        }),
      ]),
    );
    expect(downloadStorageObject).toHaveBeenCalledTimes(objectCount);
    expect(peakDownloads).toBeLessThanOrEqual(maxStorageConcurrency);
    expect(index.objects).toHaveLength(objectCount);
    expect(index.objects[0]).toMatchObject({
      name: "small/00000.bin",
      bytes: 1,
    });
    expect(index.objects.at(-1)).toMatchObject({
      name: "small/09999.bin",
      bytes: 1,
    });
  });

  it("rejects invalid database source-mode combinations before side effects", async () => {
    const root = await workspace();
    const redactor = new Redactor();
    const databaseUrl = new SecretValue(
      "postgresql://postgres:secret@example.invalid/postgres",
      redactor,
    );

    await expect(
      executeProductBackup({
        ...baseOptions(root, redactor),
        linked: true,
        databaseUrl,
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    await expect(
      executeProductBackup({
        ...baseOptions(root, redactor),
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    expect(executeBackup).not.toHaveBeenCalled();
  });

  it("fails closed when no privileged Storage credential can be obtained", async () => {
    const root = await workspace();
    const redactor = new Redactor();

    vi.mocked(discoverPrivilegedStorageKey).mockResolvedValue(undefined);

    await expect(
      executeProductBackup({
        ...baseOptions(root, redactor),
        linked: true,
      }),
    ).rejects.toThrow(
      "No revealed privileged project API key is available for complete Storage capture.",
    );

    expect(executeBackup).not.toHaveBeenCalled();
  });
});
