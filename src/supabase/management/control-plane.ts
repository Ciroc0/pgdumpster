import type { BundleArtifactSink } from "../../core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../../core/bundle/schemas.js";
import type { PgDumpsterError } from "../../core/errors/error.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import type { Redactor } from "../../security/redactor.js";
import type { ManagementClient } from "./client.js";
import {
  CONTROL_PLANE_CONTRACT_SOURCE_SHA256,
  controlPlaneContractSchema,
  type ControlPlaneContractName,
} from "./control-plane-contract.js";

type CoverageEntry = CoverageDocument["components"][number];

interface CaptureSpec {
  id: CoverageEntry["id"];
  endpoint: string;
  contract: ControlPlaneContractName;
  sensitivity: CoverageEntry["sensitivity"];
  artifact: string;
  protected: boolean;
  restoreFidelity?: "not_identically_restorable";
  classify?: (value: unknown) => CoverageEntry["status"];
  unavailable?: (
    status: number,
  ) =>
    | { status: "not_configured" | "not_applicable"; reasonCode: string }
    | undefined;
}

export interface CapturedControlPlane {
  coverage: CoverageEntry[];
}

const SPECS: readonly CaptureSpec[] = [
  {
    id: "database.postgres_config",
    endpoint: "/config/database/postgres",
    contract: "PostgresConfigResponse",
    sensitivity: "internal",
    artifact: "control-plane/database-postgres.json",
    protected: false,
  },
  {
    id: "database.pooler",
    endpoint: "/config/database/pooler",
    contract: "SupavisorConfigResponseArray",
    sensitivity: "secret",
    artifact: "secrets/control-plane/database-pooler.json",
    protected: true,
    classify: (value) =>
      Array.isArray(value) && value.length === 0
        ? "not_configured"
        : "backed_up",
  },
  {
    id: "database.pgbouncer",
    endpoint: "/config/database/pgbouncer",
    contract: "V1PgbouncerConfigResponse",
    sensitivity: "secret",
    artifact: "secrets/control-plane/database-pgbouncer.json",
    protected: true,
    restoreFidelity: "not_identically_restorable",
    classify: (value) =>
      value !== null &&
      typeof value === "object" &&
      Object.keys(value).length === 0
        ? "not_configured"
        : "backed_up",
    unavailable: (status) =>
      status === 404
        ? { status: "not_applicable", reasonCode: "pgbouncer_not_available" }
        : undefined,
  },
  {
    id: "database.ssl",
    endpoint: "/ssl-enforcement",
    contract: "SslEnforcementResponse",
    sensitivity: "internal",
    artifact: "control-plane/database-ssl.json",
    protected: false,
  },
  {
    id: "database.backup_schedule",
    endpoint: "/database/backups/schedule",
    contract: "V1BackupScheduleResponse",
    sensitivity: "internal",
    artifact: "control-plane/database-backup-schedule.json",
    protected: false,
    restoreFidelity: "not_identically_restorable",
    unavailable: (status) => {
      if (status === 402)
        return { status: "not_applicable", reasonCode: "plan_not_entitled" };
      if (status === 404)
        return {
          status: "not_configured",
          reasonCode: "schedule_not_configured",
        };
      return undefined;
    },
  },
  {
    id: "realtime.config",
    endpoint: "/config/realtime",
    contract: "RealtimeConfigResponse",
    sensitivity: "internal",
    artifact: "control-plane/realtime.json",
    protected: false,
  },
  {
    id: "rest.postgrest_config",
    endpoint: "/postgrest",
    contract: "PostgrestConfigWithJWTSecretResponse",
    sensitivity: "secret",
    artifact: "secrets/control-plane/postgrest.json",
    protected: true,
  },
  {
    id: "storage.service_config",
    endpoint: "/config/storage",
    contract: "StorageConfigResponse",
    sensitivity: "internal",
    artifact: "control-plane/storage.json",
    protected: false,
  },
  {
    id: "domains.custom_hostname",
    endpoint: "/custom-hostname",
    contract: "UpdateCustomHostnameResponse",
    sensitivity: "internal",
    artifact: "control-plane/custom-hostname.json",
    protected: false,
    restoreFidelity: "not_identically_restorable",
    unavailable: (status) =>
      status === 400
        ? { status: "not_applicable", reasonCode: "plan_not_entitled" }
        : status === 404
          ? { status: "not_configured", reasonCode: "hostname_not_configured" }
          : undefined,
  },
  {
    id: "domains.vanity_subdomain",
    endpoint: "/vanity-subdomain",
    contract: "VanitySubdomainConfigResponse",
    sensitivity: "internal",
    artifact: "control-plane/vanity-subdomain.json",
    protected: false,
    restoreFidelity: "not_identically_restorable",
    classify: (value) =>
      value !== null &&
      typeof value === "object" &&
      Reflect.get(value, "status") === "not-used"
        ? "not_configured"
        : "backed_up",
    unavailable: (status) =>
      status === 400
        ? { status: "not_applicable", reasonCode: "plan_not_entitled" }
        : undefined,
  },
  {
    id: "network.restrictions",
    endpoint: "/network-restrictions",
    contract: "NetworkRestrictionsResponse",
    sensitivity: "internal",
    artifact: "control-plane/network-restrictions.json",
    protected: false,
    classify: (value) => {
      if (value === null || typeof value !== "object") return "backed_up";
      if (Reflect.get(value, "entitlement") === "disallowed")
        return "not_applicable";
      const record = value as Record<string, unknown>;
      const config = record["config"];
      if (config === null || typeof config !== "object") return "backed_up";
      const configRecord = config as Record<string, unknown>;
      const ipv4 = configRecord["dbAllowedCidrs"];
      const ipv6 = configRecord["dbAllowedCidrsV6"];
      return Array.isArray(ipv4) &&
        ipv4.length === 0 &&
        Array.isArray(ipv6) &&
        ipv6.length === 0
        ? "not_configured"
        : "backed_up";
    },
  },
];

function httpStatus(error: unknown): number | undefined {
  const status = (error as Partial<PgDumpsterError> | undefined)?.details?.[
    "status"
  ];
  return typeof status === "number" ? status : undefined;
}

function registerSecrets(value: unknown, redactor: Redactor): void {
  if (Array.isArray(value)) {
    for (const entry of value) registerSecrets(entry, redactor);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      ["connection_string", "connectionString", "jwt_secret"].includes(key) &&
      typeof entry === "string" &&
      entry.length >= 4
    ) {
      redactor.register(entry);
    } else {
      registerSecrets(entry, redactor);
    }
  }
}

function sourceContract(spec: CaptureSpec): Record<string, unknown> {
  return {
    adapter: "management-api-control-plane-v1",
    endpoint: `GET /v1/projects/{ref}${spec.endpoint}`,
    openapiSha256: CONTROL_PLANE_CONTRACT_SOURCE_SHA256,
    ...(spec.restoreFidelity === undefined
      ? {}
      : { restoreFidelity: spec.restoreFidelity }),
  };
}

async function captureSpec(
  spec: CaptureSpec,
  client: ManagementClient,
  projectRef: string,
  ordinary: BundleArtifactSink,
  protectedSink: ProtectedArtifactSink,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<{ coverage: CoverageEntry; value?: unknown }> {
  const requestOptions = signal === undefined ? {} : { signal };
  let value: unknown;
  try {
    value = await client.get(
      `/v1/projects/${encodeURIComponent(projectRef)}${spec.endpoint}`,
      controlPlaneContractSchema(spec.contract),
      requestOptions,
    );
  } catch (error) {
    const status = httpStatus(error);
    const unavailable =
      status === undefined ? undefined : spec.unavailable?.(status);
    if (unavailable === undefined) throw error;
    return {
      coverage: {
        id: spec.id,
        status: unavailable.status,
        reasonCode: unavailable.reasonCode,
        sensitivity: spec.sensitivity,
        artifacts: [],
        sourceContract: sourceContract(spec),
      },
    };
  }
  if (spec.protected) registerSecrets(value, redactor);
  const document = {
    sourceContract: sourceContract(spec),
    data: value,
  };
  if (spec.protected) {
    await protectedSink.writeJson(spec.artifact, document, signal);
  } else {
    await ordinary.writeJson(spec.artifact, document, signal);
  }
  return {
    coverage: {
      id: spec.id,
      status: spec.classify?.(value) ?? "backed_up",
      sensitivity: spec.sensitivity,
      artifacts: [spec.artifact],
      sourceContract: sourceContract(spec),
    },
    value,
  };
}

interface PoolerTopologyRow {
  identifier: unknown;
  database_type: unknown;
  db_host: unknown;
  db_port: unknown;
  db_name: unknown;
}

function isReadReplica(value: unknown): value is PoolerTopologyRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Partial<PoolerTopologyRow>;
  return row.database_type === "READ_REPLICA";
}

function readReplicaTopology(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isReadReplica)
    .map((entry) => ({
      identifier: entry.identifier,
      databaseType: entry.database_type,
      host: entry.db_host,
      port: entry.db_port,
      database: entry.db_name,
    }))
    .sort((left, right) =>
      String(left.identifier).localeCompare(String(right.identifier), "en"),
    );
}

export async function captureControlPlaneState(
  client: ManagementClient,
  projectRef: string,
  ordinary: BundleArtifactSink,
  protectedSink: ProtectedArtifactSink,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<CapturedControlPlane> {
  const coverage: CoverageEntry[] = [];
  for (const spec of SPECS) {
    const captured = await captureSpec(
      spec,
      client,
      projectRef,
      ordinary,
      protectedSink,
      redactor,
      signal,
    );
    coverage.push(captured.coverage);
    if (spec.id === "database.pooler" && captured.value !== undefined) {
      const replicas = readReplicaTopology(captured.value);
      const artifact = "control-plane/read-replicas.json";
      const contract = sourceContract(spec);
      await ordinary.writeJson(
        artifact,
        { sourceContract: contract, data: replicas },
        signal,
      );
      coverage.push({
        id: "project.read_replicas",
        status: replicas.length === 0 ? "not_configured" : "backed_up",
        sensitivity: "internal",
        artifacts: [artifact],
        sourceContract: {
          ...contract,
          restoreFidelity: "not_identically_restorable",
        },
      });
    }
  }
  return { coverage };
}
