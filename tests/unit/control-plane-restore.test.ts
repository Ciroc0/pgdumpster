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
    path.join(tmpdir(), "pgdumpster-control-restore-"),
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
      const value = queue.shift();
      return Promise.resolve(schema.parse(value));
    },
    patch<TBody>(
      pathname: string,
      body: TBody,
      bodySchema: z.ZodType<TBody>,
      _requestOptions?: RequestOptions,
    ): Promise<void> {
      void _requestOptions;
      patches.push({ pathname, body: bodySchema.parse(body) });
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
      puts.push({ pathname, body: bodySchema.parse(body) });
      const response = options.putResponses?.[pathname];
      if (response === undefined) {
        throw new Error(`Missing PUT response fixture for ${pathname}`);
      }
      return Promise.resolve(responseSchema.parse(response));
    },
  };

  return { client, patches, puts };
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

describe("control-plane restore handlers", () => {
  it("mutates a writable config with only the validated request body and polls until parity", async () => {
    const artifact = "control-plane/realtime.json";
    const root = await bundleArtifact(artifact, realtimeSource);
    const endpoint = `/v1/projects/${projectRef}/config/realtime`;
    const stale = { ...realtimeSource, max_events_per_second: 50 };
    const management = managementClient({
      get: { [endpoint]: [stale, stale, realtimeSource] },
    });
    const sleep = vi.fn(() => Promise.resolve());
    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: management.client,
      sleep,
    })["realtime.config"];

    const applied = await handler.apply({
      action: action("realtime.config", artifact),
      attempt: 1,
    });

    expect(management.patches).toEqual([
      { pathname: endpoint, body: realtimeSource },
    ]);
    await expect(
      handler.verify({
        action: action("realtime.config", artifact),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500, undefined);
  });

  it("fails on an existing conflicting config without issuing a mutation", async () => {
    const artifact = "control-plane/realtime.json";
    const root = await bundleArtifact(artifact, realtimeSource);
    const endpoint = `/v1/projects/${projectRef}/config/realtime`;
    const management = managementClient({
      get: {
        [endpoint]: [{ ...realtimeSource, max_events_per_second: 50 }],
      },
    });
    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "fail",
      client: management.client,
    })["realtime.config"];

    await expect(
      handler.apply({
        action: action("realtime.config", artifact),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_TARGET_CONFLICT",
      component: "realtime.config",
    });
    expect(management.patches).toEqual([]);
    expect(management.puts).toEqual([]);
  });

  it("uses the documented PUT body for SSL enforcement and verifies semantic parity", async () => {
    const artifact = "control-plane/database-ssl.json";
    const source = {
      currentConfig: { database: true },
      appliedSuccessfully: true,
    };
    const root = await bundleArtifact(artifact, source);
    const endpoint = `/v1/projects/${projectRef}/ssl-enforcement`;
    const stale = {
      currentConfig: { database: false },
      appliedSuccessfully: true,
    };
    const management = managementClient({
      get: { [endpoint]: [stale, source] },
      putResponses: { [endpoint]: source },
    });
    const handler = createControlPlaneRestoreHandlers({
      bundleRoot: root,
      targetProjectRef: projectRef,
      conflictPolicy: "replace",
      client: management.client,
      sleep: () => Promise.resolve(),
    })["database.ssl"];

    const applied = await handler.apply({
      action: action("database.ssl", artifact),
      attempt: 1,
    });

    expect(management.puts).toEqual([
      {
        pathname: endpoint,
        body: { requestedConfig: { database: true } },
      },
    ]);
    await expect(
      handler.verify({
        action: action("database.ssl", artifact),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("computes an additive/removal network patch instead of replacing the response document", async () => {
    const artifact = "control-plane/network-restrictions.json";
    const source = {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: ["10.0.0.0/8"],
        dbAllowedCidrsV6: ["2001:db8::/32"],
      },
      status: "applied",
    };
    const target = {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: ["192.168.0.0/16"],
        dbAllowedCidrsV6: [],
      },
      status: "applied",
    };
    const root = await bundleArtifact(artifact, source);
    const endpoint = `/v1/projects/${projectRef}/network-restrictions`;
    const management = managementClient({ get: { [endpoint]: [target] } });
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
          add: {
            dbAllowedCidrs: ["10.0.0.0/8"],
            dbAllowedCidrsV6: ["2001:db8::/32"],
          },
          remove: { dbAllowedCidrs: ["192.168.0.0/16"] },
        },
      },
    ]);
  });
});
