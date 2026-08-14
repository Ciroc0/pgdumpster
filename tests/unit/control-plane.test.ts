import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDirectoryArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import { createPlaintextProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { captureControlPlaneState } from "../../src/supabase/management/control-plane.js";

const temporaryDirectories: string[] = [];
const projectRef = "abcdefghijklmnopqrst";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function responseFor(
  pathname: string,
  connectionSecret: string,
  jwtSecret: string,
  includeReplica = false,
): Response {
  if (pathname.endsWith("/config/database/postgres")) return Response.json({});
  if (pathname.endsWith("/config/database/pooler")) {
    const databases = [
      {
        identifier: "primary",
        database_type: "PRIMARY",
        is_using_scram_auth: true,
        db_user: "postgres",
        db_host: "example.invalid",
        db_port: 5432,
        db_name: "postgres",
        connection_string: connectionSecret,
        connectionString: connectionSecret,
        default_pool_size: 15,
        max_client_conn: 200,
        pool_mode: "transaction",
      },
    ];
    if (includeReplica) {
      databases.push({
        ...databases[0]!,
        identifier: "replica-eu",
        database_type: "READ_REPLICA",
        db_host: "replica.example.invalid",
      });
    }
    return Response.json(databases);
  }
  if (pathname.endsWith("/config/database/pgbouncer")) {
    return Response.json({ message: "not available" }, { status: 404 });
  }
  if (pathname.endsWith("/ssl-enforcement")) {
    return Response.json({
      currentConfig: { database: true },
      appliedSuccessfully: true,
    });
  }
  if (pathname.endsWith("/database/backups/schedule")) {
    return Response.json({ message: "plan gated" }, { status: 402 });
  }
  if (pathname.endsWith("/config/realtime")) {
    return Response.json({
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
    });
  }
  if (pathname.endsWith("/postgrest")) {
    return Response.json({
      db_schema: "public,graphql_public",
      max_rows: 1000,
      db_extra_search_path: "public,extensions",
      db_pool: 10,
      db_pool_acquisition_timeout: 10,
      jwt_secret: jwtSecret,
    });
  }
  if (pathname.endsWith("/config/storage")) {
    return Response.json({
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
        vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
      },
      capabilities: { list_v2: true, iceberg_catalog: false },
      external: { upstreamTarget: "main" },
      migrationVersion: "1",
    });
  }
  if (pathname.endsWith("/custom-hostname")) {
    return Response.json({ message: "not configured" }, { status: 404 });
  }
  if (pathname.endsWith("/vanity-subdomain")) {
    return Response.json({ status: "not-used" });
  }
  if (pathname.endsWith("/network-restrictions")) {
    return Response.json({
      entitlement: "allowed",
      config: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
      status: "applied",
    });
  }
  return Response.json({ message: "unexpected path" }, { status: 500 });
}

async function capture(invalidRealtime = false, includeReplica = false) {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-control-plane-"));
  temporaryDirectories.push(root);
  const redactor = new Redactor();
  const connectionSecret = `postgresql://postgres:${randomUUID()}@example.invalid/postgres`;
  const jwtSecret = randomUUID();
  const client = new ManagementClient({
    accessToken: new SecretValue(randomUUID(), redactor),
    fetch: (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const pathname = new URL(url).pathname;
      if (invalidRealtime && pathname.endsWith("/config/realtime")) {
        return Promise.resolve(Response.json({ private_only: "invalid" }));
      }
      return Promise.resolve(
        responseFor(pathname, connectionSecret, jwtSecret, includeReplica),
      );
    },
  });
  const ordinary = await createDirectoryArtifactSink(root);
  const protectedSink = await createPlaintextProtectedArtifactSink(root, {
    allowPlaintextSecrets: true,
  });
  const result = await captureControlPlaneState(
    client,
    projectRef,
    ordinary,
    protectedSink,
    redactor,
  );
  return { root, redactor, connectionSecret, jwtSecret, result };
}

describe("control-plane capture", () => {
  it("captures exact contracts, protects returned credentials, and classifies capabilities", async () => {
    const { root, redactor, connectionSecret, jwtSecret, result } =
      await capture();
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "database.postgres_config", status: "backed_up" },
      { id: "database.pooler", status: "backed_up" },
      { id: "project.read_replicas", status: "not_configured" },
      { id: "database.pgbouncer", status: "not_applicable" },
      { id: "database.ssl", status: "backed_up" },
      { id: "database.backup_schedule", status: "not_applicable" },
      { id: "realtime.config", status: "backed_up" },
      { id: "rest.postgrest_config", status: "backed_up" },
      { id: "storage.service_config", status: "backed_up" },
      { id: "domains.custom_hostname", status: "not_configured" },
      { id: "domains.vanity_subdomain", status: "not_configured" },
      { id: "network.restrictions", status: "not_configured" },
    ]);
    expect(redactor.redact(`x ${connectionSecret} ${jwtSecret} y`)).toBe(
      "x [REDACTED] [REDACTED] y",
    );
    expect(
      await readFile(
        path.join(root, "secrets/control-plane/postgrest.json"),
        "utf8",
      ),
    ).toContain(jwtSecret);
    expect(
      await readFile(path.join(root, "control-plane/realtime.json"), "utf8"),
    ).not.toContain(jwtSecret);
  });

  it("fails closed when a response violates the current official schema", async () => {
    await expect(capture(true)).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });
  });

  it("writes sanitized read-replica topology without pooler credentials", async () => {
    const { root, connectionSecret, result } = await capture(false, true);
    expect(
      result.coverage.find(({ id }) => id === "project.read_replicas"),
    ).toMatchObject({ status: "backed_up" });
    const topology = await readFile(
      path.join(root, "control-plane/read-replicas.json"),
      "utf8",
    );
    expect(topology).toContain("replica-eu");
    expect(topology).toContain("replica.example.invalid");
    expect(topology).not.toContain(connectionSecret);
    expect(topology).not.toContain("db_user");
  });
});
