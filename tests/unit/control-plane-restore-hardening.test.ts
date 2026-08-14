import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createControlPlaneRestoreHandlers } from "../../src/core/restore/control-plane-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
import type {
  ManagementClient,
  RequestOptions,
} from "../../src/supabase/management/client.js";

const temporaryDirectories: string[] = [];
const projectRef = "zyxwvutsrqponmlkjihg";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function bundleArtifact(
  artifact: string,
  data: unknown,
): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-control-hardening-"),
  );
  temporaryDirectories.push(root);

  const filename = path.join(root, ...artifact.split("/"));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(
    filename,
    JSON.stringify({
      sourceContract: { adapter: "test-fixture" },
      data,
    }),
  );

  return root;
}

async function bundleRawArtifact(
  artifact: string,
  contents: string,
): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-control-hardening-"),
  );
  temporaryDirectories.push(root);

  const filename = path.join(root, ...artifact.split("/"));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);

  return root;
}

function action(component: string, artifact: string): RestoreAction {
  return {
    id: `restore.${component}`,
    component,
    phase: 18,
    operation: "restore_control_plane_config",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "restore",
    fidelity: "semantic",
    artifacts: [artifact],
  };
}

interface ClientFixtureOptions {
  get: Readonly<Record<string, readonly unknown[]>>;
  putResponses?: Readonly<Record<string, unknown>>;
}

function managementClient(options: ClientFixtureOptions) {
  const queues = new Map(
    Object.entries(options.get).map(([pathname, values]) => [
      pathname,
      [...values],
    ]),
  );

  const patches: { pathname: string; body: unknown }[] = [];
  const puts: { pathname: string; body: unknown }[] = [];

  const client: Pick<ManagementClient, "get" | "patch" | "put"> = {
    get<T>(
      pathname: string,
      schema: z.ZodType<T>,
      _requestOptions?: RequestOptions,
    ): Promise<T> {
      void _requestOptions;

      const queue = queues.get(pathname);

      if (queue === undefined || queue.length === 0) {
        throw new Error(`Missing GET fixture for ${pathname}`);
      }

      return Promise.resolve(schema.parse(queue.shift()));
    },

    patch<TBody>(
      pathname: string,
      body: TBody,
      bodySchema: z.ZodType<TBody>,
      _requestOptions?: RequestOptions,
    ): Promise<void> {
      void _requestOptions;

      patches.push({
        pathname,
        body: bodySchema.parse(body),
      });

      return Promise.resolve();
    },

    put<TBody, TResponse>(
      pathname: string,
      body: TBody,
      bodySchema: z.ZodType<TBody>,
      responseSchema: z.ZodType<TResponse>,
      _requestOptions?: RequestOptions,
    ): Promise<TResponse> {
      void _requestOptions;

      puts.push({
        pathname,
        body: bodySchema.parse(body),
      });

      const response = options.putResponses?.[pathname];

      if (response === undefined) {
        throw new Error(`Missing PUT response fixture for ${pathname}`);
      }

      return Promise.resolve(responseSchema.parse(response));
    },
  };

  return {
    client,
    patches,
    puts,
  };
}

const realtimeSource = {
  connection_pool: 10,
  max_concurrent_users: 100,
  max_events_per_second: 100,
  max_bytes_per_second: 1000,
  max_channels_per_client: 100,
  max_joins_per_second: 100,
  max_presence_events_per_second: 100,
  max_payload_size_in_kb: 100,
  suspend: false,
  presence_enabled: true,
};

const poolerPrimary = {
  identifier: "primary",
  database_type: "PRIMARY",
  is_using_scram_auth: true,
  db_user: "postgres",
  db_host: "example.invalid",
  db_port: 5432,
  db_name: "postgres",
  connection_string: "postgresql://postgres:secret@example.invalid/postgres",
  connectionString: "postgresql://postgres:secret@example.invalid/postgres",
  default_pool_size: 15,
  max_client_conn: 200,
  pool_mode: "transaction",
};

const postgrestSource = {
  db_schema: "public,graphql_public",
  max_rows: 1000,
  db_extra_search_path: "public,extensions",
  db_pool: 10,
  db_pool_acquisition_timeout: 10,
  jwt_secret: "fixture-jwt-secret",
};

const storageSource = {
  fileSizeLimit: 52_428_800,
  features: {
    imageTransformation: { enabled: false },
    s3Protocol: { enabled: true },
    purgeCache: { enabled: true },
    icebergCatalog: {
      enabled: false,
      maxNamespaces: 0,
      maxTables: 0,
      maxCatalogs: 0,
    },
    vectorBuckets: {
      enabled: false,
      maxBuckets: 0,
      maxIndexes: 0,
    },
  },
  capabilities: {
    list_v2: true,
    iceberg_catalog: false,
  },
  external: {
    upstreamTarget: "main",
  },
  migrationVersion: "1",
};

describe("control-plane restore hardening", () => {
  it("executes every remaining documented writable control-plane contract", async () => {
    const cases = [
      {
        component: "database.postgres_config" as const,
        artifact: "control-plane/database-postgres.json",
        endpoint: `/v1/projects/${projectRef}/config/database/postgres`,
        source: {
          max_connections: 120,
          shared_buffers: "256MB",
        },
        target: {
          max_connections: 100,
          shared_buffers: "128MB",
        },
        method: "PUT" as const,
      },
      {
        component: "database.pooler" as const,
        artifact: "secrets/control-plane/database-pooler.json",
        endpoint: `/v1/projects/${projectRef}/config/database/pooler`,
        source: [
          poolerPrimary,
          {
            ...poolerPrimary,
            identifier: "replica",
            database_type: "READ_REPLICA",
            db_host: "replica.example.invalid",
          },
        ],
        target: [
          {
            ...poolerPrimary,
            default_pool_size: 5,
          },
        ],
        method: "PATCH" as const,
      },
      {
        component: "rest.postgrest_config" as const,
        artifact: "secrets/control-plane/postgrest.json",
        endpoint: `/v1/projects/${projectRef}/postgrest`,
        source: postgrestSource,
        target: {
          ...postgrestSource,
          max_rows: 500,
        },
        method: "PATCH" as const,
      },
      {
        component: "storage.service_config" as const,
        artifact: "control-plane/storage.json",
        endpoint: `/v1/projects/${projectRef}/config/storage`,
        source: storageSource,
        target: {
          ...storageSource,
          fileSizeLimit: 10_485_760,
        },
        method: "PATCH" as const,
      },
    ];

    for (const testCase of cases) {
      const root = await bundleArtifact(testCase.artifact, testCase.source);

      const management = managementClient({
        get: {
          [testCase.endpoint]: [testCase.target],
        },
        ...(testCase.method === "PUT"
          ? {
              putResponses: {
                [testCase.endpoint]: testCase.source,
              },
            }
          : {}),
      });

      const handlers = createControlPlaneRestoreHandlers({
        bundleRoot: root,
        targetProjectRef: projectRef,
        conflictPolicy: "replace",
        client: management.client,
      });

      await handlers[testCase.component].apply({
        action: action(testCase.component, testCase.artifact),
        attempt: 1,
      });

      if (testCase.method === "PUT") {
        expect(management.puts).toHaveLength(1);
        expect(management.puts[0]?.pathname).toBe(testCase.endpoint);
        expect(management.patches).toEqual([]);
      } else {
        expect(management.patches).toHaveLength(1);
        expect(management.patches[0]?.pathname).toBe(testCase.endpoint);
        expect(management.puts).toEqual([]);
      }
    }
  });

  it("filters restore bodies to writable contract fields", async () => {
    const cases = [
      {
        component: "database.pooler" as const,
        artifact: "secrets/control-plane/database-pooler.json",
        endpoint: `/v1/projects/${projectRef}/config/database/pooler`,
        source: [poolerPrimary],
        target: [
          {
            ...poolerPrimary,
            default_pool_size: 5,
          },
        ],
        expectedBody: {
          default_pool_size: 15,
          pool_mode: "transaction",
        },
        forbidden: [
          "connection_string",
          "connectionString",
          "db_host",
          "db_user",
        ],
      },
      {
        component: "rest.postgrest_config" as const,
        artifact: "secrets/control-plane/postgrest.json",
        endpoint: `/v1/projects/${projectRef}/postgrest`,
        source: postgrestSource,
        target: {
          ...postgrestSource,
          max_rows: 500,
        },
        expectedBody: {
          db_extra_search_path: "public,extensions",
          db_schema: "public,graphql_public",
          max_rows: 1000,
          db_pool: 10,
          db_pool_acquisition_timeout: 10,
        },
        forbidden: ["jwt_secret"],
      },
      {
        component: "storage.service_config" as const,
        artifact: "control-plane/storage.json",
        endpoint: `/v1/projects/${projectRef}/config/storage`,
        source: storageSource,
        target: {
          ...storageSource,
          fileSizeLimit: 10_485_760,
        },
        expectedBody: {
          fileSizeLimit: 52_428_800,
          features: storageSource.features,
          external: storageSource.external,
        },
        forbidden: ["capabilities", "migrationVersion"],
      },
    ];

    for (const testCase of cases) {
      const root = await bundleArtifact(testCase.artifact, testCase.source);

      const management = managementClient({
        get: {
          [testCase.endpoint]: [testCase.target],
        },
      });

      const handler = createControlPlaneRestoreHandlers({
        bundleRoot: root,
        targetProjectRef: projectRef,
        conflictPolicy: "replace",
        client: management.client,
      })[testCase.component];

      await handler.apply({
        action: action(testCase.component, testCase.artifact),
        attempt: 1,
      });

      expect(management.patches[0]?.body).toEqual(testCase.expectedBody);

      for (const field of testCase.forbidden) {
        expect(management.patches[0]?.body).not.toHaveProperty(field);
      }
    }
  });

  it("returns without mutation when target configuration already matches", async () => {
    const artifact = "control-plane/realtime.json";
    const root = await bundleArtifact(artifact, realtimeSource);
    const endpoint = `/v1/projects/${projectRef}/config/realtime`;

    const management = managementClient({
      get: {
        [endpoint]: [realtimeSource],
      },
    });

    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: management.client,
    })["realtime.config"];

    const result = await handler.apply({
      action: action("realtime.config", artifact),
      attempt: 1,
    });

    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(management.patches).toEqual([]);
    expect(management.puts).toEqual([]);

    await expect(
      handler.verify({
        action: action("realtime.config", artifact),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("omits nullable fields that cannot be sent through the Realtime PATCH contract", async () => {
    const artifact = "control-plane/realtime.json";

    const source = {
      ...realtimeSource,
      private_only: null,
      postgres_changes_pool: null,
    };

    const target = {
      ...source,
      max_events_per_second: 50,
    };

    const root = await bundleArtifact(artifact, source);
    const endpoint = `/v1/projects/${projectRef}/config/realtime`;

    const management = managementClient({
      get: {
        [endpoint]: [target],
      },
    });

    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: management.client,
    })["realtime.config"];

    const controller = new AbortController();

    await handler.apply({
      action: action("realtime.config", artifact),
      attempt: 1,
      signal: controller.signal,
    });

    expect(management.patches).toHaveLength(1);
    expect(management.patches[0]?.body).not.toHaveProperty("private_only");
    expect(management.patches[0]?.body).not.toHaveProperty(
      "postgres_changes_pool",
    );
    expect(management.patches[0]?.body).toMatchObject({
      max_events_per_second: 100,
    });
  });

  it("rejects an artifact path that does not belong to the restore component", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-control-hardening-"),
    );
    temporaryDirectories.push(root);

    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: managementClient({ get: {} }).client,
    })["realtime.config"];

    await expect(
      handler.apply({
        action: action("realtime.config", "control-plane/not-realtime.json"),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "realtime.config",
    });
  });

  it("fails closed for malformed control-plane artifact JSON", async () => {
    const artifact = "control-plane/realtime.json";
    const root = await bundleRawArtifact(artifact, "{");
    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: managementClient({ get: {} }).client,
    })["realtime.config"];

    await expect(
      handler.apply({
        action: action("realtime.config", artifact),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "realtime.config",
    });
  });

  it("fails closed when a pooler backup contains no PRIMARY database", async () => {
    const artifact = "secrets/control-plane/database-pooler.json";

    const root = await bundleArtifact(artifact, [
      {
        ...poolerPrimary,
        identifier: "replica",
        database_type: "READ_REPLICA",
      },
    ]);

    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: managementClient({ get: {} }).client,
    })["database.pooler"];

    await expect(
      handler.apply({
        action: action("database.pooler", artifact),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
      component: "database.pooler",
    });
  });

  it("emits a removal-only network patch when source restrictions are empty", async () => {
    const artifact = "control-plane/network-restrictions.json";

    const source = {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: [],
        dbAllowedCidrsV6: [],
      },
      status: "applied",
    };

    const target = {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: ["10.0.0.0/8"],
        dbAllowedCidrsV6: ["2001:db8::/32"],
      },
      status: "applied",
    };

    const root = await bundleArtifact(artifact, source);
    const endpoint = `/v1/projects/${projectRef}/network-restrictions`;

    const management = managementClient({
      get: {
        [endpoint]: [target],
      },
    });

    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: management.client,
    })["network.restrictions"];

    await handler.apply({
      action: action("network.restrictions", artifact),
      attempt: 1,
    });

    expect(management.patches).toEqual([
      {
        pathname: endpoint,
        body: {
          remove: {
            dbAllowedCidrs: ["10.0.0.0/8"],
            dbAllowedCidrsV6: ["2001:db8::/32"],
          },
        },
      },
    ]);
  });

  it("no-ops matching network restrictions and enforces fail conflict policy", async () => {
    const artifact = "control-plane/network-restrictions.json";

    const source = {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: ["10.0.0.0/8"],
        dbAllowedCidrsV6: [],
      },
      status: "applied",
    };

    const different = {
      ...source,
      config: {
        dbAllowedCidrs: ["192.168.0.0/16"],
        dbAllowedCidrsV6: [],
      },
    };

    const root = await bundleArtifact(artifact, source);
    const endpoint = `/v1/projects/${projectRef}/network-restrictions`;

    const matchingManagement = managementClient({
      get: {
        [endpoint]: [source],
      },
    });

    const matchingHandler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: matchingManagement.client,
    })["network.restrictions"];

    const matching = await matchingHandler.apply({
      action: action("network.restrictions", artifact),
      attempt: 1,
    });

    expect(matching.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(matchingManagement.patches).toEqual([]);

    const conflictingManagement = managementClient({
      get: {
        [endpoint]: [different],
      },
    });

    const conflictingHandler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "fail",
      client: conflictingManagement.client,
    })["network.restrictions"];

    await expect(
      conflictingHandler.apply({
        action: action("network.restrictions", artifact),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_TARGET_CONFLICT",
      component: "network.restrictions",
    });

    expect(conflictingManagement.patches).toEqual([]);
  });

  it("polls network verification to exhaustion when parity is never reached", async () => {
    const artifact = "control-plane/network-restrictions.json";

    const source = {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: ["10.0.0.0/8"],
        dbAllowedCidrsV6: [],
      },
      status: "applied",
    };

    const stale = {
      ...source,
      config: {
        dbAllowedCidrs: ["192.168.0.0/16"],
        dbAllowedCidrsV6: [],
      },
    };

    const root = await bundleArtifact(artifact, source);
    const endpoint = `/v1/projects/${projectRef}/network-restrictions`;

    const management = managementClient({
      get: {
        [endpoint]: Array.from({ length: 8 }, () => stale),
      },
    });

    const sleep = vi.fn(() => Promise.resolve());

    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: management.client,
      sleep,
    })["network.restrictions"];

    await expect(
      handler.verify({
        action: action("network.restrictions", artifact),
      }),
    ).resolves.toBe(false);

    expect(sleep).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleep).toHaveBeenNthCalledWith(7, 3500, undefined);
  });
});
