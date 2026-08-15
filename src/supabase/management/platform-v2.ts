import type { BundleArtifactSink } from "../../core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../../core/bundle/schemas.js";
import type { PgDumpsterError } from "../../core/errors/error.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import type { Redactor } from "../../security/redactor.js";
import type { ManagementClient } from "./client.js";
import {
  PROJECT_CONTRACT_SOURCE_SHA256,
  projectContractSchema,
} from "./project-contract.js";
import {
  PLATFORM_V2_CONTRACT_SOURCE_SHA256,
  platformV2ContractSchema,
  type PlatformV2ContractPath,
} from "./platform-v2-contract.js";

type CoverageEntry = CoverageDocument["components"][number];

function dataArray(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [];
  const data = Reflect.get(value, "data") as unknown;
  return Array.isArray(data) ? data : [];
}

function registerAllStrings(value: unknown, redactor: Redactor): void {
  if (typeof value === "string") {
    if (value.length >= 4) redactor.register(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) registerAllStrings(item, redactor);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const item of Object.values(value)) registerAllStrings(item, redactor);
}

function registerConfigStrings(value: unknown, redactor: Redactor): void {
  if (Array.isArray(value)) {
    for (const item of value) registerConfigStrings(item, redactor);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "config") registerAllStrings(item, redactor);
    else registerConfigStrings(item, redactor);
  }
}

function sourceContract(
  path: PlatformV2ContractPath,
  restoreFidelity?: "not_identically_restorable",
): Record<string, unknown> {
  return {
    adapter: "management-api-platform-v2",
    endpoint: `GET ${path}`,
    openapiSha256: PLATFORM_V2_CONTRACT_SOURCE_SHA256,
    ...(restoreFidelity === undefined ? {} : { restoreFidelity }),
  };
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as Partial<PgDumpsterError> | undefined)?.details?.[
    "status"
  ];
  return typeof status === "number" ? status : undefined;
}

function addonTypes(value: unknown, key: string): Set<string> {
  if (value === null || typeof value !== "object") return new Set();
  const entries = Reflect.get(value, key) as unknown;
  if (!Array.isArray(entries)) return new Set();
  const types = new Set<string>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const type = Reflect.get(entry, "type") as unknown;
    if (typeof type === "string") types.add(type);
  }
  return types;
}

async function proveLogDrainNotConfigured(
  client: ManagementClient,
  encodedRef: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const addons = await client.get(
    `/v1/projects/${encodedRef}/billing/addons`,
    projectContractSchema("/v1/projects/{ref}/billing/addons"),
    signal === undefined ? {} : { signal },
  );
  const selected = addonTypes(addons, "selected_addons");
  const available = addonTypes(addons, "available_addons");
  return available.has("log_drain") && !selected.has("log_drain");
}

export async function capturePlatformV2State(
  client: ManagementClient,
  projectRef: string,
  ordinary: BundleArtifactSink,
  protectedSink: ProtectedArtifactSink,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<{ coverage: CoverageEntry[] }> {
  const encodedRef = encodeURIComponent(projectRef);
  const logDrainPath = "/v2/projects/{ref}/analytics/log-drains" as const;
  let logDrains: unknown;
  let logDrainReasonCode: string | undefined;
  try {
    logDrains = await client.get(
      `/v2/projects/${encodedRef}/analytics/log-drains`,
      platformV2ContractSchema(logDrainPath),
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (
      httpStatus(error) !== 403 ||
      !(await proveLogDrainNotConfigured(client, encodedRef, signal))
    ) {
      throw error;
    }
    logDrains = {
      data: [],
      availabilityEvidence: {
        logDrainAddonAvailable: true,
        logDrainAddonSelected: false,
      },
    };
    logDrainReasonCode = "log_drain_addon_not_selected";
  }
  registerConfigStrings(logDrains, redactor);
  const logDrainArtifact = "secrets/control-plane/log-drains.json";
  const logDrainContract = sourceContract(
    logDrainPath,
    "not_identically_restorable",
  );
  const logDrainSourceContract =
    logDrainReasonCode === undefined
      ? logDrainContract
      : {
          ...logDrainContract,
          availabilityEndpoint: "GET /v1/projects/{ref}/billing/addons",
          availabilityOpenapiSha256: PROJECT_CONTRACT_SOURCE_SHA256,
        };
  await protectedSink.writeJson(
    logDrainArtifact,
    { sourceContract: logDrainSourceContract, data: logDrains },
    signal,
  );

  const privateLinkPath =
    "/v2/projects/{ref}/private-link/associations" as const;
  const privateLinks = await client.get(
    `/v2/projects/${encodedRef}/private-link/associations`,
    platformV2ContractSchema(privateLinkPath),
    signal === undefined ? {} : { signal },
  );
  const privateLinkArtifact = "control-plane/private-link.json";
  const privateLinkContract = sourceContract(
    privateLinkPath,
    "not_identically_restorable",
  );
  await ordinary.writeJson(
    privateLinkArtifact,
    { sourceContract: privateLinkContract, data: privateLinks },
    signal,
  );

  return {
    coverage: [
      {
        id: "project.log_drains",
        status:
          dataArray(logDrains).length === 0 ? "not_configured" : "backed_up",
        ...(logDrainReasonCode === undefined
          ? {}
          : { reasonCode: logDrainReasonCode }),
        sensitivity: "secret",
        artifacts: [logDrainArtifact],
        sourceContract: logDrainSourceContract,
      },
      {
        id: "network.private_link",
        status:
          dataArray(privateLinks).length === 0 ? "not_configured" : "backed_up",
        sensitivity: "internal",
        artifacts: [privateLinkArtifact],
        sourceContract: privateLinkContract,
      },
    ],
  };
}
