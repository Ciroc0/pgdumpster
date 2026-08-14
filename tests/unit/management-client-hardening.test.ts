import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";

type ManagementOptions = ConstructorParameters<typeof ManagementClient>[0];

function management(
  fetchImplementation: typeof fetch,
  overrides: Partial<ManagementOptions> = {},
): ManagementClient {
  return new ManagementClient({
    accessToken: new SecretValue(
      "sbp_management_hardening_canary",
      new Redactor(),
    ),
    fetch: fetchImplementation,
    random: () => 1,
    ...overrides,
  });
}

describe("Management API transport hardening", () => {
  it("rejects invalid retry configuration", () => {
    const request = vi.fn<typeof fetch>();

    expect(
      () =>
        new ManagementClient({
          accessToken: new SecretValue(
            "sbp_management_hardening_canary",
            new Redactor(),
          ),
          fetch: request,
          maxAttempts: 0,
        }),
    ).toThrow("positive integer");

    expect(
      () =>
        new ManagementClient({
          accessToken: new SecretValue(
            "sbp_management_hardening_canary",
            new Redactor(),
          ),
          fetch: request,
          maxAttempts: 1.5,
        }),
    ).toThrow("positive integer");
  });

  it("rejects relative, unsupported-version and fragment-bearing API paths", async () => {
    const request = vi.fn<typeof fetch>();
    const client = management(request);

    for (const pathname of [
      "v1/projects/abcdefghijklmnopqrst",
      "/v3/projects/abcdefghijklmnopqrst",
      "/v1/projects/abcdefghijklmnopqrst#fragment",
    ]) {
      await expect(client.getRaw(pathname)).rejects.toThrow(
        "absolute /v1/ or /v2/ path",
      );
    }

    expect(request).not.toHaveBeenCalled();
  });

  it("retries a transport exception and succeeds without exposing the cause", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket canary"))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const sleeps: number[] = [];

    const result = await management(request, {
      maxAttempts: 2,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }).get(
      "/v1/projects/abcdefghijklmnopqrst/example",
      z.object({ ok: z.boolean() }),
    );

    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]);
  });

  it("wraps the final transport exception in the stable network error", async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("private socket failure")),
    );

    const sleep = vi.fn(() => Promise.resolve());

    await expect(
      management(request, {
        maxAttempts: 2,
        sleep,
      }).getRaw("/v1/projects/abcdefghijklmnopqrst/example"),
    ).rejects.toMatchObject({
      code: "PLATFORM_FEATURE_UNAVAILABLE",
      category: "network",
      retryable: true,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("retries server failures with bounded exponential fallback", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const sleeps: number[] = [];

    const response = await management(request, {
      maxAttempts: 3,
      maxRetryDelayMs: 600,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }).getRaw("/v1/projects/abcdefghijklmnopqrst/example");

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 600]);
  });

  it("prefers Retry-After over the rate-limit reset header", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: {
            "retry-after": "1.25",
            "x-ratelimit-reset": "9",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const sleeps: number[] = [];

    await management(request, {
      maxAttempts: 2,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }).getRaw("/v1/projects/abcdefghijklmnopqrst/example");

    expect(sleeps).toEqual([1250]);
  });

  it("falls back to exponential retry when rate headers are malformed", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("limited", {
          status: 429,
          headers: {
            "retry-after": "-1",
            "x-ratelimit-reset": "not-a-number",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const sleeps: number[] = [];

    await management(request, {
      maxAttempts: 2,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }).getRaw("/v1/projects/abcdefghijklmnopqrst/example");

    expect(sleeps).toEqual([500]);
  });

  it("maintains independent organization and global proactive throttle scopes", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "2",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "4",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const sleeps: number[] = [];

    const client = management(request, {
      now: () => 1000,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    await client.getRaw("/v1/organizations/org-one/settings");
    await client.getRaw("/v1/organizations/org-one/members");
    await client.getRaw("/v1/organizations/org-two/settings");

    await client.getRaw("/v1/projects");
    await client.getRaw("/v1/organizations");

    expect(sleeps).toEqual([2000, 4000]);
  });

  it("fails closed when a successful response is not JSON", async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response("definitely-not-json", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
      ),
    );

    await expect(
      management(request).get(
        "/v1/projects/abcdefghijklmnopqrst/example",
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
      category: "platform_contract",
    });
  });

  it("validates PATCH bodies before sending and serializes valid JSON", async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );

    const client = management(request);
    const schema = z.object({ enabled: z.boolean() }).strict();

    await client.patch(
      "/v1/projects/abcdefghijklmnopqrst/config",
      { enabled: true },
      schema,
    );

    expect(request).toHaveBeenCalledOnce();

    const [, init] = request.mock.calls[0]!;

    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ enabled: true }));
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );

    await expect(
      client.patch<unknown>(
        "/v1/projects/abcdefghijklmnopqrst/config",
        { enabled: "yes" },
        schema,
      ),
    ).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels the built-in retry sleep deterministically", async () => {
    const controller = new AbortController();

    const request = vi.fn<typeof fetch>(() => {
      setTimeout(() => {
        controller.abort(new Error("cancel management retry"));
      }, 0);

      return Promise.resolve(
        new Response("limited", {
          status: 429,
          headers: {
            "retry-after": "60",
          },
        }),
      );
    });

    await expect(
      management(request, {
        maxAttempts: 2,
      }).getRaw("/v1/projects/abcdefghijklmnopqrst/example", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel management retry");

    expect(request).toHaveBeenCalledOnce();
  });
});
