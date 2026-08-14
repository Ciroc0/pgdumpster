import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import { canonicalJson } from "../../utils/canonical-json.js";
import type { ManagementClient } from "../../supabase/management/client.js";
import {
  controlPlaneContractPropertyNames,
  controlPlaneContractSchema,
  type ControlPlaneContractName,
} from "../../supabase/management/control-plane-contract.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler } from "./executor.js";

type ControlPlaneRestoreComponent =
  | "database.postgres_config"
  | "database.pooler"
  | "database.ssl"
  | "realtime.config"
  | "rest.postgrest_config"
  | "storage.service_config"
  | "network.restrictions";

interface ControlPlaneRestoreSpec {
  component: ControlPlaneRestoreComponent;
  artifact: string;
  endpoint: string;
  sourceContract: ControlPlaneContractName;
  requestContract: ControlPlaneContractName;
  method: "PATCH" | "PUT";
  responseContract?: ControlPlaneContractName | undefined;
  desired(value: unknown): unknown;
}

export interface ControlPlaneRestoreHandlerOptions {
  bundleRoot: string;
  targetProjectRef: string;
  conflictPolicy: "fail" | "replace";
  client: Pick<ManagementClient, "get" | "patch" | "put">;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const artifactDocumentSchema = z
  .object({
    sourceContract: z.record(z.string(), z.unknown()),
    data: z.unknown(),
  })
  .passthrough();

function object(value: unknown, component: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Control-plane restore source is not an object.",
      retryable: false,
      component,
    });
  }
  return value as Record<string, unknown>;
}

function requestFields(
  contract: ControlPlaneContractName,
  value: unknown,
  component: string,
): unknown {
  const source = object(value, component);
  const body: Record<string, unknown> = {};
  for (const key of controlPlaneContractPropertyNames(contract)) {
    const entry = source[key];
    if (entry !== undefined && entry !== null) body[key] = entry;
  }
  return controlPlaneContractSchema(contract).parse(body);
}

function primaryPooler(value: unknown): unknown {
  if (!Array.isArray(value)) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Pooler restore source is not an array.",
      retryable: false,
      component: "database.pooler",
    });
  }
  const primary = (value as unknown[]).find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      Reflect.get(entry, "database_type") === "PRIMARY",
  );
  if (primary === undefined) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Pooler restore source has no primary database configuration.",
      retryable: false,
      component: "database.pooler",
    });
  }
  return requestFields("UpdateSupavisorConfigBody", primary, "database.pooler");
}

function sslDesired(value: unknown): unknown {
  const currentConfig = object(value, "database.ssl")["currentConfig"];
  return controlPlaneContractSchema("SslEnforcementRequest").parse({
    requestedConfig: currentConfig,
  });
}

function sortedUniqueStrings(value: unknown, component: string): string[] {
  if (!Array.isArray(value)) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Network restriction CIDRs are invalid.",
      retryable: false,
      component,
    });
  }
  const strings = (value as unknown[]).filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (strings.length !== value.length) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Network restriction CIDRs are invalid.",
      retryable: false,
      component,
    });
  }
  return [...new Set(strings)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

interface NetworkDesired {
  dbAllowedCidrs: string[];
  dbAllowedCidrsV6: string[];
}

function networkDesired(value: unknown): NetworkDesired {
  const config = object(
    object(value, "network.restrictions")["config"],
    "network.restrictions",
  );
  return {
    dbAllowedCidrs: sortedUniqueStrings(
      config["dbAllowedCidrs"],
      "network.restrictions",
    ),
    dbAllowedCidrsV6: sortedUniqueStrings(
      config["dbAllowedCidrsV6"],
      "network.restrictions",
    ),
  };
}

const SPECS: readonly ControlPlaneRestoreSpec[] = [
  {
    component: "database.postgres_config",
    artifact: "control-plane/database-postgres.json",
    endpoint: "/config/database/postgres",
    sourceContract: "PostgresConfigResponse",
    requestContract: "UpdatePostgresConfigBody",
    responseContract: "PostgresConfigResponse",
    method: "PUT",
    desired: (value) =>
      requestFields(
        "UpdatePostgresConfigBody",
        value,
        "database.postgres_config",
      ),
  },
  {
    component: "database.pooler",
    artifact: "secrets/control-plane/database-pooler.json",
    endpoint: "/config/database/pooler",
    sourceContract: "SupavisorConfigResponseArray",
    requestContract: "UpdateSupavisorConfigBody",
    method: "PATCH",
    desired: primaryPooler,
  },
  {
    component: "database.ssl",
    artifact: "control-plane/database-ssl.json",
    endpoint: "/ssl-enforcement",
    sourceContract: "SslEnforcementResponse",
    requestContract: "SslEnforcementRequest",
    responseContract: "SslEnforcementResponse",
    method: "PUT",
    desired: sslDesired,
  },
  {
    component: "realtime.config",
    artifact: "control-plane/realtime.json",
    endpoint: "/config/realtime",
    sourceContract: "RealtimeConfigResponse",
    requestContract: "UpdateRealtimeConfigBody",
    method: "PATCH",
    desired: (value) =>
      requestFields("UpdateRealtimeConfigBody", value, "realtime.config"),
  },
  {
    component: "rest.postgrest_config",
    artifact: "secrets/control-plane/postgrest.json",
    endpoint: "/postgrest",
    sourceContract: "PostgrestConfigWithJWTSecretResponse",
    requestContract: "V1UpdatePostgrestConfigBody",
    method: "PATCH",
    desired: (value) =>
      requestFields(
        "V1UpdatePostgrestConfigBody",
        value,
        "rest.postgrest_config",
      ),
  },
  {
    component: "storage.service_config",
    artifact: "control-plane/storage.json",
    endpoint: "/config/storage",
    sourceContract: "StorageConfigResponse",
    requestContract: "UpdateStorageConfigBody",
    method: "PATCH",
    desired: (value) =>
      requestFields("UpdateStorageConfigBody", value, "storage.service_config"),
  },
];

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function readSource(
  options: ControlPlaneRestoreHandlerOptions,
  spec: ControlPlaneRestoreSpec,
  artifacts: string[],
): Promise<unknown> {
  if (artifacts.length !== 1 || artifacts[0] !== spec.artifact) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "restore_policy",
      message: "Control-plane restore artifact does not match its component.",
      retryable: false,
      component: spec.component,
    });
  }
  const filename = await resolveBundleArtifact(
    options.bundleRoot,
    spec.artifact,
  );
  const fileStat = await lstat(filename);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.size > 16_777_216
  ) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Control-plane restore artifact is not a bounded regular file.",
      retryable: false,
      component: spec.component,
    });
  }
  try {
    const document = artifactDocumentSchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
    return controlPlaneContractSchema(spec.sourceContract).parse(document.data);
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Control-plane restore artifact failed contract validation.",
      retryable: false,
      component: spec.component,
      cause: error,
    });
  }
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const abortError = (): Error =>
    signal?.reason instanceof Error
      ? signal.reason
      : new Error("Operation aborted", { cause: signal?.reason });
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true },
    );
  });
}

async function currentValue(
  options: ControlPlaneRestoreHandlerOptions,
  spec: ControlPlaneRestoreSpec,
  signal?: AbortSignal,
): Promise<unknown> {
  return options.client.get(
    `/v1/projects/${encodeURIComponent(options.targetProjectRef)}${spec.endpoint}`,
    controlPlaneContractSchema(spec.sourceContract),
    signal === undefined ? {} : { signal },
  );
}

function createHandler(
  options: ControlPlaneRestoreHandlerOptions,
  spec: ControlPlaneRestoreSpec,
): RestoreActionHandler {
  const desiredSource = async (artifacts: string[]) =>
    spec.desired(await readSource(options, spec, artifacts));
  const matches = async (
    artifacts: string[],
    signal?: AbortSignal,
    poll = false,
  ): Promise<boolean> => {
    const source = await desiredSource(artifacts);
    const attempts = poll ? 8 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal?.throwIfAborted();
      const target = spec.desired(await currentValue(options, spec, signal));
      if (canonicalJson(target) === canonicalJson(source)) return true;
      if (attempt < attempts)
        await (options.sleep ?? defaultSleep)(
          Math.min(4_000, attempt * 500),
          signal,
        );
    }
    return false;
  };
  return {
    async apply(context) {
      const source = await desiredSource(context.action.artifacts);
      const expected = fingerprint(source);
      if (await matches(context.action.artifacts, context.signal)) {
        return { fingerprint: expected };
      }
      if (options.conflictPolicy === "fail") {
        throw new PgDumpsterError({
          code: "RESTORE_TARGET_CONFLICT",
          category: "restore_policy",
          message: "Target control-plane configuration differs from source.",
          retryable: false,
          component: spec.component,
        });
      }
      const endpoint = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}${spec.endpoint}`;
      const requestSchema = controlPlaneContractSchema(spec.requestContract);
      if (spec.method === "PATCH") {
        await options.client.patch(
          endpoint,
          source,
          requestSchema,
          context.signal === undefined ? {} : { signal: context.signal },
        );
      } else {
        await options.client.put(
          endpoint,
          source,
          requestSchema,
          controlPlaneContractSchema(spec.responseContract!),
          context.signal === undefined ? {} : { signal: context.signal },
        );
      }
      return { fingerprint: expected };
    },
    async verify(context) {
      const source = await desiredSource(context.action.artifacts);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== fingerprint(source)
      )
        return false;
      return matches(context.action.artifacts, context.signal, true);
    },
  };
}

function networkPatch(
  source: NetworkDesired,
  target: NetworkDesired,
): Record<string, unknown> {
  const addV4 = source.dbAllowedCidrs.filter(
    (entry) => !target.dbAllowedCidrs.includes(entry),
  );
  const addV6 = source.dbAllowedCidrsV6.filter(
    (entry) => !target.dbAllowedCidrsV6.includes(entry),
  );
  const removeV4 = target.dbAllowedCidrs.filter(
    (entry) => !source.dbAllowedCidrs.includes(entry),
  );
  const removeV6 = target.dbAllowedCidrsV6.filter(
    (entry) => !source.dbAllowedCidrsV6.includes(entry),
  );
  const add = {
    ...(addV4.length === 0 ? {} : { dbAllowedCidrs: addV4 }),
    ...(addV6.length === 0 ? {} : { dbAllowedCidrsV6: addV6 }),
  };
  const remove = {
    ...(removeV4.length === 0 ? {} : { dbAllowedCidrs: removeV4 }),
    ...(removeV6.length === 0 ? {} : { dbAllowedCidrsV6: removeV6 }),
  };
  return {
    ...(Object.keys(add).length === 0 ? {} : { add }),
    ...(Object.keys(remove).length === 0 ? {} : { remove }),
  };
}

function createNetworkHandler(
  options: ControlPlaneRestoreHandlerOptions,
): RestoreActionHandler {
  const component = "network.restrictions";
  const artifact = "control-plane/network-restrictions.json";
  const readDesired = async (artifacts: string[]) => {
    const spec: ControlPlaneRestoreSpec = {
      component,
      artifact,
      endpoint: "/network-restrictions",
      sourceContract: "NetworkRestrictionsResponse",
      requestContract: "NetworkRestrictionsPatchRequest",
      method: "PATCH",
      desired: networkDesired,
    };
    return networkDesired(await readSource(options, spec, artifacts));
  };
  const current = async (signal?: AbortSignal) =>
    networkDesired(
      await options.client.get(
        `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/network-restrictions`,
        controlPlaneContractSchema("NetworkRestrictionsResponse"),
        signal === undefined ? {} : { signal },
      ),
    );
  const matches = async (
    source: NetworkDesired,
    signal?: AbortSignal,
    poll = false,
  ) => {
    const attempts = poll ? 8 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (canonicalJson(await current(signal)) === canonicalJson(source))
        return true;
      if (attempt < attempts)
        await (options.sleep ?? defaultSleep)(
          Math.min(4_000, attempt * 500),
          signal,
        );
    }
    return false;
  };
  return {
    async apply(context) {
      const source = await readDesired(context.action.artifacts);
      const expected = fingerprint(source);
      const target = await current(context.signal);
      if (canonicalJson(target) === canonicalJson(source))
        return { fingerprint: expected };
      if (options.conflictPolicy === "fail") {
        throw new PgDumpsterError({
          code: "RESTORE_TARGET_CONFLICT",
          category: "restore_policy",
          message: "Target network restrictions differ from source.",
          retryable: false,
          component,
        });
      }
      const body = networkPatch(source, target);
      await options.client.patch(
        `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/network-restrictions`,
        body,
        controlPlaneContractSchema("NetworkRestrictionsPatchRequest"),
        context.signal === undefined ? {} : { signal: context.signal },
      );
      return { fingerprint: expected };
    },
    async verify(context) {
      const source = await readDesired(context.action.artifacts);
      if (
        context.expectedFingerprint !== undefined &&
        context.expectedFingerprint !== fingerprint(source)
      )
        return false;
      return matches(source, context.signal, true);
    },
  };
}

export function createControlPlaneRestoreHandlers(
  options: ControlPlaneRestoreHandlerOptions,
): Readonly<Record<ControlPlaneRestoreComponent, RestoreActionHandler>> {
  const handlers = Object.fromEntries(
    SPECS.map((spec) => [spec.component, createHandler(options, spec)]),
  ) as Record<ControlPlaneRestoreComponent, RestoreActionHandler>;
  handlers["network.restrictions"] = createNetworkHandler(options);
  return handlers;
}
