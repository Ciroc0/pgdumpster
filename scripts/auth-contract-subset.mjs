import { z } from "zod";

const operationSchema = z
  .object({
    operationId: z.string(),
    summary: z.string(),
    responses: z.record(z.string(), z.unknown()),
    "x-oauth-scope": z.string().optional(),
  })
  .passthrough();

export const authOpenApiSchema = z
  .object({
    components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
    paths: z.record(
      z.string(),
      z.object({ get: operationSchema.optional() }).passthrough(),
    ),
  })
  .passthrough();

export const authSchemaNames = [
  "AuthConfigResponse",
  "ListProvidersResponse",
  "ThirdPartyAuth",
  "SigningKeysResponse",
  "SigningKeyResponse",
];

export const authPaths = [
  "/v1/projects/{ref}/config/auth",
  "/v1/projects/{ref}/config/auth/sso/providers",
  "/v1/projects/{ref}/config/auth/third-party-auth",
  "/v1/projects/{ref}/config/auth/signing-keys",
  "/v1/projects/{ref}/config/auth/signing-keys/legacy",
];

/** @param {unknown} openapi */
export function extractAuthContractSubset(openapi) {
  const validated = authOpenApiSchema.parse(openapi);
  const schemas = Object.fromEntries(
    authSchemaNames.map((name) => {
      const schema = validated.components.schemas[name];
      if (schema === undefined)
        throw new Error(`Missing OpenAPI schema ${name}`);
      return [name, schema];
    }),
  );
  const operations = Object.fromEntries(
    authPaths.map((pathname) => {
      const operation = validated.paths[pathname]?.get;
      if (operation === undefined) throw new Error(`Missing GET ${pathname}`);
      return [
        pathname,
        {
          operationId: operation.operationId,
          summary: operation.summary,
          oauthScope: operation["x-oauth-scope"],
          responses: operation.responses,
        },
      ];
    }),
  );
  return { operations, schemas };
}
