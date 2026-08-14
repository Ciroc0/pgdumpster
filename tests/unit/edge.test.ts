import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { BundleArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { captureEdgeState } from "../../src/supabase/management/edge.js";

interface FixtureOptions {
  empty?: boolean;
  invalidContentType?: boolean;
  drift?: boolean;
}

const functionMetadata = {
  id: "function-id",
  slug: "hello-world",
  name: "Hello World",
  status: "ACTIVE",
  version: 1,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_001,
  verify_jwt: true,
  entrypoint_path: "index.ts",
  import_map: true,
  import_map_path: "deno.json",
  ezbr_sha256: "a".repeat(64),
  future_field: "preserved",
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function fixtureFetch(options: FixtureOptions = {}): typeof fetch {
  let detailCalls = 0;
  return vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (url.endsWith("/functions")) {
      return Promise.resolve(
        Response.json(options.empty ? [] : [functionMetadata]),
      );
    }
    if (url.endsWith("/secrets")) {
      return Promise.resolve(
        Response.json(
          options.empty
            ? []
            : [
                {
                  name: "EDGE_CANARY",
                  value: "digest-canary-never-a-secret-value",
                  updated_at: "2026-08-14T00:00:00Z",
                },
              ],
        ),
      );
    }
    if (url.endsWith("/functions/hello-world/body")) {
      expect(new Headers(init?.headers).get("accept")).toBe(
        "multipart/form-data",
      );
      return Promise.resolve(
        new Response(new TextEncoder().encode("multipart-body"), {
          headers: {
            "content-type": options.invalidContentType
              ? "application/json"
              : "multipart/form-data; boundary=fixture-boundary",
          },
        }),
      );
    }
    if (url.endsWith("/functions/hello-world")) {
      detailCalls += 1;
      return Promise.resolve(
        Response.json(
          options.drift && detailCalls === 2
            ? { ...functionMetadata, version: 2 }
            : functionMetadata,
        ),
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  });
}

async function capture(options: FixtureOptions = {}) {
  const ordinary: {
    path: string;
    value?: Readonly<Record<string, unknown>>;
    bytes?: Uint8Array;
  }[] = [];
  const protectedWrites: {
    path: string;
    value: Readonly<Record<string, unknown>>;
  }[] = [];
  const artifactSink: BundleArtifactSink = {
    writeJson(path, value) {
      ordinary.push({ path, value });
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      return Promise.resolve({
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    },
    async writeStream(path, stream) {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      ordinary.push({ path, bytes });
      return {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  };
  const protectedSink: ProtectedArtifactSink = {
    writeJson(path, value) {
      protectedWrites.push({ path, value });
      return Promise.resolve();
    },
  };
  const redactor = new Redactor();
  const result = await captureEdgeState(
    new ManagementClient({
      accessToken: new SecretValue("management-token", redactor),
      fetch: fixtureFetch(options),
    }),
    "abcdefghijklmnopqrst",
    protectedSink,
    artifactSink,
    { maxConcurrency: 2 },
  );
  return { ordinary, protectedWrites, result };
}

describe("Edge state capture", () => {
  it("captures exact exposed multipart bytes as backed up", async () => {
    const { ordinary, protectedWrites, result } = await capture();
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "edge.functions", status: "backed_up" },
      { id: "edge.secrets", status: "not_exportable" },
    ]);
    expect(result.coverage[0]?.children).toEqual([
      expect.objectContaining({
        slug: "hello-world",
        status: "backed_up",
        bytes: 14,
      }),
    ]);
    expect(result.coverage[1]?.children).toEqual([
      expect.objectContaining({
        name: "EDGE_CANARY",
        reasonCode: "edge_secret_digest_only",
      }),
    ]);
    expect(JSON.stringify(result.coverage)).not.toContain("digest-canary");
    expect(ordinary.map(({ path }) => path)).toEqual([
      "functions/hello-world/source.multipart",
      "functions/index.json",
    ]);
    expect(protectedWrites).toEqual([
      expect.objectContaining({ path: "secrets/edge-secret-digests.json" }),
    ]);
    expect(JSON.stringify(ordinary[1]?.value)).toContain("future_field");
  });

  it("records empty applicable surfaces as not configured", async () => {
    const { ordinary, result } = await capture({ empty: true });
    expect(result.coverage.map(({ status }) => status)).toEqual([
      "not_configured",
      "not_configured",
    ]);
    expect(ordinary.map(({ path }) => path)).toEqual(["functions/index.json"]);
  });

  it("fails closed on a non-multipart body response", async () => {
    await expect(capture({ invalidContentType: true })).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
      component: "edge.functions",
    });
  });

  it("detects a function version change around the body stream", async () => {
    await expect(capture({ drift: true })).rejects.toMatchObject({
      code: "BACKUP_SOURCE_DRIFT_DETECTED",
      category: "consistency",
      retryable: true,
    });
  });
});
