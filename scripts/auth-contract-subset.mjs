import { z } from "zod";

const operationSchema = z
  .object({
    operationId: z.string(),
    summary: z.string(),
    responses: z.record(z.string(), z.unknown()),
    "x-oauth-scope": z.string().optional(),
  })
  .passthrough();

const authPathSchema = z
  .object({
    get: operationSchema.optional(),
    patch: operationSchema.optional(),
  })
  .passthrough();

export const authOpenApiSchema = z
  .object({
    components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
    paths: z.record(z.string(), authPathSchema),
  })
  .passthrough();

export const authSchemaNames = [
  "AuthConfigResponse",
  "UpdateAuthConfigBody",
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
      const get = validated.paths[pathname]?.get;
      if (get === undefined) throw new Error(`Missing GET ${pathname}`);
      const patch =
        pathname === "/v1/projects/{ref}/config/auth"
          ? validated.paths[pathname]?.patch
          : undefined;
      if (pathname === "/v1/projects/{ref}/config/auth" && patch === undefined)
        throw new Error(`Missing PATCH ${pathname}`);
      return [
        pathname,
        {
          operationId: get.operationId,
          summary: get.summary,
          oauthScope: get["x-oauth-scope"],
          responses: get.responses,
          ...(patch === undefined
            ? {}
            : {
                patch: {
                  operationId: patch.operationId,
                  summary: patch.summary,
                  oauthScope: patch["x-oauth-scope"],
                  requestBody: patch.requestBody,
                  responses: patch.responses,
                },
              }),
        },
      ];
    }),
  );
  return { operations, schemas };
}
