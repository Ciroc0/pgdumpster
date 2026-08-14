import { readFileSync } from "node:fs";

import { z } from "zod";

import { openApiContractSchema } from "./openapi-schema.js";

const snapshotSchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  responseSchemas: z.record(z.string(), z.unknown()),
  schemas: z.record(z.string(), z.unknown()),
});

const snapshot = snapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../contracts/supabase-platform-v2-contracts-2026-08-14.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export type PlatformV2ContractPath =
  | "/v2/projects/{ref}/analytics/log-drains"
  | "/v2/projects/{ref}/private-link/associations";

const compiled = new Map<PlatformV2ContractPath, z.ZodType<unknown>>();

export function platformV2ContractSchema(
  path: PlatformV2ContractPath,
): z.ZodType<unknown> {
  const existing = compiled.get(path);
  if (existing !== undefined) return existing;
  const response = snapshot.responseSchemas[`GET ${path}`];
  if (
    response === undefined ||
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    throw new Error(`Platform v2 response contract is missing: ${path}`);
  }
  const schema = openApiContractSchema(
    { ...response, components: { schemas: snapshot.schemas } },
    `Platform v2 contract GET ${path}`,
  );
  compiled.set(path, schema);
  return schema;
}

export const PLATFORM_V2_CONTRACT_SOURCE_SHA256 = snapshot.sourceSha256;
