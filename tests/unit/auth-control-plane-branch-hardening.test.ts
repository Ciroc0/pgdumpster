import { describe, expect, it } from "vitest";

import { PgDumpsterError } from "../../src/core/errors/error.js";
import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";
import { captureAuthControlPlane } from "../../src/supabase/management/auth.js";

interface Fixture {
  config?: unknown;
  sso?: unknown;
  tpa?: unknown;
  signing?: unknown;
  legacy?: unknown;
  ssoError?: number;
  legacyError?: number;
}

function client(fixture: Fixture = {}): ManagementClient {
  return {
    get(pathname: string) {
      if (pathname.endsWith("/signing-keys/legacy")) {
        if (fixture.legacyError !== undefined) {
          throw new PgDumpsterError({
            code: "PLATFORM_FEATURE_UNAVAILABLE",
            category: "control_plane",
            message: "legacy fixture error",
            retryable: false,
            details: {
              status: fixture.legacyError,
            },
          });
        }

        return Promise.resolve(
          fixture.legacy ?? {
            id: "legacy",
          },
        );
      }

      if (pathname.endsWith("/sso/providers")) {
        if (fixture.ssoError !== undefined) {
          throw new PgDumpsterError({
            code: "PLATFORM_FEATURE_UNAVAILABLE",
            category: "control_plane",
            message: "sso fixture error",
            retryable: false,
            details: {
              status: fixture.ssoError,
            },
          });
        }

        return Promise.resolve(
          fixture.sso ?? {
            items: [],
          },
        );
      }

      if (pathname.endsWith("/third-party-auth")) {
        return Promise.resolve(fixture.tpa ?? []);
      }

      if (pathname.endsWith("/signing-keys")) {
        return Promise.resolve(
          fixture.signing ?? {
            keys: [],
          },
        );
      }

      if (pathname.endsWith("/config/auth")) {
        return Promise.resolve(fixture.config ?? {});
      }

      throw new Error(`Unexpected Auth fixture path: ${pathname}`);
    },
  } as unknown as ManagementClient;
}

async function capture(fixture: Fixture = {}) {
  const writes: string[] = [];

  const sink: ProtectedArtifactSink = {
    writeJson(path) {
      writes.push(path);
      return Promise.resolve();
    },
  };

  const result = await captureAuthControlPlane(
    client(fixture),
    "abcdefghijklmnopqrst",
    new Redactor(),
    sink,
  );

  return {
    result,
    writes,
  };
}

function status(
  result: Awaited<ReturnType<typeof capture>>["result"],
  id: string,
) {
  return result.coverage.find((entry) => entry.id === id)?.status;
}

describe("Auth control-plane branch hardening", () => {
  it("classifies completely empty Auth surfaces", async () => {
    const { result } = await capture();

    expect(status(result, "auth.config")).toBe("backed_up");

    expect(status(result, "auth.sso")).toBe("not_configured");

    expect(status(result, "auth.tpa")).toBe("not_configured");

    expect(status(result, "auth.signing_keys")).toBe("not_configured");

    expect(status(result, "external.smtp_provider")).toBe("not_configured");

    expect(status(result, "external.oauth_provider")).toBe("not_configured");
  });

  it("detects configured SMTP when its secret is omitted", async () => {
    const { result } = await capture({
      config: {
        smtp_host: "smtp.example.invalid",
        smtp_user: "user",
        smtp_pass: null,
      },
    });

    expect(status(result, "auth.config")).toBe("not_exportable");

    expect(status(result, "external.smtp_provider")).toBe("not_exportable");

    expect(
      result.coverage.find(({ id }) => id === "auth.config")?.children,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "smtp_pass",
          reasonCode: "auth_secret_not_returned",
        }),
      ]),
    );
  });

  it("does not mistake non-OAuth external flags for OAuth providers", async () => {
    const noOAuth = await capture({
      config: {
        external_email_enabled: true,
        external_phone_enabled: true,
      },
    });

    expect(status(noOAuth.result, "external.oauth_provider")).toBe(
      "not_configured",
    );

    const oauth = await capture({
      config: {
        external_github_enabled: true,
      },
    });

    expect(status(oauth.result, "external.oauth_provider")).toBe(
      "not_exportable",
    );
  });

  it("covers array and object configured-value semantics for SMTP", async () => {
    const cases: readonly [unknown, "not_configured" | "not_exportable"][] = [
      [[], "not_configured"],
      [["configured"], "not_exportable"],
      [{}, "not_configured"],
      [{ configured: true }, "not_exportable"],
      [false, "not_configured"],
      ["", "not_configured"],
    ];

    for (const [smtpHost, expected] of cases) {
      const { result } = await capture({
        config: {
          smtp_host: smtpHost,
          smtp_pass: null,
        },
      });

      expect(status(result, "external.smtp_provider")).toBe(expected);
    }
  });

  it("fails closed when Auth config is not an object", async () => {
    await expect(
      capture({
        config: [],
      }),
    ).rejects.toThrow("AuthConfigResponse validated to a non-object value");
  });

  it("fails closed when SSO items are not an array", async () => {
    await expect(
      capture({
        sso: {
          items: {},
        },
      }),
    ).rejects.toThrow(
      "ListProvidersResponse.items validated to a non-array value",
    );
  });

  it("fails closed when TPA or signing-key containers are malformed", async () => {
    await expect(
      capture({
        tpa: {},
      }),
    ).rejects.toThrow("ThirdPartyAuth[] validated to a non-array value");

    await expect(
      capture({
        signing: {
          keys: {},
        },
      }),
    ).rejects.toThrow(
      "SigningKeysResponse.keys validated to a non-array value",
    );
  });

  it("rethrows non-404 optional endpoint errors", async () => {
    await expect(
      capture({
        ssoError: 500,
      }),
    ).rejects.toMatchObject({
      details: {
        status: 500,
      },
    });

    await expect(
      capture({
        legacyError: 500,
      }),
    ).rejects.toMatchObject({
      details: {
        status: 500,
      },
    });
  });
});
