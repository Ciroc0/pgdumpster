import { readFileSync } from "node:fs";

import { z } from "zod";

import { openApiContractSchema } from "./openapi-schema.js";

const snapshotSchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemas: z.record(z.string(), z.unknown()),
});

const snapshot = snapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/supabase-control-plane-contracts-2026-08-14.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export type ControlPlaneContractName =
  | "PostgresConfigResponse"
  | "SupavisorConfigResponseArray"
  | "V1PgbouncerConfigResponse"
  | "SslEnforcementResponse"
  | "V1BackupScheduleResponse"
  | "RealtimeConfigResponse"
  | "PostgrestConfigWithJWTSecretResponse"
  | "StorageConfigResponse"
  | "UpdateCustomHostnameResponse"
  | "VanitySubdomainConfigResponse"
  | "NetworkRestrictionsResponse"
  | "UpdatePostgresConfigBody"
  | "UpdateSupavisorConfigBody"
  | "UpdateSupavisorConfigResponse"
  | "SslEnforcementRequest"
  | "UpdateRealtimeConfigBody"
  | "V1UpdatePostgrestConfigBody"
  | "V1PostgrestConfigResponse"
  | "UpdateStorageConfigBody"
  | "NetworkRestrictionsPatchRequest"
  | "NetworkRestrictionsV2Response";

const compiled = new Map<ControlPlaneContractName, z.ZodType<unknown>>();

const LIVE_VERIFIED_OPTIONAL_FIELDS: Partial<
  Record<ControlPlaneContractName, readonly string[]>
> = {
  RealtimeConfigResponse: ["private_only", "postgres_changes_pool"],
  StorageConfigResponse: ["databasePoolMode"],
};

function rootSchema(name: ControlPlaneContractName): unknown {
  if (name === "SupavisorConfigResponseArray") {
    return {
      type: "array",
      items: { $ref: "#/components/schemas/SupavisorConfigResponse" },
      components: { schemas: snapshot.schemas },
    };
  }
  const schema = snapshot.schemas[name];
  if (schema === undefined) {
    throw new Error(`Control-plane contract schema is missing: ${name}`);
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`Control-plane contract schema is invalid: ${name}`);
  }
  const optional = LIVE_VERIFIED_OPTIONAL_FIELDS[name];
  if (optional === undefined) {
    return { ...schema, components: { schemas: snapshot.schemas } };
  }
  const required = (schema as Record<string, unknown>)["required"];
  if (!Array.isArray(required)) {
    throw new Error(`Control-plane contract expected required fields: ${name}`);
  }
  return {
    ...schema,
    required: required.filter(
      (field): field is string =>
        typeof field === "string" && !optional.includes(field),
    ),
    components: { schemas: snapshot.schemas },
  };
}

export function controlPlaneContractSchema(
  name: ControlPlaneContractName,
): z.ZodType<unknown> {
  const existing = compiled.get(name);
  if (existing !== undefined) return existing;
  const schema = openApiContractSchema(
    rootSchema(name),
    `Control-plane contract ${name}`,
  );
  compiled.set(name, schema);
  return schema;
}

export const CONTROL_PLANE_CONTRACT_SOURCE_SHA256 = snapshot.sourceSha256;

export function controlPlaneContractPropertyNames(
  name: ControlPlaneContractName,
): readonly string[] {
  const schema = snapshot.schemas[name];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`Control-plane contract schema is invalid: ${name}`);
  }
  const properties = (schema as Record<string, unknown>)["properties"];
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    throw new Error(`Control-plane contract has no object properties: ${name}`);
  }
  return Object.keys(properties).sort();
}
