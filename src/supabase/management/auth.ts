import type { CoverageDocument } from "../../core/bundle/schemas.js";
import type { PgDumpsterError } from "../../core/errors/error.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import type { Redactor } from "../../security/redactor.js";
import type { ManagementClient } from "./client.js";
import {
  AUTH_CONTRACT_SOURCE_SHA256,
  authConfigSecretFieldNames,
  authContractSchema,
} from "./auth-contract.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface CapturedAuthControlPlane {
  coverage: CoverageEntry[];
}

const ARTIFACTS = {
  config: "secrets/auth-config.json",
  sso: "secrets/auth-sso.json",
  tpa: "secrets/auth-tpa.json",
  signingKeys: "secrets/auth-signing-keys.json",
  legacySigningKey: "secrets/auth-legacy-signing-key.json",
} as const;

const CONTRACT_SCHEMAS = {
  config: authContractSchema("AuthConfigResponse"),
  sso: authContractSchema("ListProvidersResponse"),
  tpaList: authContractSchema("ThirdPartyAuth").array(),
  signingKeys: authContractSchema("SigningKeysResponse"),
  signingKey: authContractSchema("SigningKeyResponse"),
} as const;

function asRecord(value: unknown, contract: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${contract} validated to a non-object value`);
  }
  return value as Record<string, unknown>;
}

function asRecordArray(
  value: unknown,
  contract: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error(`${contract} validated to a non-array value`);
  return value.map((entry) => asRecord(entry, contract));
}

function sortById(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...items].sort((left, right) =>
    String(left["id"]).localeCompare(String(right["id"]), "en"),
  );
}

function endpointUnavailable(error: unknown): boolean {
  const candidate = error as Partial<PgDumpsterError> | undefined;
  return candidate?.details?.["status"] === 404;
}

function sourceContract(endpoint: string): Record<string, unknown> {
  return {
    adapter: "management-api-auth-v1",
    endpoint,
    openapiSha256: AUTH_CONTRACT_SOURCE_SHA256,
  };
}

function isConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "")
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

const NON_OAUTH_EXTERNAL_FLAGS = new Set([
  "external_anonymous_users_enabled",
  "external_email_enabled",
  "external_phone_enabled",
  "external_web3_ethereum_enabled",
  "external_web3_solana_enabled",
]);

function hasConfiguredOAuthProvider(config: Record<string, unknown>): boolean {
  return Object.entries(config).some(
    ([field, value]) =>
      /^external_.+_enabled$/u.test(field) &&
      !NON_OAUTH_EXTERNAL_FLAGS.has(field) &&
      value === true,
  );
}

function hasConfiguredSmtpProvider(config: Record<string, unknown>): boolean {
  return ["smtp_host", "smtp_user", "smtp_pass"].some((field) =>
    isConfiguredValue(config[field]),
  );
}

function secretFieldChildren(
  config: Record<string, unknown>,
): Record<string, unknown>[] {
  const children: Record<string, unknown>[] = [];
  for (const field of authConfigSecretFieldNames()) {
    const value = config[field];
    const prefix =
      field === "smtp_pass"
        ? "smtp_"
        : field.replace(
            /(?:_secret|_secrets|_access_key|_api_key|_auth_token)$/u,
            "",
          );
    const associatedConfigured = Object.entries(config).some(
      ([name, entry]) =>
        name.startsWith(prefix) && name !== field && isConfiguredValue(entry),
    );
    if (value === undefined || value === null || value === "") {
      if (associatedConfigured) {
        children.push({
          field,
          status: "not_exportable",
          reasonCode: "auth_secret_not_returned",
        });
      }
      continue;
    }
    children.push({
      field,
      status: "not_exportable",
      reasonCode: "auth_secret_exactness_not_guaranteed_by_contract",
    });
  }
  return children;
}

async function getOptionalOnDocumented404(
  operation: () => Promise<unknown>,
): Promise<{ value?: unknown; unavailable: boolean }> {
  try {
    return { value: await operation(), unavailable: false };
  } catch (error) {
    if (!endpointUnavailable(error)) throw error;
    return { unavailable: true };
  }
}

export async function captureAuthControlPlane(
  client: ManagementClient,
  projectRef: string,
  redactor: Redactor,
  sink: ProtectedArtifactSink,
  signal?: AbortSignal,
): Promise<CapturedAuthControlPlane> {
  const encodedRef = encodeURIComponent(projectRef);
  const requestOptions = signal === undefined ? {} : { signal };
  const base = `/v1/projects/${encodedRef}/config/auth`;
  const [configValue, ssoResult, tpaValue, signingValue] = await Promise.all([
    client.get(base, CONTRACT_SCHEMAS.config, requestOptions),
    getOptionalOnDocumented404(() =>
      client.get(`${base}/sso/providers`, CONTRACT_SCHEMAS.sso, requestOptions),
    ),
    client.get(
      `${base}/third-party-auth`,
      CONTRACT_SCHEMAS.tpaList,
      requestOptions,
    ),
    client.get(
      `${base}/signing-keys`,
      CONTRACT_SCHEMAS.signingKeys,
      requestOptions,
    ),
  ]);
  const config = asRecord(configValue, "AuthConfigResponse");
  const sso =
    ssoResult.value === undefined
      ? undefined
      : asRecord(ssoResult.value, "ListProvidersResponse");
  const ssoItems =
    sso === undefined
      ? []
      : sortById(asRecordArray(sso["items"], "ListProvidersResponse.items"));
  const tpaItems = sortById(asRecordArray(tpaValue, "ThirdPartyAuth[]"));
  const signing = asRecord(signingValue, "SigningKeysResponse");
  const signingKeys = sortById(
    asRecordArray(signing["keys"], "SigningKeysResponse.keys"),
  );
  for (const field of authConfigSecretFieldNames()) {
    const value = config[field];
    if (typeof value === "string" && value.length >= 4)
      redactor.register(value);
  }

  let legacySigningKey: Record<string, unknown> | undefined;
  let legacyUnavailable = false;
  try {
    legacySigningKey = asRecord(
      await client.get(
        `${base}/signing-keys/legacy`,
        CONTRACT_SCHEMAS.signingKey,
        requestOptions,
      ),
      "SigningKeyResponse",
    );
  } catch (error) {
    if (!endpointUnavailable(error)) throw error;
    legacyUnavailable = true;
  }

  await Promise.all([
    sink.writeJson(ARTIFACTS.config, { schemaVersion: 1, config }, signal),
    ...(ssoResult.unavailable
      ? []
      : [
          sink.writeJson(
            ARTIFACTS.sso,
            { schemaVersion: 1, items: ssoItems },
            signal,
          ),
        ]),
    sink.writeJson(
      ARTIFACTS.tpa,
      { schemaVersion: 1, items: tpaItems },
      signal,
    ),
    sink.writeJson(
      ARTIFACTS.signingKeys,
      { schemaVersion: 1, keys: signingKeys },
      signal,
    ),
    ...(legacySigningKey === undefined
      ? []
      : [
          sink.writeJson(
            ARTIFACTS.legacySigningKey,
            { schemaVersion: 1, key: legacySigningKey },
            signal,
          ),
        ]),
  ]);

  const configChildren = secretFieldChildren(config);
  const signingChildren = signingKeys.map((key) => ({
    id: key["id"],
    algorithm: key["algorithm"],
    status: "not_exportable",
    reasonCode: "private_signing_material_not_exposed",
  }));
  return {
    coverage: [
      {
        id: "auth.config",
        status: configChildren.length === 0 ? "backed_up" : "not_exportable",
        ...(configChildren.length === 0
          ? {}
          : {
              reasonCode: "auth_secret_fields_not_identically_exportable",
              children: configChildren,
            }),
        sensitivity: "sensitive",
        artifacts: [ARTIFACTS.config],
        sourceContract: sourceContract("/v1/projects/{ref}/config/auth"),
      },
      {
        id: "auth.sso",
        status: ssoResult.unavailable
          ? "not_applicable"
          : ssoItems.length === 0
            ? "not_configured"
            : "backed_up",
        ...(ssoResult.unavailable
          ? { reasonCode: "sso_unavailable_for_project_or_plan" }
          : {}),
        sensitivity: "secret",
        artifacts: ssoResult.unavailable ? [] : [ARTIFACTS.sso],
        sourceContract: sourceContract(
          "/v1/projects/{ref}/config/auth/sso/providers",
        ),
      },
      {
        id: "auth.tpa",
        status: tpaItems.length === 0 ? "not_configured" : "backed_up",
        sensitivity: "secret",
        artifacts: [ARTIFACTS.tpa],
        sourceContract: sourceContract(
          "/v1/projects/{ref}/config/auth/third-party-auth",
        ),
      },
      {
        id: "auth.signing_keys",
        status: signingKeys.length === 0 ? "not_configured" : "not_exportable",
        ...(signingKeys.length === 0
          ? {}
          : {
              reasonCode: "private_signing_material_not_exposed",
              children: signingChildren,
            }),
        sensitivity: "secret",
        artifacts: [ARTIFACTS.signingKeys],
        sourceContract: sourceContract(
          "/v1/projects/{ref}/config/auth/signing-keys",
        ),
      },
      legacyUnavailable
        ? {
            id: "auth.legacy_signing_key",
            status: "not_applicable",
            reasonCode: "documented_legacy_endpoint_removed",
            sensitivity: "secret",
            artifacts: [],
            sourceContract: sourceContract(
              "/v1/projects/{ref}/config/auth/signing-keys/legacy",
            ),
          }
        : {
            id: "auth.legacy_signing_key",
            status: "not_exportable",
            reasonCode: "legacy_shared_signing_secret_not_exposed",
            sensitivity: "secret",
            artifacts: [ARTIFACTS.legacySigningKey],
            sourceContract: sourceContract(
              "/v1/projects/{ref}/config/auth/signing-keys/legacy",
            ),
          },
      hasConfiguredSmtpProvider(config)
        ? {
            id: "external.smtp_provider",
            status: "not_exportable",
            reasonCode: "external_smtp_resource_requires_manual_restore",
            sensitivity: "secret",
            artifacts: [ARTIFACTS.config],
            sourceContract: sourceContract("/v1/projects/{ref}/config/auth"),
          }
        : {
            id: "external.smtp_provider",
            status: "not_configured",
            sensitivity: "secret",
            artifacts: [ARTIFACTS.config],
            sourceContract: sourceContract("/v1/projects/{ref}/config/auth"),
          },
      hasConfiguredOAuthProvider(config)
        ? {
            id: "external.oauth_provider",
            status: "not_exportable",
            reasonCode: "external_oauth_resource_requires_manual_restore",
            sensitivity: "secret",
            artifacts: [ARTIFACTS.config],
            sourceContract: sourceContract("/v1/projects/{ref}/config/auth"),
          }
        : {
            id: "external.oauth_provider",
            status: "not_configured",
            sensitivity: "secret",
            artifacts: [ARTIFACTS.config],
            sourceContract: sourceContract("/v1/projects/{ref}/config/auth"),
          },
    ],
  };
}
