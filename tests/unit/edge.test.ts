import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BundleArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { captureEdgeState } from "../../src/supabase/management/edge.js";

interface FixtureOptions {
  empty?: boolean;
  drift?: boolean;
  nullImportMapPath?: boolean;
  downloadFails?: boolean;
  downloadThrows?: boolean;
  emptyDownload?: boolean;
  missingDownloadedTree?: boolean;
  missingCli?: boolean;
  downloadedTreeFile?: boolean;
  nestedDownload?: boolean;
  caseCollision?: boolean;
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
  const metadata = {
    ...functionMetadata,
    ...(options.nullImportMapPath ? { import_map_path: null } : {}),
  };
  return vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url.endsWith("/functions")) {
      return Promise.resolve(
        Response.json(
          options.empty
            ? []
            : options.caseCollision
              ? [metadata, { ...metadata, id: "second", slug: "HELLO-WORLD" }]
              : [metadata],
        ),
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
    if (url.endsWith("/functions/hello-world")) {
      detailCalls += 1;
      return Promise.resolve(
        Response.json(
          options.drift && detailCalls === 2
            ? { ...metadata, version: 2 }
            : metadata,
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
    {
      maxConcurrency: 2,
      accessToken: new SecretValue("management-token", redactor),
      sourceTreeDependencies: {
        resolveSupabaseCommand: () => {
          if (options.missingCli) return Promise.reject(new Error("missing"));
          return Promise.resolve({ command: "supabase-test", prefixArgs: [] });
        },
        runProcess: async (_command, args) => {
          if (options.downloadFails)
            return { exitCode: 1, stdout: "", stderr: "" };
          if (options.downloadThrows) throw new Error("unavailable");
          if (options.missingDownloadedTree)
            return { exitCode: 0, stdout: "", stderr: "" };
          const workdir = args[args.indexOf("--workdir") + 1]!;
          const source = path.join(
            workdir,
            "supabase",
            "functions",
            "hello-world",
          );
          if (options.downloadedTreeFile) {
            await mkdir(path.dirname(source), { recursive: true });
            await writeFile(source, "not a directory");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          await mkdir(source, { recursive: true });
          if (options.emptyDownload)
            return { exitCode: 0, stdout: "", stderr: "" };
          await writeFile(
            path.join(source, "index.ts"),
            "Deno.serve(() => new Response('ok'));\n",
          );
          if (options.nestedDownload) {
            await mkdir(path.join(source, "lib"), { recursive: true });
            await writeFile(
              path.join(source, "lib", "helper.ts"),
              "export {};\n",
            );
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    },
  );
  return { ordinary, protectedWrites, result };
}

describe("Edge state capture", () => {
  it("captures CLI-downloaded deployable source as backed up", async () => {
    const { ordinary, protectedWrites, result } = await capture();
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "edge.functions", status: "backed_up" },
      { id: "edge.secrets", status: "not_exportable" },
    ]);
    expect(result.coverage[0]?.children).toEqual([
      expect.objectContaining({
        slug: "hello-world",
        status: "backed_up",
        bytes: 38,
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
      "functions/hello-world/source/index.ts",
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

  it("fails closed when the CLI source download fails", async () => {
    await expect(capture({ downloadFails: true })).rejects.toMatchObject({
      code: "EDGE_FUNCTION_SOURCE_DOWNLOAD_FAILED",
      component: "edge.functions",
    });
  });

  it.each([
    [
      "is unavailable",
      { missingCli: true },
      "EDGE_FUNCTION_SOURCE_DOWNLOAD_DEPENDENCY_MISSING",
    ],
    [
      "throws",
      { downloadThrows: true },
      "EDGE_FUNCTION_SOURCE_DOWNLOAD_FAILED",
    ],
    [
      "omits the source tree",
      { missingDownloadedTree: true },
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
    ],
    [
      "returns an empty source tree",
      { emptyDownload: true },
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
    ],
    [
      "returns a file instead of a source tree",
      { downloadedTreeFile: true },
      "EDGE_FUNCTION_SOURCE_TREE_INVALID",
    ],
  ] as const)(
    "fails closed when source download %s",
    async (_label, options, code) => {
      await expect(capture(options)).rejects.toMatchObject({ code });
    },
  );

  it("detects a function version change around source download", async () => {
    await expect(capture({ drift: true })).rejects.toMatchObject({
      code: "BACKUP_SOURCE_DRIFT_DETECTED",
      category: "consistency",
      retryable: true,
    });
  });

  it("captures nested downloaded source files with stable safe paths", async () => {
    const { ordinary } = await capture({ nestedDownload: true });
    expect(ordinary.map(({ path }) => path)).toEqual([
      "functions/hello-world/source/index.ts",
      "functions/hello-world/source/lib/helper.ts",
      "functions/index.json",
    ]);
  });

  it("rejects Edge Function names that collide on a case-insensitive filesystem", async () => {
    await expect(capture({ caseCollision: true })).rejects.toMatchObject({
      code: "EDGE_FUNCTION_SOURCE_TREE_INVALID",
      category: "security",
    });
  });

  it("accepts a null import-map path from deployed functions without one", async () => {
    const { result } = await capture({ nullImportMapPath: true });
    expect(result.coverage[0]).toMatchObject({
      id: "edge.functions",
      status: "backed_up",
    });
  });
});
