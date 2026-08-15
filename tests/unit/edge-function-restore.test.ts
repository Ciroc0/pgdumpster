import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RestoreAction } from "../../src/core/restore/plan.js";
import {
  createEdgeFunctionRestoreHandler,
  createFetchEdgeFunctionRestoreClient,
  type EdgeFunctionRestoreClient,
  type EdgeFunctionRestoreOptions,
} from "../../src/core/restore/edge-function-handler.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const temporaryDirectories: string[] = [];

interface FunctionMetadata {
  [key: string]: unknown;
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE" | "REMOVED" | "THROTTLED";
  version: number;
  created_at: number;
  updated_at: number;
  verify_jwt?: boolean;
  import_map?: boolean;
  entrypoint_path?: string;
  import_map_path?: string;
  ezbr_sha256?: string | undefined;
}

interface FunctionFixture {
  root: string;
  metadata: FunctionMetadata;
  body: Buffer;
  bodyPath: string;
  contentType: string;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(
  metadataOverrides: Partial<FunctionMetadata> = {},
): Promise<FunctionFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-edge-restore-"));
  temporaryDirectories.push(root);
  const slug = "hello-world";
  const bodyPath = `functions/${slug}/source.multipart`;
  const contentType = "multipart/form-data; boundary=pgdumpster-source";
  const body = Buffer.from(
    '--pgdumpster-source\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--pgdumpster-source--\r\n',
    "utf8",
  );
  const metadata: FunctionMetadata = {
    id: "source-id",
    slug,
    name: "Hello World",
    status: "ACTIVE",
    version: 7,
    created_at: 100,
    updated_at: 200,
    verify_jwt: false,
    import_map: true,
    entrypoint_path: "index.ts",
    import_map_path: "import_map.json",
    ezbr_sha256: "a".repeat(64),
    ...metadataOverrides,
  };
  await mkdir(path.join(root, "functions", slug), { recursive: true });
  await writeFile(path.join(root, ...bodyPath.split("/")), body);
  await writeFile(
    path.join(root, "functions", "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      representation: "management-api-multipart",
      functions: [
        {
          metadata,
          body: {
            path: bodyPath,
            bytes: body.length,
            sha256: sha256(body),
            contentType,
          },
        },
      ],
    }),
  );
  return { root, metadata, body, bodyPath, contentType };
}

function action(fixtureValue: FunctionFixture): RestoreAction {
  return {
    id: "restore.edge.functions",
    component: "edge.functions",
    phase: 14,
    operation: "deploy_edge_functions",
    risk: "mutation",
    billable: false,
    dependsOn: ["restore.edge.secrets"],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "deploy",
    fidelity: "semantic",
    artifacts: ["functions/index.json", fixtureValue.bodyPath],
  };
}

function cloneMetadata(value: FunctionMetadata): FunctionMetadata {
  return structuredClone(value);
}

class FakeEdgeClient implements EdgeFunctionRestoreClient {
  readonly values = new Map<
    string,
    { metadata: FunctionMetadata; body: Buffer; contentType: string }
  >();
  readonly mutations: string[] = [];
  readonly desired = new Map<string, FunctionMetadata>();

  list(): Promise<FunctionMetadata[]> {
    return Promise.resolve(
      [...this.values.values()]
        .map(({ metadata }) => cloneMetadata(metadata))
        .sort((left, right) => left.slug.localeCompare(right.slug, "en")),
    );
  }

  get(slug: string): Promise<FunctionMetadata> {
    const value = this.values.get(slug);
    if (value === undefined) throw new Error(`missing function ${slug}`);
    return Promise.resolve(cloneMetadata(value.metadata));
  }

  body(slug: string) {
    const value = this.values.get(slug);
    if (value === undefined) throw new Error(`missing function ${slug}`);
    return Promise.resolve({
      body: new Response(value.body).body!,
      contentType: value.contentType,
    });
  }

  async deploy(input: {
    slug: string;
    sourcePath: string;
    contentType: string;
  }): Promise<FunctionMetadata> {
    this.mutations.push(`deploy:${input.slug}`);
    const desired = this.desired.get(input.slug);
    if (desired === undefined) throw new Error(`no desired ${input.slug}`);
    const body = await readFile(input.sourcePath);
    const target = {
      metadata: {
        ...cloneMetadata(desired),
        id: `target-${input.slug}`,
        version: desired.version + 1,
        created_at: 999,
        updated_at: 1000,
      },
      body,
      contentType: input.contentType,
    };
    this.values.set(input.slug, target);
    return cloneMetadata(target.metadata);
  }

  delete(slug: string): Promise<void> {
    this.mutations.push(`delete:${slug}`);
    this.values.delete(slug);
    return Promise.resolve();
  }

  set(
    metadata: FunctionMetadata,
    body: Buffer,
    contentType = "multipart/form-data; boundary=target",
  ): void {
    this.values.set(metadata.slug, {
      metadata: cloneMetadata(metadata),
      body,
      contentType,
    });
  }
}

function options(
  fixtureValue: FunctionFixture,
  client: EdgeFunctionRestoreClient,
  conflictPolicy: "fail" | "replace",
): EdgeFunctionRestoreOptions {
  return {
    bundleRoot: fixtureValue.root,
    targetProjectRef: "zyxwvutsrqponmlkjihg",
    accessToken: new SecretValue("management-secret", new Redactor()),
    conflictPolicy,
    client,
  };
}

describe("Edge Function restore handler", () => {
  it("accepts semantic parity while ignoring target IDs, versions and timestamps", async () => {
    const source = await fixture();
    const client = new FakeEdgeClient();
    client.desired.set(source.metadata.slug, source.metadata);
    client.set(
      {
        ...source.metadata,
        id: "target-id",
        version: 99,
        created_at: 999,
        updated_at: 1000,
      },
      Buffer.from(
        "different multipart bytes are unnecessary when ezbr matches",
      ),
    );
    const handler = createEdgeFunctionRestoreHandler(
      options(source, client, "fail"),
    );

    const applied = await handler.apply({ action: action(source), attempt: 1 });
    expect(client.mutations).toEqual([]);
    await expect(
      handler.verify({
        action: action(source),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("fail policy detects extra and conflicting functions before deployment or deletion", async () => {
    const source = await fixture();
    const client = new FakeEdgeClient();
    client.desired.set(source.metadata.slug, source.metadata);
    client.set(
      { ...source.metadata, name: "Drifted" },
      source.body,
      source.contentType,
    );
    client.set(
      {
        ...source.metadata,
        id: "extra-id",
        slug: "target-only",
        name: "Target Only",
      },
      source.body,
      source.contentType,
    );
    const handler = createEdgeFunctionRestoreHandler(
      options(source, client, "fail"),
    );

    await expect(
      handler.apply({ action: action(source), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(client.mutations).toEqual([]);
  });

  it("replace deletes extras, redeploys drift and verifies restored parity", async () => {
    const source = await fixture();
    const client = new FakeEdgeClient();
    client.desired.set(source.metadata.slug, source.metadata);
    client.set(
      { ...source.metadata, verify_jwt: true },
      source.body,
      source.contentType,
    );
    client.set(
      {
        ...source.metadata,
        id: "extra-id",
        slug: "target-only",
        name: "Target Only",
      },
      source.body,
      source.contentType,
    );
    const handler = createEdgeFunctionRestoreHandler(
      options(source, client, "replace"),
    );

    const applied = await handler.apply({ action: action(source), attempt: 1 });
    expect(client.mutations).toEqual([
      "delete:target-only",
      `deploy:${source.metadata.slug}`,
    ]);
    await expect(
      handler.verify({
        action: action(source),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      handler.verify({
        action: action(source),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("falls back to raw multipart hash parity when no eszip hash was exposed", async () => {
    const source = await fixture({ ezbr_sha256: undefined });
    const client = new FakeEdgeClient();
    client.desired.set(source.metadata.slug, source.metadata);
    client.set(source.metadata, source.body, source.contentType);
    const handler = createEdgeFunctionRestoreHandler(
      options(source, client, "fail"),
    );

    await expect(handler.verify({ action: action(source) })).resolves.toBe(
      true,
    );
    client.set(
      source.metadata,
      Buffer.from("different multipart body"),
      source.contentType,
    );
    await expect(handler.verify({ action: action(source) })).resolves.toBe(
      false,
    );
  });

  it("validates every source multipart body before target mutation", async () => {
    const source = await fixture();
    await writeFile(
      path.join(source.root, ...source.bodyPath.split("/")),
      Buffer.alloc(source.body.length, 0x78),
    );
    const client = new FakeEdgeClient();
    client.desired.set(source.metadata.slug, source.metadata);
    const handler = createEdgeFunctionRestoreHandler(
      options(source, client, "replace"),
    );

    await expect(
      handler.apply({ action: action(source), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(client.mutations).toEqual([]);
  });

  it("refuses non-active source state and artifact substitution", async () => {
    const removed = await fixture({ status: "REMOVED" });
    const client = new FakeEdgeClient();
    const removedHandler = createEdgeFunctionRestoreHandler(
      options(removed, client, "fail"),
    );
    await expect(
      removedHandler.apply({ action: action(removed), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "EDGE_FUNCTION_RESTORE_UNSUPPORTED_STATE",
    });

    const active = await fixture();
    const activeHandler = createEdgeFunctionRestoreHandler(
      options(active, client, "fail"),
    );
    await expect(
      activeHandler.apply({
        action: {
          ...action(active),
          artifacts: ["functions/index.json"],
        },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });
});

describe("fetch Edge Function restore client", () => {
  it("uses authenticated management endpoints and streams the captured multipart body", async () => {
    const source = await fixture();
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = vi.fn<typeof fetch>(async (input, init) => {
      await Promise.resolve();
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: new Headers(init?.headers) });
      if (url.endsWith("/body")) {
        return new Response(source.body, {
          status: 200,
          headers: { "content-type": source.contentType },
        });
      }
      if (method === "DELETE") return new Response(null, { status: 200 });
      if (method === "POST") {
        expect(init?.body).toBeDefined();
        return new Response(JSON.stringify(source.metadata), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith(`/functions/${source.metadata.slug}`)) {
        return new Response(JSON.stringify(source.metadata), { status: 200 });
      }
      return new Response(JSON.stringify([source.metadata]), { status: 200 });
    });
    const client = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      accessToken: new SecretValue("management-secret", new Redactor()),
      fetch: fetchImpl,
    });

    await expect(client.list()).resolves.toHaveLength(1);
    await expect(client.get(source.metadata.slug)).resolves.toMatchObject({
      slug: source.metadata.slug,
    });
    const targetBody = await client.body(source.metadata.slug);
    expect(targetBody.contentType).toBe(source.contentType);
    await targetBody.body.cancel();
    await expect(
      client.deploy({
        slug: source.metadata.slug,
        sourcePath: path.join(source.root, ...source.bodyPath.split("/")),
        contentType: source.contentType,
      }),
    ).resolves.toMatchObject({ slug: source.metadata.slug });
    await expect(client.delete(source.metadata.slug)).resolves.toBeUndefined();

    const deploy = calls.find(({ method }) => method === "POST")!;
    expect(deploy.url).toContain("/functions/deploy?slug=hello-world");
    expect(deploy.headers.get("authorization")).toBe(
      "Bearer management-secret",
    );
    expect(deploy.headers.get("content-type")).toBe(source.contentType);
  });

  it("normalizes authorization and contract failures without response body leakage", async () => {
    const unauthorized: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("sensitive provider body", { status: 403 })),
    );
    const authClient = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      accessToken: new SecretValue("management-secret", new Redactor()),
      fetch: unauthorized,
    });
    await expect(authClient.list()).rejects.toMatchObject({
      code: "AUTH_MANAGEMENT_API_FAILED",
      category: "auth",
    });

    const invalidJson: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("not-json", { status: 200 })),
    );
    const contractClient = createFetchEdgeFunctionRestoreClient({
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      accessToken: new SecretValue("management-secret", new Redactor()),
      fetch: invalidJson,
    });
    await expect(contractClient.list()).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
      category: "platform_contract",
    });
  });
});
