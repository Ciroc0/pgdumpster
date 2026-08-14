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
        "../../../contracts/supabase-edge-contracts-2026-08-14.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export type EdgeContractName =
  "SecretResponse" | "FunctionResponse" | "FunctionSlugResponse";

const schemas = new Map<EdgeContractName, z.ZodType<unknown>>();

export function edgeContractSchema(name: EdgeContractName): z.ZodType<unknown> {
  const existing = schemas.get(name);
  if (existing !== undefined) return existing;
  const schema = snapshot.schemas[name];
  if (schema === undefined)
    throw new Error(`Edge contract schema is missing: ${name}`);
  const compiled = openApiContractSchema(schema, `Edge contract ${name}`);
  schemas.set(name, compiled);
  return compiled;
}

export const EDGE_CONTRACT_SOURCE_SHA256 = snapshot.sourceSha256;
