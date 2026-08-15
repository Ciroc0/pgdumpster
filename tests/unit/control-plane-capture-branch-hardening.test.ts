import { describe, expect, it } from "vitest";

import type { BundleArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";
import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";
import { captureControlPlaneState } from "../../src/supabase/management/control-plane.js";

const projectRef = "abcdefghijklmnopqrst";

function defaults(): Record<string, unknown> {
  return {
    "/config/database/postgres": {},
    "/config/database/pooler": [],
    "/config/database/pgbouncer": {},
    "/ssl-enforcement": {},
    "/database/backups/schedule": {},
    "/config/realtime": {},
    "/postgrest": {},
    "/config/storage": {},
    "/custom-hostname": {},
    "/vanity-subdomain": {
      status: "not-used",
    },
    "/network-restrictions": {
      entitlement: "allowed",
      config: {
        dbAllowedCidrs: [],
        dbAllowedCidrsV6: [],
      },
      status: "applied",
    },
  };
}

function fakeClient(
  values: Record<string, unknown> = {},
  errors: Record<string, number> = {},
): ManagementClient {
  const data = {
    ...defaults(),
    ...values,
  };

  return {
    get(pathname: string) {
      const prefix = `/v1/projects/${projectRef}`;

      const endpoint = pathname.startsWith(prefix)
        ? pathname.slice(prefix.length)
        : pathname;

      const status = errors[endpoint];

      if (status !== undefined) {
        throw new PgDumpsterError({
          code: "PLATFORM_FEATURE_UNAVAILABLE",
          category: "control_plane",
          message: "fixture unavailable",
          retryable: false,
          details: {
            status,
          },
        });
      }

      return Promise.resolve(data[endpoint]);
    },
  } as unknown as ManagementClient;
}

async function capture(
  values: Record<string, unknown> = {},
  errors: Record<string, number> = {},
) {
  const writes: {
    path: string;
    value: Readonly<Record<string, unknown>>;
  }[] = [];

  const result = {
    bytes: 0,
    sha256: "0".repeat(64),
  };

  const ordinary: BundleArtifactSink = {
    writeJson(path, value) {
      writes.push({
        path,
        value,
      });

      return Promise.resolve(result);
    },

    writeStream() {
      return Promise.resolve(result);
    },
  };

  const protectedSink: ProtectedArtifactSink = {
    writeJson(path, value) {
      writes.push({
        path,
        value,
      });

      return Promise.resolve();
    },
  };

  const redactor = new Redactor();

  const captured = await captureControlPlaneState(
    fakeClient(values, errors),
    projectRef,
    ordinary,
    protectedSink,
    redactor,
  );

  return {
    captured,
    writes,
    redactor,
  };
}

type CoverageStatus =
  | "backed_up"
  | "not_configured"
  | "not_applicable"
  | "not_exportable"
  | "failed";

function status(
  coverage: readonly {
    id: string;
    status: CoverageStatus;
  }[],
  id: string,
): CoverageStatus | undefined {
  return coverage.find((entry) => entry.id === id)?.status;
}

describe("control-plane capture branch hardening", () => {
  it("classifies empty optional configurations", async () => {
    const { captured } = await capture();

    expect(status(captured.coverage, "database.pooler")).toBe("not_configured");

    expect(status(captured.coverage, "database.pgbouncer")).toBe(
      "not_configured",
    );

    expect(status(captured.coverage, "domains.vanity_subdomain")).toBe(
      "not_configured",
    );

    expect(status(captured.coverage, "network.restrictions")).toBe(
      "not_configured",
    );
  });

  it("classifies documented entitlement and availability failures", async () => {
    const { captured } = await capture(
      {},
      {
        "/config/database/pgbouncer": 404,
        "/database/backups/schedule": 402,
        "/custom-hostname": 400,
        "/vanity-subdomain": 400,
      },
    );

    expect(status(captured.coverage, "database.pgbouncer")).toBe(
      "not_applicable",
    );

    expect(status(captured.coverage, "database.backup_schedule")).toBe(
      "not_applicable",
    );

    expect(status(captured.coverage, "domains.custom_hostname")).toBe(
      "not_applicable",
    );

    expect(status(captured.coverage, "domains.vanity_subdomain")).toBe(
      "not_applicable",
    );
  });

  it("distinguishes documented not-configured 404 cases", async () => {
    const { captured } = await capture(
      {},
      {
        "/database/backups/schedule": 404,
        "/custom-hostname": 404,
      },
    );

    expect(status(captured.coverage, "database.backup_schedule")).toBe(
      "not_configured",
    );

    expect(status(captured.coverage, "domains.custom_hostname")).toBe(
      "not_configured",
    );
  });

  it("classifies a used vanity domain and populated pgbouncer as backed up", async () => {
    const { captured } = await capture({
      "/config/database/pgbouncer": {
        pool_mode: "transaction",
      },
      "/vanity-subdomain": {
        status: "active",
      },
    });

    expect(status(captured.coverage, "database.pgbouncer")).toBe("backed_up");

    expect(status(captured.coverage, "domains.vanity_subdomain")).toBe(
      "backed_up",
    );
  });

  it("marks captured read-only control-plane surfaces as not identically restorable", async () => {
    const { captured } = await capture({
      "/config/database/pgbouncer": { pool_mode: "transaction" },
      "/database/backups/schedule": { enabled: true },
      "/custom-hostname": { hostname: "db.example.invalid" },
    });

    for (const id of [
      "database.pgbouncer",
      "database.backup_schedule",
      "domains.custom_hostname",
    ]) {
      expect(
        captured.coverage.find((entry) => entry.id === id)?.sourceContract,
      ).toMatchObject({
        restoreFidelity: "not_identically_restorable",
      });
    }
  });

  it("classifies disallowed and malformed network states conservatively", async () => {
    const disallowed = await capture({
      "/network-restrictions": {
        entitlement: "disallowed",
        config: {
          dbAllowedCidrs: [],
          dbAllowedCidrsV6: [],
        },
      },
    });

    expect(status(disallowed.captured.coverage, "network.restrictions")).toBe(
      "not_applicable",
    );

    const nullValue = await capture({
      "/network-restrictions": null,
    });

    expect(status(nullValue.captured.coverage, "network.restrictions")).toBe(
      "backed_up",
    );

    const nullConfig = await capture({
      "/network-restrictions": {
        entitlement: "allowed",
        config: null,
      },
    });

    expect(status(nullConfig.captured.coverage, "network.restrictions")).toBe(
      "backed_up",
    );
  });

  it("classifies non-empty network CIDRs as backed up", async () => {
    const { captured } = await capture({
      "/network-restrictions": {
        entitlement: "allowed",
        config: {
          dbAllowedCidrs: ["10.0.0.0/8"],
          dbAllowedCidrsV6: [],
        },
      },
    });

    expect(status(captured.coverage, "network.restrictions")).toBe("backed_up");
  });

  it("extracts and sorts only read-replica topology", async () => {
    const { captured, writes } = await capture({
      "/config/database/pooler": [
        {
          identifier: "replica-z",
          database_type: "READ_REPLICA",
          db_host: "z.invalid",
          db_port: 5432,
          db_name: "postgres",
        },
        {
          identifier: "primary",
          database_type: "PRIMARY",
          db_host: "p.invalid",
          db_port: 5432,
          db_name: "postgres",
        },
        {
          identifier: "replica-a",
          database_type: "READ_REPLICA",
          db_host: "a.invalid",
          db_port: 5432,
          db_name: "postgres",
        },
      ],
    });

    expect(status(captured.coverage, "project.read_replicas")).toBe(
      "backed_up",
    );

    const topology = writes.find(
      ({ path }) => path === "control-plane/read-replicas.json",
    )?.value["data"];

    const identifiers = Array.isArray(topology)
      ? topology.map((entry): string | undefined => {
          if (entry === null || typeof entry !== "object") {
            return undefined;
          }

          const identifier: unknown = Reflect.get(entry, "identifier");

          return typeof identifier === "string" ? identifier : undefined;
        })
      : [];

    expect(identifiers).toEqual(["replica-a", "replica-z"]);
  });
});
