import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDirectoryArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import { createPlaintextProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { capturePlatformV2State } from "../../src/supabase/management/platform-v2.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function capture(configured: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-platform-v2-"));
  temporaryDirectories.push(root);
  const secret = randomUUID();
  const redactor = new Redactor();
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const pathname = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    ).pathname;
    if (pathname.endsWith("/analytics/log-drains")) {
      return Promise.resolve(
        Response.json({
          data: configured
            ? [
                {
                  type: "log_drain",
                  id: "drain-id",
                  attributes: {
                    name: "primary drain",
                    config: {
                      url: "https://logs.example.invalid",
                      http: "http1",
                      gzip: true,
                      headers: { authorization: secret },
                    },
                    backend_type: "webhook",
                  },
                },
              ]
            : [],
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        data: configured
          ? [
              {
                type: "private_link_association",
                id: "association-id",
                attributes: {
                  aws_account_id: "123456789012",
                  account_name: "production",
                  status: "READY",
                  shared_at: "2026-08-14T00:00:00Z",
                  database_type: "PRIMARY",
                  database_identifier: "abcdefghijklmnopqrst",
                },
              },
            ]
          : [],
      }),
    );
  });
  const result = await capturePlatformV2State(
    new ManagementClient({
      accessToken: new SecretValue(randomUUID(), redactor),
      fetch,
    }),
    "abcdefghijklmnopqrst",
    await createDirectoryArtifactSink(root),
    await createPlaintextProtectedArtifactSink(root, {
      allowPlaintextSecrets: true,
    }),
    redactor,
  );
  return { root, secret, redactor, fetch, result };
}

describe("Management API v2 platform capture", () => {
  it("captures configured log drains and PrivateLink without leaking config secrets", async () => {
    const { root, secret, redactor, fetch, result } = await capture(true);
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "project.log_drains", status: "backed_up" },
      { id: "network.private_link", status: "backed_up" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(redactor.redact(`value ${secret}`)).toBe("value [REDACTED]");
    expect(
      await readFile(
        path.join(root, "secrets", "control-plane", "log-drains.json"),
        "utf8",
      ),
    ).toContain(secret);
    expect(
      await readFile(
        path.join(root, "control-plane", "private-link.json"),
        "utf8",
      ),
    ).not.toContain(secret);
  });

  it("classifies explicit empty v2 inventories as not configured", async () => {
    const { result } = await capture(false);
    expect(result.coverage.map(({ status }) => status)).toEqual([
      "not_configured",
      "not_configured",
    ]);
  });

  it("classifies a 403 as not configured only when billing proves the addon is not selected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-platform-v2-"));
    temporaryDirectories.push(root);
    const redactor = new Redactor();
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const pathname = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ).pathname;
      if (pathname.endsWith("/analytics/log-drains"))
        return Promise.resolve(new Response(null, { status: 403 }));
      if (pathname.endsWith("/billing/addons"))
        return Promise.resolve(
          Response.json({
            selected_addons: [],
            available_addons: [
              { type: "log_drain", name: "Log Drains", variants: [] },
            ],
          }),
        );
      return Promise.resolve(Response.json({ data: [] }));
    });
    const result = await capturePlatformV2State(
      new ManagementClient({
        accessToken: new SecretValue(randomUUID(), redactor),
        fetch,
      }),
      "abcdefghijklmnopqrst",
      await createDirectoryArtifactSink(root),
      await createPlaintextProtectedArtifactSink(root, {
        allowPlaintextSecrets: true,
      }),
      redactor,
    );

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.coverage).toMatchObject([
      {
        id: "project.log_drains",
        status: "not_configured",
        reasonCode: "log_drain_addon_not_selected",
      },
      { id: "network.private_link", status: "not_configured" },
    ]);
  });

  it("fails closed when a 403 cannot be proven to mean an unselected addon", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-platform-v2-"));
    temporaryDirectories.push(root);
    const redactor = new Redactor();
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const pathname = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ).pathname;
      if (pathname.endsWith("/billing/addons"))
        return Promise.resolve(
          Response.json({ selected_addons: [], available_addons: [] }),
        );
      return Promise.resolve(new Response(null, { status: 403 }));
    });

    await expect(
      capturePlatformV2State(
        new ManagementClient({
          accessToken: new SecretValue(randomUUID(), redactor),
          fetch,
        }),
        "abcdefghijklmnopqrst",
        await createDirectoryArtifactSink(root),
        await createPlaintextProtectedArtifactSink(root, {
          allowPlaintextSecrets: true,
        }),
        redactor,
      ),
    ).rejects.toMatchObject({ code: "AUTH_MANAGEMENT_API_FAILED" });
  });

  it("fails closed on a malformed official v2 response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-platform-v2-"));
    temporaryDirectories.push(root);
    const redactor = new Redactor();
    await expect(
      capturePlatformV2State(
        new ManagementClient({
          accessToken: new SecretValue(randomUUID(), redactor),
          fetch: () => Promise.resolve(Response.json({ data: "invalid" })),
        }),
        "abcdefghijklmnopqrst",
        await createDirectoryArtifactSink(root),
        await createPlaintextProtectedArtifactSink(root, {
          allowPlaintextSecrets: true,
        }),
        redactor,
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_API_CONTRACT_CHANGED" });
  });
});
