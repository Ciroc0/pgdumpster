import { describe, expect, it, vi } from "vitest";

import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { captureApiKeys } from "../../src/supabase/management/api-keys.js";
import { ManagementClient } from "../../src/supabase/management/client.js";

interface FixtureOptions {
  legacy404?: boolean;
  malformed?: boolean;
  masked?: boolean;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function fixtureFetch(options: FixtureOptions = {}): typeof fetch {
  return vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.endsWith("/api-keys/legacy")) {
      return Promise.resolve(
        options.legacy404
          ? new Response("not found", { status: 404 })
          : Response.json({ enabled: true, future_field: "preserved" }),
      );
    }
    if (url.endsWith("/api-keys?reveal=true")) {
      return Promise.resolve(
        Response.json([
          {
            id: "22222222-2222-4222-8222-222222222222",
            type: "secret",
            name: options.malformed ? undefined : "worker_secret",
            api_key: options.masked
              ? "sb_secret_••••••••"
              : "sb_secret_secret-canary",
            inserted_at: "2026-08-14T00:00:00.000+00:00",
            updated_at: "2026-08-14T00:00:00.000+00:00",
            future_field: "preserved",
          },
          {
            id: "11111111-1111-4111-8111-111111111111",
            type: "publishable",
            name: "web_public",
            api_key: "sb_publishable_public-canary",
          },
          {
            id: "00000000-0000-4000-8000-000000000000",
            type: "legacy",
            name: "legacy_anon",
            api_key: "x.eyJyb2xlIjoiYW5vbiJ9.x",
          },
        ]),
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  });
}

async function capture(options: FixtureOptions = {}) {
  const writes: { path: string; value: Readonly<Record<string, unknown>> }[] =
    [];
  const sink: ProtectedArtifactSink = {
    writeJson: (path, value) => {
      writes.push({ path, value });
      return Promise.resolve();
    },
  };
  const redactor = new Redactor();
  const result = await captureApiKeys(
    new ManagementClient({
      accessToken: new SecretValue("management-token", redactor),
      fetch: fixtureFetch(options),
    }),
    "abcdefghijklmnopqrst",
    redactor,
    sink,
  );
  return { redactor, result, writes };
}

describe("API key capture", () => {
  it("reveals, redacts, protects, sorts, and classifies exact source keys", async () => {
    const { redactor, result, writes } = await capture();
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "api.modern_keys", status: "backed_up" },
      { id: "api.legacy_keys_state", status: "backed_up" },
    ]);
    expect(result.coverage[0]?.message).toContain("protected rotation map");
    expect(result.coverage[0]).toMatchObject({
      children: [
        { name: "legacy_anon", restoreFidelity: "replacement_required" },
        { name: "web_public", restoreFidelity: "replacement_required" },
        { name: "worker_secret", restoreFidelity: "replacement_required" },
      ],
    });
    expect(result.privilegedStorageKey?.expose()).toBe(
      "sb_secret_secret-canary",
    );
    expect(JSON.stringify(result.coverage)).not.toContain("secret-canary");
    expect(redactor.redact("sb_secret_secret-canary")).toBe("[REDACTED]");
    expect(writes.map(({ path }) => path)).toEqual([
      "secrets/api-keys.json",
      "secrets/api-legacy-keys-state.json",
    ]);
    expect(JSON.stringify(writes[0]?.value)).toContain("future_field");
  });

  it("does not count a masked returned value as exported key material", async () => {
    const { result } = await capture({ masked: true });
    expect(result.coverage[0]).toMatchObject({
      status: "not_exportable",
      reasonCode: "one_or_more_api_keys_not_revealed",
    });
    expect(result.coverage[0]?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "worker_secret",
          status: "not_exportable",
          reasonCode: "api_key_not_revealed",
        }),
      ]),
    );
  });

  it("classifies a removed legacy endpoint without omitting the modern artifact", async () => {
    const { result, writes } = await capture({ legacy404: true });
    expect(result.coverage[1]).toMatchObject({
      status: "not_applicable",
      reasonCode: "documented_legacy_endpoint_removed",
      artifacts: [],
    });
    expect(writes.map(({ path }) => path)).toEqual(["secrets/api-keys.json"]);
  });

  it("fails closed before protected writes when the response contract changes", async () => {
    await expect(capture({ malformed: true })).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });
  });
});
