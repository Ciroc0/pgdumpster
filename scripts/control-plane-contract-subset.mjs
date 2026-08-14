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
      z
        .object({
          get: operationSchema.optional(),
          patch: operationSchema.optional(),
          put: operationSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const controlPlaneGetPaths = [
  "/v1/projects/{ref}/config/database/postgres",
  "/v1/projects/{ref}/config/database/pooler",
  "/v1/projects/{ref}/config/database/pgbouncer",
  "/v1/projects/{ref}/ssl-enforcement",
  "/v1/projects/{ref}/database/backups/schedule",
  "/v1/projects/{ref}/config/realtime",
  "/v1/projects/{ref}/postgrest",
  "/v1/projects/{ref}/config/storage",
  "/v1/projects/{ref}/custom-hostname",
  "/v1/projects/{ref}/vanity-subdomain",
  "/v1/projects/{ref}/network-restrictions",
];

export const controlPlaneWriteOperations = [
  {
    method: "PUT",
    path: "/v1/projects/{ref}/config/database/postgres",
  },
  {
    method: "PATCH",
    path: "/v1/projects/{ref}/config/database/pooler",
  },
  { method: "PUT", path: "/v1/projects/{ref}/ssl-enforcement" },
  { method: "PATCH", path: "/v1/projects/{ref}/config/realtime" },
  { method: "PATCH", path: "/v1/projects/{ref}/postgrest" },
  { method: "PATCH", path: "/v1/projects/{ref}/config/storage" },
  { method: "PATCH", path: "/v1/projects/{ref}/network-restrictions" },
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
export function extractControlPlaneContractSubset(openapi) {
  const validated = openApiSchema.parse(openapi);
  /** @type {Record<string, unknown>} */
  const operations = {};
  /** @type {Set<string>} */
  const schemaNames = new Set();
  for (const path of controlPlaneGetPaths) {
    const operation = validated.paths[path]?.get;
    if (operation === undefined) throw new Error(`Missing GET ${path}`);
    const response = operation.responses["200"];
    if (response === undefined)
      throw new Error(`Missing GET ${path} 200 response`);
    collectRefs(response, schemaNames);
    operations[`GET ${path}`] = {
      operationId: operation.operationId,
      summary: operation.summary,
      oauthScope: operation["x-oauth-scope"],
      parameters: operation.parameters,
      responses: operation.responses,
    };
  }
  for (const { method, path } of controlPlaneWriteOperations) {
    const pathItem = validated.paths[path];
    const operation = method === "PUT" ? pathItem?.put : pathItem?.patch;
    if (operation === undefined) throw new Error(`Missing ${method} ${path}`);
    collectRefs(operation, schemaNames);
    operations[`${method} ${path}`] = {
      operationId: operation.operationId,
      summary: operation.summary,
      oauthScope: operation["x-oauth-scope"],
      parameters: operation.parameters,
      requestBody: operation.requestBody,
      responses: operation.responses,
    };
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
    const before = new Set(Object.keys(schemas));
    /** @type {Set<string>} */
    const referenced = new Set();
    collectRefs(schema, referenced);
    for (const referencedName of referenced) {
      if (!before.has(referencedName)) pending.push(referencedName);
    }
  }
  return { operations, schemas };
}
