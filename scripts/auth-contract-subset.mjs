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
    post: operationSchema.optional(),
    patch: operationSchema.optional(),
    put: operationSchema.optional(),
    delete: operationSchema.optional(),
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
  "CreateProviderBody",
  "CreateProviderResponse",
  "UpdateProviderBody",
  "UpdateProviderResponse",
  "DeleteProviderResponse",
  "ThirdPartyAuth",
  "CreateThirdPartyAuthBody",
  "SigningKeysResponse",
  "SigningKeyResponse",
];

export const authPaths = [
  "/v1/projects/{ref}/config/auth",
  "/v1/projects/{ref}/config/auth/sso/providers",
  "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
  "/v1/projects/{ref}/config/auth/third-party-auth",
  "/v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}",
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
      const operations = validated.paths[pathname];
      const methods = [
        { method: "post", operation: operations?.post },
        { method: "put", operation: operations?.put },
        { method: "patch", operation: operations?.patch },
        { method: "delete", operation: operations?.delete },
      ];
      const mutations = Object.fromEntries(
        methods.flatMap(({ method, operation }) => {
          if (operation === undefined) return [];
          return [
            [
              method,
              {
                operationId: operation.operationId,
                summary: operation.summary,
                oauthScope: operation["x-oauth-scope"],
                ...(operation.requestBody === undefined
                  ? {}
                  : { requestBody: operation.requestBody }),
                responses: operation.responses,
              },
            ],
          ];
        }),
      );
      return [
        pathname,
        {
          operationId: get.operationId,
          summary: get.summary,
          oauthScope: get["x-oauth-scope"],
          responses: get.responses,
          ...mutations,
        },
      ];
    }),
  );
  return { operations, schemas };
}
