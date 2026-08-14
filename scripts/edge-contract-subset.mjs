import { z } from "zod";

const operationSchema = z
  .object({
    operationId: z.string(),
    summary: z.string(),
    responses: z.record(z.string(), z.unknown()),
    parameters: z.array(z.unknown()).optional(),
    requestBody: z.unknown().optional(),
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
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const edgeSchemaNames = [
  "SecretResponse",
  "CreateSecretBody",
  "FunctionResponse",
  "FunctionSlugResponse",
  "FunctionDeployBody",
  "DeployFunctionResponse",
  "StreamableFile",
];

/** @param {unknown} openapi */
export function extractEdgeContractSubset(openapi) {
  const validated = openApiSchema.parse(openapi);
  const schemas = Object.fromEntries(
    edgeSchemaNames.map((name) => {
      const schema = validated.components.schemas[name];
      if (schema === undefined)
        throw new Error(`Missing OpenAPI schema ${name}`);
      return [name, schema];
    }),
  );
  const functionsPath = validated.paths["/v1/projects/{ref}/functions"];
  const functionPath =
    validated.paths["/v1/projects/{ref}/functions/{function_slug}"];
  const bodyPath =
    validated.paths["/v1/projects/{ref}/functions/{function_slug}/body"];
  const deployPath = validated.paths["/v1/projects/{ref}/functions/deploy"];
  const secretsPath = validated.paths["/v1/projects/{ref}/secrets"];
  const operationSpecs = [
    { key: "GET /v1/projects/{ref}/functions", operation: functionsPath?.get },
    {
      key: "GET /v1/projects/{ref}/functions/{function_slug}",
      operation: functionPath?.get,
    },
    {
      key: "GET /v1/projects/{ref}/functions/{function_slug}/body",
      operation: bodyPath?.get,
    },
    {
      key: "POST /v1/projects/{ref}/functions/deploy",
      operation: deployPath?.post,
    },
    { key: "GET /v1/projects/{ref}/secrets", operation: secretsPath?.get },
    { key: "POST /v1/projects/{ref}/secrets", operation: secretsPath?.post },
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
          requestBody: operation.requestBody,
          responses: operation.responses,
        },
      ];
    }),
  );
  return { operations, schemas };
}
