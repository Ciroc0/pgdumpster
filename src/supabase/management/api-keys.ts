import { z } from "zod";

import type { CoverageDocument } from "../../core/bundle/schemas.js";
import type { PgDumpsterError } from "../../core/errors/error.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import type { Redactor } from "../../security/redactor.js";
import { SecretValue } from "../../security/secret-value.js";
import { storageCredentialClass } from "../../security/storage-credential.js";
import {
  API_KEY_CONTRACT_SOURCE_SHA256,
  apiKeyContractSchema,
} from "./api-key-contract.js";
import type { ManagementClient } from "./client.js";

type CoverageEntry = CoverageDocument["components"][number];

export interface CapturedApiKeys {
  coverage: CoverageEntry[];
  privilegedStorageKey?: SecretValue | undefined;
}

const apiKeySchema = z
  .object({
    api_key: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    type: z.enum(["legacy", "publishable", "secret"]).nullable().optional(),
    prefix: z.string().nullable().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    hash: z.string().nullable().optional(),
    secret_jwt_template: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
    inserted_at: z.iso.datetime({ offset: true }).nullable().optional(),
    updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .passthrough();

const apiKeysContractSchema = apiKeyContractSchema("ApiKeyResponse").array();
const legacyApiKeysContractSchema = apiKeyContractSchema(
  "LegacyApiKeysResponse",
);
const legacyApiKeysSchema = z.object({ enabled: z.boolean() }).passthrough();

const ARTIFACTS = {
  modern: "secrets/api-keys.json",
  legacy: "secrets/api-legacy-keys-state.json",
} as const;

function endpointUnavailable(error: unknown): boolean {
  const candidate = error as Partial<PgDumpsterError> | undefined;
  return candidate?.details?.["status"] === 404;
}

function sourceContract(endpoint: string): Record<string, unknown> {
  return {
    adapter: "management-api-keys-v1",
    endpoint,
    openapiSha256: API_KEY_CONTRACT_SOURCE_SHA256,
  };
}

function sortKeys(keys: z.infer<typeof apiKeySchema>[]) {
  return [...keys].sort((left, right) => {
    const leftIdentity = `${left.type ?? ""}\0${left.name}\0${left.id ?? ""}`;
    const rightIdentity = `${right.type ?? ""}\0${right.name}\0${right.id ?? ""}`;
    return leftIdentity.localeCompare(rightIdentity, "en");
  });
}

function isRevealedKey(value: string | null | undefined): value is string {
  if (value === undefined || value === null || value.length < 4) return false;
  return !/[\u2022\u2026]/u.test(value) && !/\*{3,}/u.test(value);
}

function privilegedRevealedKey(
  keys: readonly z.infer<typeof apiKeySchema>[],
): string | undefined {
  for (const preferredType of ["secret", "legacy"] as const) {
    for (const candidate of keys) {
      if (
        candidate.type === preferredType &&
        isRevealedKey(candidate.api_key) &&
        storageCredentialClass(candidate.api_key) === "privileged"
      ) {
        return candidate.api_key;
      }
    }
  }
  return undefined;
}

export async function discoverPrivilegedStorageKey(
  client: ManagementClient,
  projectRef: string,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<SecretValue | undefined> {
  const keysValue = await client.get(
    `/v1/projects/${encodeURIComponent(projectRef)}/api-keys`,
    apiKeysContractSchema,
    {
      ...(signal === undefined ? {} : { signal }),
      query: { reveal: "true" },
    },
  );
  const key = privilegedRevealedKey(
    sortKeys(apiKeySchema.array().parse(keysValue)),
  );
  return key === undefined ? undefined : new SecretValue(key, redactor);
}

export async function captureApiKeys(
  client: ManagementClient,
  projectRef: string,
  redactor: Redactor,
  sink: ProtectedArtifactSink,
  signal?: AbortSignal,
): Promise<CapturedApiKeys> {
  const encodedRef = encodeURIComponent(projectRef);
  const requestOptions = signal === undefined ? {} : { signal };
  const base = `/v1/projects/${encodedRef}/api-keys`;
  const [keysValue, legacyResult] = await Promise.all([
    client.get(base, apiKeysContractSchema, {
      ...requestOptions,
      query: { reveal: "true" },
    }),
    client
      .get(`${base}/legacy`, legacyApiKeysContractSchema, requestOptions)
      .then((value) => ({ unavailable: false as const, value }))
      .catch((error: unknown) => {
        if (!endpointUnavailable(error)) throw error;
        return { unavailable: true as const };
      }),
  ]);
  const keys = sortKeys(apiKeySchema.array().parse(keysValue));
  const legacyState = legacyResult.unavailable
    ? undefined
    : legacyApiKeysSchema.parse(legacyResult.value);
  for (const key of keys) {
    if (typeof key.api_key === "string" && key.api_key.length >= 4) {
      redactor.register(key.api_key);
    }
  }

  await Promise.all([
    sink.writeJson(ARTIFACTS.modern, { schemaVersion: 1, keys }, signal),
    ...(legacyResult.unavailable
      ? []
      : [
          sink.writeJson(
            ARTIFACTS.legacy,
            { schemaVersion: 1, state: legacyState },
            signal,
          ),
        ]),
  ]);

  const children = keys.map((key) => {
    const revealed = isRevealedKey(key.api_key);
    return {
      id: key.id,
      name: key.name,
      type: key.type,
      status: revealed ? "backed_up" : "not_exportable",
      ...(revealed ? {} : { reasonCode: "api_key_not_revealed" }),
      restoreFidelity: "replacement_required",
    };
  });
  const hasUnrevealedKey = children.some(
    ({ status }) => status === "not_exportable",
  );
  const privilegedStorageKey = privilegedRevealedKey(keys);

  return {
    ...(privilegedStorageKey === undefined
      ? {}
      : {
          privilegedStorageKey: new SecretValue(privilegedStorageKey, redactor),
        }),
    coverage: [
      {
        id: "api.modern_keys",
        status:
          keys.length === 0
            ? "not_configured"
            : hasUnrevealedKey
              ? "not_exportable"
              : "backed_up",
        ...(hasUnrevealedKey
          ? { reasonCode: "one_or_more_api_keys_not_revealed" }
          : {}),
        sensitivity: "secret",
        artifacts: [ARTIFACTS.modern],
        children,
        message:
          "Source key values are captured; restore must generate target replacements and a protected rotation map.",
        sourceContract: sourceContract(
          "/v1/projects/{ref}/api-keys?reveal=true",
        ),
      },
      legacyResult.unavailable
        ? {
            id: "api.legacy_keys_state",
            status: "not_applicable",
            reasonCode: "documented_legacy_endpoint_removed",
            sensitivity: "secret",
            artifacts: [],
            sourceContract: sourceContract(
              "/v1/projects/{ref}/api-keys/legacy",
            ),
          }
        : {
            id: "api.legacy_keys_state",
            status: "backed_up",
            sensitivity: "secret",
            artifacts: [ARTIFACTS.legacy],
            sourceContract: sourceContract(
              "/v1/projects/{ref}/api-keys/legacy",
            ),
          },
    ],
  };
}
