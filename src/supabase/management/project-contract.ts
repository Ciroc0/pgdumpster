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
        "../../../contracts/supabase-project-contracts-2026-08-14.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export type ProjectContractPath =
  | "/v1/projects/{ref}"
  | "/v1/projects/{ref}/config/disk/autoscale"
  | "/v1/projects/{ref}/billing/addons"
  | "/v1/projects/{ref}/jit-access"
  | "/v1/projects/{ref}/branches"
  | "/v1/projects/{ref}/health"
  | "/v1/projects/{ref}/advisors/performance"
  | "/v1/projects/{ref}/advisors/security";

const compiled = new Map<ProjectContractPath, z.ZodType<unknown>>();

export function projectContractSchema(
  path: ProjectContractPath,
): z.ZodType<unknown> {
  const existing = compiled.get(path);
  if (existing !== undefined) return existing;
  const response = snapshot.responseSchemas[`GET ${path}`];
  if (response === undefined)
    throw new Error(`Project response contract is missing: ${path}`);
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    throw new Error(`Project response contract is invalid: ${path}`);
  }
  const schema = openApiContractSchema(
    { ...response, components: { schemas: snapshot.schemas } },
    `Project contract GET ${path}`,
  );
  compiled.set(path, schema);
  return schema;
}

export const PROJECT_CONTRACT_SOURCE_SHA256 = snapshot.sourceSha256;
