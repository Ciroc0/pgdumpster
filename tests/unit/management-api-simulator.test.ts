import { describe, expect, it } from "vitest";

import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { createManagementApiSimulator } from "../fixtures/management-api-simulator.js";

describe("deterministic Management API simulator", () => {
  it("injects latency, connection reset, rate limiting and changing eventual responses", async () => {
    const transportDelays: number[] = [];
    const retryDelays: number[] = [];
    const simulator = createManagementApiSimulator({
      onDelay: (milliseconds) => transportDelays.push(milliseconds),
      routes: {
        "GET /v1/projects/abcdefghijklmnopqrst/functions": [
          {
            delayMs: 15,
            error: new Error("simulated connection reset"),
          },
          {
            status: 429,
            headers: { "retry-after": "0.25" },
            body: { message: "limited" },
          },
          {
            delayMs: 5,
            headers: { etag: "stale-etag" },
            body: {
              items: [
                { name: "before-mutation", secret: "fixture-secret-canary" },
              ],
              next: "cursor-after-mutation",
            },
          },
          {
            body: {
              items: [
                { name: "after-mutation", secret: "fixture-secret-canary" },
              ],
              next: null,
            },
          },
        ],
      },
    });
    const client = new ManagementClient({
      accessToken: new SecretValue(
        "simulator-management-token",
        new Redactor(),
      ),
      fetch: simulator.fetch,
      maxAttempts: 4,
      random: () => 1,
      sleep: (milliseconds) => {
        retryDelays.push(milliseconds);
        return Promise.resolve();
      },
    });

    const before = await client.getRaw(
      "/v1/projects/abcdefghijklmnopqrst/functions",
    );
    const after = await client.getRaw(
      "/v1/projects/abcdefghijklmnopqrst/functions",
    );

    expect(await before.json()).toEqual({
      items: [{ name: "before-mutation", secret: "fixture-secret-canary" }],
      next: "cursor-after-mutation",
    });
    expect(await after.json()).toEqual({
      items: [{ name: "after-mutation", secret: "fixture-secret-canary" }],
      next: null,
    });
    expect(transportDelays).toEqual([15, 5]);
    expect(retryDelays).toEqual([500, 250]);
    expect(simulator.requests).toHaveLength(4);
    expect(
      simulator.requests.map((request) => request.headers.get("authorization")),
    ).toEqual([
      "Bearer simulator-management-token",
      "Bearer simulator-management-token",
      "Bearer simulator-management-token",
      "Bearer simulator-management-token",
    ]);
  });

  it("fails closed when a scenario is exhausted", async () => {
    const simulator = createManagementApiSimulator({ routes: {} });

    await expect(
      simulator.fetch("https://api.supabase.com/v1/projects/example", {
        method: "GET",
      }),
    ).rejects.toThrow("No simulated Management API response");
  });
});
