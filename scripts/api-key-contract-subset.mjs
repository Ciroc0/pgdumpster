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
          post: operationSchema.optional(),
          patch: operationSchema.optional(),
          put: operationSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const apiKeySchemaNames = [
  "ApiKeyResponse",
  "LegacyApiKeysResponse",
  "CreateApiKeyBody",
  "UpdateApiKeyBody",
];

/** @param {unknown} openapi */
export function extractApiKeyContractSubset(openapi) {
  const validated = openApiSchema.parse(openapi);
  const schemas = Object.fromEntries(
    apiKeySchemaNames.map((name) => {
      const schema = validated.components.schemas[name];
      if (schema === undefined)
        throw new Error(`Missing OpenAPI schema ${name}`);
      return [name, schema];
    }),
  );
  const apiKeyPath = validated.paths["/v1/projects/{ref}/api-keys"];
  const legacyPath = validated.paths["/v1/projects/{ref}/api-keys/legacy"];
  const singleKeyPath = validated.paths["/v1/projects/{ref}/api-keys/{id}"];
  const operationSpecs = [
    { key: "GET /v1/projects/{ref}/api-keys", operation: apiKeyPath?.get },
    { key: "POST /v1/projects/{ref}/api-keys", operation: apiKeyPath?.post },
    {
      key: "GET /v1/projects/{ref}/api-keys/legacy",
      operation: legacyPath?.get,
    },
    {
      key: "PUT /v1/projects/{ref}/api-keys/legacy",
      operation: legacyPath?.put,
    },
    {
      key: "GET /v1/projects/{ref}/api-keys/{id}",
      operation: singleKeyPath?.get,
    },
    {
      key: "PATCH /v1/projects/{ref}/api-keys/{id}",
      operation: singleKeyPath?.patch,
    },
  ];
  const operations = Object.fromEntries(
    operationSpecs.map(({ key, operation }) => {
      if (operation === undefined) throw new Error(`Missing ${key}`);
      return [
        key,
        {
          operationId: operation.operationId,
          summary: operation.summary,
          oauthScope: operation["x-oauth-scope"],
          parameters: operation.parameters,
          responses: operation.responses,
        },
      ];
    }),
  );
  return { operations, schemas };
}
