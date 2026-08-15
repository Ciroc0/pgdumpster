import type { BundleArtifactSink } from "../../core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../../core/bundle/schemas.js";
import type { ManagementClient } from "./client.js";
import {
  PROJECT_CONTRACT_SOURCE_SHA256,
  projectContractSchema,
  type ProjectContractPath,
} from "./project-contract.js";

type CoverageEntry = CoverageDocument["components"][number];

interface ProjectStateSpec {
  id: string;
  path: ProjectContractPath;
  suffix: string;
  artifact: string;
  sensitivity: CoverageEntry["sensitivity"];
  restoreFidelity?: "not_identically_restorable";
  query?: Readonly<Record<string, string>>;
  status?: (value: unknown) => CoverageEntry["status"];
}

const SPECS: readonly ProjectStateSpec[] = [
  {
    id: "project.metadata",
    path: "/v1/projects/{ref}",
    suffix: "",
    artifact: "control-plane/project.json",
    sensitivity: "internal",
  },
  {
    id: "project.disk_autoscale",
    path: "/v1/projects/{ref}/config/disk/autoscale",
    suffix: "/config/disk/autoscale",
    artifact: "control-plane/disk-autoscale.json",
    sensitivity: "internal",
    restoreFidelity: "not_identically_restorable",
    status: (value) => {
      if (value === null || typeof value !== "object") return "backed_up";
      return Object.values(value).every((entry) => entry === null)
        ? "not_configured"
        : "backed_up";
    },
  },
  {
    id: "project.addons",
    path: "/v1/projects/{ref}/billing/addons",
    suffix: "/billing/addons",
    artifact: "control-plane/addons.json",
    sensitivity: "internal",
    restoreFidelity: "not_identically_restorable",
    status: (value) => {
      if (value === null || typeof value !== "object") return "backed_up";
      const selected = Reflect.get(value, "selected_addons") as unknown;
      return Array.isArray(selected) && selected.length === 0
        ? "not_configured"
        : "backed_up";
    },
  },
  {
    id: "project.jit_access",
    path: "/v1/projects/{ref}/jit-access",
    suffix: "/jit-access",
    artifact: "control-plane/jit-access.json",
    sensitivity: "sensitive",
    restoreFidelity: "not_identically_restorable",
    status: (value) =>
      value !== null &&
      typeof value === "object" &&
      Reflect.get(value, "state") === "unavailable"
        ? "not_applicable"
        : "backed_up",
  },
  {
    id: "project.branches",
    path: "/v1/projects/{ref}/branches",
    suffix: "/branches",
    artifact: "control-plane/branches.json",
    sensitivity: "internal",
  },
  {
    id: "diagnostics.health",
    path: "/v1/projects/{ref}/health",
    suffix: "/health",
    artifact: "diagnostics/health.json",
    sensitivity: "internal",
    query: {
      services:
        "auth,db,db_postgres_user,pooler,realtime,rest,storage,pg_bouncer",
    },
  },
];

const ADVISOR_SPECS = [
  {
    path: "/v1/projects/{ref}/advisors/performance" as const,
    suffix: "/advisors/performance",
    artifact: "diagnostics/advisors-performance.json",
  },
  {
    path: "/v1/projects/{ref}/advisors/security" as const,
    suffix: "/advisors/security",
    artifact: "diagnostics/advisors-security.json",
    query: { lint_type: "sql" },
  },
] as const;

function sourceContract(
  path: ProjectContractPath,
  restoreFidelity?: "not_identically_restorable",
): Record<string, unknown> {
  return {
    adapter: "management-api-project-state-v1",
    endpoint: `GET ${path}`,
    openapiSha256: PROJECT_CONTRACT_SOURCE_SHA256,
    ...(restoreFidelity === undefined ? {} : { restoreFidelity }),
  };
}

export async function captureProjectState(
  client: ManagementClient,
  projectRef: string,
  sink: BundleArtifactSink,
  signal?: AbortSignal,
): Promise<{ coverage: CoverageEntry[] }> {
  const encodedRef = encodeURIComponent(projectRef);
  const coverage: CoverageEntry[] = [];
  for (const spec of SPECS) {
    const value = await client.get(
      `/v1/projects/${encodedRef}${spec.suffix}`,
      projectContractSchema(spec.path),
      {
        ...(signal === undefined ? {} : { signal }),
        ...(spec.query === undefined ? {} : { query: spec.query }),
      },
    );
    const contract = sourceContract(spec.path, spec.restoreFidelity);
    await sink.writeJson(
      spec.artifact,
      { sourceContract: contract, data: value },
      signal,
    );
    coverage.push({
      id: spec.id,
      status: spec.status?.(value) ?? "backed_up",
      sensitivity: spec.sensitivity,
      artifacts: [spec.artifact],
      sourceContract: contract,
    });
  }
  const advisorArtifacts: string[] = [];
  const advisorContracts: Record<string, unknown>[] = [];
  for (const spec of ADVISOR_SPECS) {
    const value = await client.get(
      `/v1/projects/${encodedRef}${spec.suffix}`,
      projectContractSchema(spec.path),
      {
        ...(signal === undefined ? {} : { signal }),
        ...("query" in spec ? { query: spec.query } : {}),
      },
    );
    const contract = sourceContract(spec.path);
    await sink.writeJson(
      spec.artifact,
      { sourceContract: contract, data: value },
      signal,
    );
    advisorArtifacts.push(spec.artifact);
    advisorContracts.push(contract);
  }
  coverage.push({
    id: "diagnostics.readonly",
    status: "backed_up",
    sensitivity: "internal",
    artifacts: advisorArtifacts,
    sourceContract: {
      adapter: "management-api-advisors-v1",
      contracts: advisorContracts,
    },
  });
  return { coverage };
}
