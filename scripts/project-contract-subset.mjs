import { z } from "zod";

const operationSchema = z
  .object({
    operationId: z.string(),
    summary: z.string(),
    responses: z.record(z.string(), z.unknown()),
    parameters: z.array(z.unknown()).optional(),
    "x-oauth-scope": z.string().optional(),
  })
  .passthrough();

const openApiSchema = z
  .object({
    components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
    paths: z.record(
      z.string(),
      z.object({ get: operationSchema.optional() }).passthrough(),
    ),
  })
  .passthrough();

export const projectGetPaths = [
  "/v1/projects/{ref}",
  "/v1/projects/{ref}/config/disk/autoscale",
  "/v1/projects/{ref}/billing/addons",
  "/v1/projects/{ref}/jit-access",
  "/v1/projects/{ref}/branches",
  "/v1/projects/{ref}/health",
  "/v1/projects/{ref}/advisors/performance",
  "/v1/projects/{ref}/advisors/security",
];

/** @param {unknown} value @param {Set<string>} names */
function collectRefs(value, names) {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, names);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") {
      const match = /^#\/components\/schemas\/(.+)$/u.exec(entry);
      if (match?.[1] !== undefined) names.add(match[1]);
    } else {
      collectRefs(entry, names);
    }
  }
}

/** @param {unknown} openapi */
export function extractProjectContractSubset(openapi) {
  const validated = openApiSchema.parse(openapi);
  /** @type {Record<string, unknown>} */
  const operations = {};
  /** @type {Record<string, unknown>} */
  const responseSchemas = {};
  /** @type {Set<string>} */
  const schemaNames = new Set();
  for (const path of projectGetPaths) {
    const operation = validated.paths[path]?.get;
    if (operation === undefined) throw new Error(`Missing GET ${path}`);
    const responseSchema = operation.responses["200"];
    if (responseSchema === undefined)
      throw new Error(`Missing GET ${path} 200 response`);
    collectRefs(responseSchema, schemaNames);
    const key = `GET ${path}`;
    operations[key] = {
      operationId: operation.operationId,
      summary: operation.summary,
      oauthScope: operation["x-oauth-scope"],
      parameters: operation.parameters,
      responses: operation.responses,
    };
    const parsedResponse = z
      .object({
        content: z.object({
          "application/json": z.object({ schema: z.unknown() }),
        }),
      })
      .parse(responseSchema);
    responseSchemas[key] = parsedResponse.content["application/json"].schema;
  }
  /** @type {Record<string, unknown>} */
  const schemas = {};
  const pending = [...schemaNames];
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined) break;
    if (schemas[name] !== undefined) continue;
    const schema = validated.components.schemas[name];
    if (schema === undefined) throw new Error(`Missing OpenAPI schema ${name}`);
    schemas[name] = schema;
    /** @type {Set<string>} */
    const referenced = new Set();
    collectRefs(schema, referenced);
    for (const referencedName of referenced) {
      if (schemas[referencedName] === undefined) pending.push(referencedName);
    }
  }
  return { operations, responseSchemas, schemas };
}
