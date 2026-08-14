import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import {
  captureAuthControlPlane,
  type CapturedAuthControlPlane,
} from "../../src/supabase/management/auth.js";
import { authConfigSecretFieldNames } from "../../src/supabase/management/auth-contract.js";
import { ManagementClient } from "../../src/supabase/management/client.js";

const signingKey = {
  id: "fbdf5a53-161e-4460-98ad-0e39408d8689",
  algorithm: "EdDSA",
  status: "in_use",
  public_jwk: { kty: "OKP", crv: "Ed25519", x: "public-value" },
  created_at: "2026-08-14T00:00:00Z",
  updated_at: "2026-08-14T00:00:01Z",
};

const snapshotSchema = z.object({
  schemas: z.object({
    AuthConfigResponse: z.object({
      required: z.array(z.string()),
      properties: z.record(z.string(), z.unknown()),
    }),
  }),
});

function fixtureValue(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return null;
  const definition = schema as Record<string, unknown>;
  if (definition["nullable"] === true) return null;
  const values = definition["enum"];
  if (Array.isArray(values) && values.length > 0) return values[0];
  switch (definition["type"]) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "string":
      return "fixture";
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

function authConfigFixture(): Record<string, unknown> {
  const snapshot = snapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/supabase-auth-contracts-2026-08-14.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  const schema = snapshot.schemas.AuthConfigResponse;
  return Object.fromEntries(
    schema.required.map((name) => [
      name,
      fixtureValue(schema.properties[name]),
    ]),
  );
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

interface FixtureOptions {
  sso404?: boolean;
  legacy404?: boolean;
  malformedSigning?: boolean;
  authConfig?: Readonly<Record<string, unknown>>;
}

function fixtureFetch(options: FixtureOptions = {}): typeof fetch {
  return vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.endsWith("/signing-keys/legacy")) {
      return Promise.resolve(
        options.legacy404
          ? new Response("not found", { status: 404 })
          : new Response(JSON.stringify(signingKey), { status: 200 }),
      );
    }
    if (url.endsWith("/sso/providers")) {
      return Promise.resolve(
        options.sso404
          ? new Response("not found", { status: 404 })
          : new Response(
              JSON.stringify({
                items: [
                  { id: "provider-b", future_field: "preserved" },
                  { id: "provider-a", domains: [{ domain: "example.com" }] },
                ],
              }),
              { status: 200 },
            ),
      );
    }
    if (url.endsWith("/third-party-auth")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: "fbdf5a53-161e-4460-98ad-0e39408d8689",
              type: "firebase",
              oidc_issuer_url: "https://issuer.example.invalid",
              jwks_url: null,
              custom_jwks: null,
              resolved_jwks: { keys: [] },
              inserted_at: "2026-08-14T00:00:00Z",
              updated_at: "2026-08-14T00:00:01Z",
              resolved_at: null,
              future_field: true,
            },
          ]),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/signing-keys")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [
              options.malformedSigning
                ? { ...signingKey, algorithm: "unknown" }
                : signingKey,
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/config/auth")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...authConfigFixture(),
            site_url: "https://app.example.invalid",
            external_google_enabled: true,
            external_google_secret: "auth-secret-canary",
            ...options.authConfig,
          }),
          { status: 200 },
        ),
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  });
}

async function capture(options: FixtureOptions = {}): Promise<{
  result: CapturedAuthControlPlane;
  writes: { path: string; value: Readonly<Record<string, unknown>> }[];
  redactor: Redactor;
}> {
  const redactor = new Redactor();
  const writes: { path: string; value: Readonly<Record<string, unknown>> }[] =
    [];
  const sink: ProtectedArtifactSink = {
    writeJson: (artifactPath, value) => {
      writes.push({ path: artifactPath, value });
      return Promise.resolve();
    },
  };
  const result = await captureAuthControlPlane(
    new ManagementClient({
      accessToken: new SecretValue("management-token", redactor),
      fetch: fixtureFetch(options),
    }),
    "abcdefghijklmnopqrst",
    redactor,
    sink,
  );
  return { result, writes, redactor };
}

describe("Auth control-plane capture", () => {
  it("validates, sorts, protects, and classifies all Auth read surfaces", async () => {
    const { result, writes, redactor } = await capture();
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "auth.config", status: "not_exportable" },
      { id: "auth.sso", status: "backed_up" },
      { id: "auth.tpa", status: "backed_up" },
      { id: "auth.signing_keys", status: "not_exportable" },
      { id: "auth.legacy_signing_key", status: "not_exportable" },
      { id: "external.smtp_provider", status: "not_configured" },
      { id: "external.oauth_provider", status: "not_exportable" },
    ]);
    expect(
      result.coverage.find(({ id }) => id === "auth.config")?.children,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "external_google_secret",
          reasonCode: "auth_secret_exactness_not_guaranteed_by_contract",
        }),
      ]),
    );
    expect(JSON.stringify(result.coverage)).not.toContain("auth-secret-canary");
    expect(redactor.redact("value=auth-secret-canary")).toBe(
      "value=[REDACTED]",
    );
    expect(writes.map(({ path }) => path)).toEqual([
      "secrets/auth-config.json",
      "secrets/auth-sso.json",
      "secrets/auth-tpa.json",
      "secrets/auth-signing-keys.json",
      "secrets/auth-legacy-signing-key.json",
    ]);
    const ssoItems = writes.find(({ path }) => path.endsWith("auth-sso.json"))
      ?.value["items"];
    const ssoValues: unknown[] = Array.isArray(ssoItems) ? ssoItems : [];
    expect(
      ssoValues.map((item) =>
        item !== null && typeof item === "object" && "id" in item
          ? item.id
          : undefined,
      ),
    ).toEqual(["provider-a", "provider-b"]);
  });

  it("classifies documented SSO and legacy endpoint 404 responses", async () => {
    const { result, writes } = await capture({ sso404: true, legacy404: true });
    expect(result.coverage.find(({ id }) => id === "auth.sso")).toMatchObject({
      status: "not_applicable",
      reasonCode: "sso_unavailable_for_project_or_plan",
      artifacts: [],
    });
    expect(
      result.coverage.find(({ id }) => id === "auth.legacy_signing_key"),
    ).toMatchObject({
      status: "not_applicable",
      reasonCode: "documented_legacy_endpoint_removed",
      artifacts: [],
    });
    expect(writes.map(({ path }) => path)).not.toContain(
      "secrets/auth-sso.json",
    );
    expect(writes.map(({ path }) => path)).not.toContain(
      "secrets/auth-legacy-signing-key.json",
    );
  });

  it("reports configured secrets omitted by the API without false-positive SMTP gaps", async () => {
    const { result } = await capture({
      authConfig: {
        external_google_client_id: "client-id",
        external_google_secret: null,
      },
    });
    const children = result.coverage.find(
      ({ id }) => id === "auth.config",
    )?.children;
    expect(children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "external_google_secret",
          reasonCode: "auth_secret_not_returned",
        }),
      ]),
    );
    expect(children).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "smtp_pass" })]),
    );
  });

  it("fails closed before writing when a signing contract changes", async () => {
    await expect(capture({ malformedSigning: true })).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });
  });

  it("derives only actual secret-bearing Auth config fields", () => {
    const fields = authConfigSecretFieldNames();
    expect(fields).toContain("external_google_secret");
    expect(fields).toContain("smtp_pass");
    expect(fields).toContain("sms_twilio_auth_token");
    expect(fields).not.toContain("rate_limit_token_refresh");
    expect(fields).not.toContain("password_min_length");
  });
});
