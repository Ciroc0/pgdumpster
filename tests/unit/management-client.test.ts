import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { serializeError } from "../../src/core/errors/serialize.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { projectSchema } from "../../src/supabase/management/schemas.js";

async function projectFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile("tests/fixtures/contracts/management-project.json", "utf8"),
  );
}

function client(
  fetchImplementation: typeof fetch,
  redactor = new Redactor(),
  overrides: Partial<ConstructorParameters<typeof ManagementClient>[0]> = {},
): ManagementClient {
  return new ManagementClient({
    accessToken: new SecretValue(
      "sbp_contract_test_canary_never_log_this",
      redactor,
    ),
    fetch: fetchImplementation,
    random: () => 1,
    ...overrides,
  });
}

describe("Supabase Management API transport", () => {
  it("authenticates over the fixed official origin and preserves additive fields", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify(await projectFixture()), {
          status: 206,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await client(request).get(
      "/v1/projects/abcdefghijklmnopqrst",
      projectSchema,
    );
    expect(result.ref).toBe("abcdefghijklmnopqrst");
    expect(result["additive_future_field"]).toEqual({ preserved: true });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer sbp_contract_test_canary_never_log_this",
    );
  });

  it("encodes structured query parameters without accepting query text in paths", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Promise.resolve(Response.json(await projectFixture())),
    );
    const management = client(request);
    await management.get("/v1/projects/abcdefghijklmnopqrst", projectSchema, {
      query: { name: "space value", reveal: "true" },
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst?name=space+value&reveal=true",
    );
    await expect(
      management.get(
        "/v1/projects/abcdefghijklmnopqrst?reveal=true",
        projectSchema,
      ),
    ).rejects.toThrow("absolute /v1/ or /v2/ path");
  });

  it("allows only the fixed official origin for v2 paths", async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ data: [] })),
    );
    await client(request).get(
      "/v2/projects/abcdefghijklmnopqrst/analytics/log-drains",
      z.object({ data: z.array(z.unknown()) }),
    );
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.supabase.com/v2/projects/abcdefghijklmnopqrst/analytics/log-drains",
    );
  });

  it("sends runtime-validated idempotent PUT JSON without query or body leakage", async () => {
    const rootKey = "a".repeat(64);
    const schema = z.object({ root_key: z.string().regex(/^[a-f0-9]{64}$/u) });
    const request = vi.fn<typeof fetch>(async () =>
      Promise.resolve(Response.json({ root_key: rootKey })),
    );
    const management = client(request);
    await expect(
      management.put(
        "/v1/projects/abcdefghijklmnopqrst/pgsodium",
        { root_key: rootKey },
        schema,
        schema,
      ),
    ).resolves.toEqual({ root_key: rootKey });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/pgsodium",
    );
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe(JSON.stringify({ root_key: rootKey }));

    await expect(
      management.put(
        "/v1/projects/abcdefghijklmnopqrst/pgsodium",
        { root_key: "invalid" },
        schema,
        schema,
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_API_CONTRACT_CHANGED" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("returns successful raw bodies with an explicit safe Accept header", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "multipart/form-data; boundary=test" },
        }),
      ).finally(() => {
        expect(new Headers(init?.headers).get("accept")).toBe(
          "multipart/form-data",
        );
      }),
    );
    const response = await client(request).getRaw(
      "/v1/projects/abcdefghijklmnopqrst/functions/example/body",
      { accept: "multipart/form-data" },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("honors rate headers and retries 429 with a bounded delay", async () => {
    const fixture = await projectFixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 429,
          headers: { "x-ratelimit-reset": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const sleeps: number[] = [];
    const result = await client(request, new Redactor(), {
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }).get("/v1/projects/abcdefghijklmnopqrst", projectSchema);
    expect(result.ref).toBe("abcdefghijklmnopqrst");
    expect(sleeps).toEqual([2000]);
  });

  it("throttles the next request in the same project scope proactively", async () => {
    const fixture = await projectFixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "3",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );
    const sleeps: number[] = [];
    const management = client(request, new Redactor(), {
      now: () => 1000,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    await management.get("/v1/projects/abcdefghijklmnopqrst", projectSchema);
    await management.get(
      "/v1/projects/abcdefghijklmnopqrst/health",
      projectSchema,
    );
    expect(sleeps).toEqual([3000]);
  });

  it("fails closed on contract drift without including response bodies", async () => {
    const redactor = new Redactor();
    const request = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            unexpected: "sbp_contract_test_canary_never_log_this",
          }),
          { status: 200 },
        ),
      ),
    );
    let captured: unknown;
    try {
      await client(request, redactor).get(
        "/v1/projects/abcdefghijklmnopqrst",
        projectSchema,
      );
    } catch (error) {
      captured = error;
    }
    const serialized = serializeError(captured, redactor);
    expect(serialized.code).toBe("PLATFORM_API_CONTRACT_CHANGED");
    expect(JSON.stringify(serialized)).not.toContain("canary_never_log");
    expect(JSON.stringify(serialized)).not.toContain("unexpected");
  });

  it("does not retry authentication failures or leak the token", async () => {
    const redactor = new Redactor();
    const request = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response("private upstream body", { status: 401 })),
    );
    let captured: unknown;
    try {
      await client(request, redactor).get(
        "/v1/projects/abcdefghijklmnopqrst",
        projectSchema,
      );
    } catch (error) {
      captured = error;
    }
    const serialized = serializeError(captured, redactor);
    expect(request).toHaveBeenCalledTimes(1);
    expect(serialized.code).toBe("AUTH_MANAGEMENT_API_FAILED");
    expect(JSON.stringify(serialized)).not.toContain("private upstream body");
    expect(JSON.stringify(serialized)).not.toContain("canary_never_log");
  });
});
