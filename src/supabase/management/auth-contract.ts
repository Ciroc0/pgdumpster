import { readFileSync } from "node:fs";

import { z } from "zod";

import { openApiContractSchema } from "./openapi-schema.js";

const contractSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    schemas: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const snapshot = contractSnapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/supabase-auth-contracts-2026-08-15.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export type AuthContractName =
  | "AuthConfigResponse"
  | "UpdateAuthConfigBody"
  | "ListProvidersResponse"
  | "ThirdPartyAuth"
  | "SigningKeysResponse"
  | "SigningKeyResponse";

const schemas = new Map<AuthContractName, z.ZodType<unknown>>();

function liveCompatibleSchema(
  name: AuthContractName,
  schema: unknown,
): unknown {
  if (name !== "AuthConfigResponse") return schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("AuthConfigResponse schema is invalid");
  }
  const required = (schema as Record<string, unknown>)["required"];
  if (!Array.isArray(required)) {
    throw new Error("AuthConfigResponse required fields are missing");
  }
  return {
    ...schema,
    required: required.filter(
      (field) => field !== "nimbus_oauth_email_optional",
    ),
  };
}

function validator(name: AuthContractName): z.ZodType<unknown> {
  const existing = schemas.get(name);
  if (existing !== undefined) return existing;
  const schema = snapshot.schemas[name];
  if (schema === undefined)
    throw new Error(`Auth contract schema is missing: ${name}`);
  const compiled = openApiContractSchema(
    liveCompatibleSchema(name, schema),
    `Auth contract ${name}`,
  );
  schemas.set(name, compiled);
  return compiled;
}

export function authContractSchema(name: AuthContractName): z.ZodType<unknown> {
  return validator(name);
}

export function authConfigSecretFieldNames(): string[] {
  const schema = snapshot.schemas["AuthConfigResponse"];
  if (
    schema === null ||
    typeof schema !== "object" ||
    !("properties" in schema)
  ) {
    throw new Error("AuthConfigResponse properties are missing");
  }
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object") {
    throw new Error("AuthConfigResponse properties are invalid");
  }
  return Object.keys(properties)
    .filter((name) =>
      /(?:_secret|_secrets|_access_key|_api_key|_auth_token|smtp_pass)$/u.test(
        name,
      ),
    )
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function authConfigUpdateFieldNames(): string[] {
  const schema = snapshot.schemas["UpdateAuthConfigBody"];
  if (
    schema === null ||
    typeof schema !== "object" ||
    !("properties" in schema)
  ) {
    throw new Error("UpdateAuthConfigBody properties are missing");
  }
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object") {
    throw new Error("UpdateAuthConfigBody properties are invalid");
  }
  return Object.keys(properties).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

export const AUTH_CONTRACT_SOURCE_SHA256 = snapshot.sourceSha256;
