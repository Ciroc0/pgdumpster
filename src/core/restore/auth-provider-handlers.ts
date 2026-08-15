import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import { authContractSchema } from "../../supabase/management/auth-contract.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import { resolveBundleArtifact } from "./database-handlers.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

const SSO_ARTIFACT = "secrets/auth-sso.json";
const TPA_ARTIFACT = "secrets/auth-tpa.json";
const documentSchema = z
  .object({ schemaVersion: z.literal(1), items: z.array(z.unknown()) })
  .strict();

type RecordValue = Record<string, unknown>;

interface AuthProviderClient {
  get(
    pathname: string,
    schema: z.ZodType<unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  post(
    pathname: string,
    body: unknown,
    bodySchema: z.ZodType<unknown>,
    responseSchema: z.ZodType<unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  delete(
    pathname: string,
    responseSchema: z.ZodType<unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface AuthProviderRestoreHandlerOptions {
  bundleRoot: string;
  targetProjectRef: string;
  conflictPolicy: "fail" | "replace";
  client: AuthProviderClient;
}

function record(value: unknown, message: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message,
      retryable: false,
    });
  }
  return value as RecordValue;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function readItems(
  options: AuthProviderRestoreHandlerOptions,
  artifact: string,
  contract: "ListProvidersResponse" | "ThirdPartyAuth",
): Promise<RecordValue[]> {
  const filename = await resolveBundleArtifact(options.bundleRoot, artifact);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Auth provider artifact must be a bounded regular file.",
      retryable: false,
    });
  }
  const parsed = documentSchema.parse(
    JSON.parse(await readFile(filename, "utf8")),
  );
  const items =
    contract === "ListProvidersResponse"
      ? record(
          authContractSchema(contract).parse({ items: parsed.items }),
          "Auth SSO artifact is invalid.",
        )["items"]
      : parsed.items.map((item) => authContractSchema(contract).parse(item));
  if (!Array.isArray(items)) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Auth provider artifact items must be an array.",
      retryable: false,
    });
  }
  return items.map((item) => record(item, "Auth provider entry is invalid."));
}

function sorted(items: RecordValue[]): RecordValue[] {
  return [...items].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), "en"),
  );
}

function failConflict(component: string): never {
  throw new PgDumpsterError({
    code: "RESTORE_TARGET_CONFLICT",
    category: "restore_policy",
    message: "Target Auth provider state differs from the source bundle.",
    retryable: false,
    component,
  });
}

function asString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message,
      retryable: false,
    });
  }
  return value;
}

function ssoDesired(item: RecordValue): RecordValue {
  const saml = record(item["saml"], "SSO provider is missing SAML metadata.");
  const entityId = asString(
    saml["entity_id"],
    "SSO provider is missing entity_id.",
  );
  const metadataXml = saml["metadata_xml"];
  const metadataUrl = saml["metadata_url"];
  if (typeof metadataXml !== "string" && typeof metadataUrl !== "string") {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "SSO provider has no recreatable SAML metadata.",
      retryable: false,
      component: "auth.sso",
    });
  }
  const domains = Array.isArray(item["domains"])
    ? item["domains"].map((entry) =>
        asString(
          record(entry, "SSO domain is invalid.")["domain"],
          "SSO domain is invalid.",
        ),
      )
    : [];
  return {
    entity_id: entityId,
    ...(typeof metadataXml === "string" ? { metadata_xml: metadataXml } : {}),
    ...(typeof metadataUrl === "string" ? { metadata_url: metadataUrl } : {}),
    ...(saml["attribute_mapping"] === undefined
      ? {}
      : { attribute_mapping: saml["attribute_mapping"] }),
    ...(saml["name_id_format"] === undefined
      ? {}
      : { name_id_format: saml["name_id_format"] }),
    domains: [...domains].sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
  };
}

function ssoCreate(desired: RecordValue): RecordValue {
  const body = { ...desired };
  delete body["entity_id"];
  return { type: "saml", ...body };
}

function tpaDesired(item: RecordValue): RecordValue {
  const type = asString(item["type"], "Third-party Auth item is missing type.");
  const body = Object.fromEntries(
    ["oidc_issuer_url", "jwks_url", "custom_jwks"]
      .filter((field) => item[field] !== undefined && item[field] !== null)
      .map((field) => [field, item[field]]),
  );
  if (Object.keys(body).length === 0) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Third-party Auth item has no recreatable configuration.",
      retryable: false,
      component: "auth.tpa",
    });
  }
  return { type, ...body };
}

async function currentSso(
  options: AuthProviderRestoreHandlerOptions,
  signal?: AbortSignal,
): Promise<{ item: RecordValue; id: string }[]> {
  const value = await options.client.get(
    `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/config/auth/sso/providers`,
    authContractSchema("ListProvidersResponse"),
    ...(signal === undefined ? [] : [{ signal }]),
  );
  const items = record(value, "Target Auth SSO response is invalid.")["items"];
  if (!Array.isArray(items))
    throw new Error("Validated SSO items must be an array.");
  return items.map((item) => {
    const provider = record(item, "Target Auth SSO provider is invalid.");
    return {
      item: ssoDesired(provider),
      id: asString(provider["id"], "Target SSO id is invalid."),
    };
  });
}

async function currentTpa(
  options: AuthProviderRestoreHandlerOptions,
  signal?: AbortSignal,
): Promise<{ item: RecordValue; id: string }[]> {
  const value = await options.client.get(
    `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/config/auth/third-party-auth`,
    authContractSchema("ThirdPartyAuth").array(),
    ...(signal === undefined ? [] : [{ signal }]),
  );
  if (!Array.isArray(value))
    throw new Error("Validated TPA response must be an array.");
  return value.map((item) => {
    const integration = record(
      item,
      "Target Third-party Auth item is invalid.",
    );
    return {
      item: tpaDesired(integration),
      id: asString(integration["id"], "Target TPA id is invalid."),
    };
  });
}

function createCollectionHandler(
  options: AuthProviderRestoreHandlerOptions,
  specification: {
    component: "auth.sso" | "auth.tpa";
    artifact: string;
    sourceContract: "ListProvidersResponse" | "ThirdPartyAuth";
    current(signal?: AbortSignal): Promise<{ item: RecordValue; id: string }[]>;
    create(item: RecordValue, signal?: AbortSignal): Promise<void>;
    remove(id: string, signal?: AbortSignal): Promise<void>;
    desired(item: RecordValue): RecordValue;
  },
): RestoreActionHandler {
  const source = async () =>
    sorted(
      (
        await readItems(
          options,
          specification.artifact,
          specification.sourceContract,
        )
      ).map((item) => specification.desired(item)),
    );
  const target = async (signal?: AbortSignal) =>
    sorted((await specification.current(signal)).map(({ item }) => item));
  const matches = async (signal?: AbortSignal) =>
    canonicalJson(await source()) === canonicalJson(await target(signal));
  return {
    async apply(context): Promise<RestoreActionResult> {
      if (
        context.action.artifacts.length !== 1 ||
        context.action.artifacts[0] !== specification.artifact
      ) {
        throw new PgDumpsterError({
          code: "RESTORE_ARTIFACT_INVALID",
          category: "restore_policy",
          message: `Auth restore requires ${specification.artifact}.`,
          retryable: false,
          component: specification.component,
        });
      }
      const desired = await source();
      const expected = fingerprint(desired);
      if (await matches(context.signal)) return { fingerprint: expected };
      const current = await specification.current(context.signal);
      if (options.conflictPolicy === "fail" && current.length > 0)
        failConflict(specification.component);
      if (options.conflictPolicy === "replace") {
        for (const { id } of current)
          await specification.remove(id, context.signal);
      }
      for (const item of desired)
        await specification.create(item, context.signal);
      return { fingerprint: expected };
    },
    async verify(context): Promise<boolean> {
      const desired = await source();
      return (
        (context.expectedFingerprint === undefined ||
          context.expectedFingerprint === fingerprint(desired)) &&
        canonicalJson(desired) === canonicalJson(await target(context.signal))
      );
    },
  };
}

export function createAuthSsoRestoreHandler(
  options: AuthProviderRestoreHandlerOptions,
): RestoreActionHandler {
  const base = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/config/auth/sso/providers`;
  return createCollectionHandler(options, {
    component: "auth.sso",
    artifact: SSO_ARTIFACT,
    sourceContract: "ListProvidersResponse",
    current: (signal) => currentSso(options, signal),
    desired: ssoDesired,
    create: async (item, signal) => {
      await options.client.post(
        base,
        ssoCreate(item),
        authContractSchema("CreateProviderBody"),
        authContractSchema("CreateProviderResponse"),
        ...(signal === undefined ? [] : [{ signal }]),
      );
    },
    remove: async (id, signal) => {
      await options.client.delete(
        `${base}/${encodeURIComponent(id)}`,
        authContractSchema("DeleteProviderResponse"),
        ...(signal === undefined ? [] : [{ signal }]),
      );
    },
  });
}

export function createAuthTpaRestoreHandler(
  options: AuthProviderRestoreHandlerOptions,
): RestoreActionHandler {
  const base = `/v1/projects/${encodeURIComponent(options.targetProjectRef)}/config/auth/third-party-auth`;
  return createCollectionHandler(options, {
    component: "auth.tpa",
    artifact: TPA_ARTIFACT,
    sourceContract: "ThirdPartyAuth",
    current: (signal) => currentTpa(options, signal),
    desired: tpaDesired,
    create: async (item, signal) => {
      const body = { ...item };
      delete body["type"];
      await options.client.post(
        base,
        body,
        authContractSchema("CreateThirdPartyAuthBody"),
        authContractSchema("ThirdPartyAuth"),
        ...(signal === undefined ? [] : [{ signal }]),
      );
    },
    remove: async (id, signal) => {
      await options.client.delete(
        `${base}/${encodeURIComponent(id)}`,
        authContractSchema("ThirdPartyAuth"),
        ...(signal === undefined ? [] : [{ signal }]),
      );
    },
  });
}
