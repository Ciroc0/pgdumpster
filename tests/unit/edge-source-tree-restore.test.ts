import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RestoreAction } from "../../src/core/restore/plan.js";
import {
  createEdgeSourceTreeRestoreHandler,
  type EdgeSourceTreeRestoreOptions,
} from "../../src/core/restore/edge-source-tree-handler.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

const temporaryDirectories: string[] = [];

interface Metadata {
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
  import_map_path?: string | null;
  ezbr_sha256?: string;
}

interface Fixture {
  root: string;
  metadata: Metadata;
  sourcePath: string;
  source: Buffer;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-edge-tree-"));
  temporaryDirectories.push(root);
  const metadata: Metadata = {
    id: "source-id",
    slug: "hello-world",
    name: "Hello World",
    status: "ACTIVE",
    version: 7,
    created_at: 100,
    updated_at: 200,
    verify_jwt: false,
    entrypoint_path: "index.ts",
    import_map_path: null,
  };
  const sourcePath = "functions/hello-world/source/index.ts";
  const source = Buffer.from("Deno.serve(() => new Response('ok'));\n");
  await mkdir(path.join(root, "functions", "hello-world", "source"), {
    recursive: true,
  });
  await writeFile(path.join(root, ...sourcePath.split("/")), source);
  await writeFile(
    path.join(root, "functions", "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      representation: "cli-source-tree",
      functions: [
        {
          metadata,
          source: {
            files: [
              {
                path: sourcePath,
                bytes: source.length,
                sha256: digest(source),
              },
            ],
          },
        },
      ],
    }),
  );
  return { root, metadata, sourcePath, source };
}

async function rewriteIndex(
  value: Fixture,
  mutate: (document: Record<string, unknown>) => void,
): Promise<void> {
  const filename = path.join(value.root, "functions", "index.json");
  const document = JSON.parse(await readFile(filename, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(document);
  await writeFile(filename, JSON.stringify(document));
}

function action(value: Fixture): RestoreAction {
  return {
    id: "restore.edge.functions",
    component: "edge.functions",
    phase: 14,
    operation: "deploy_edge_functions",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "deploy",
    fidelity: "semantic",
    artifacts: ["functions/index.json", value.sourcePath],
  };
}

class FakeClient {
  values: Metadata[] = [];
  readonly deletes: string[] = [];

  list(): Promise<Metadata[]> {
    return Promise.resolve(structuredClone(this.values));
  }

  delete(slug: string): Promise<void> {
    this.deletes.push(slug);
    this.values = this.values.filter((entry) => entry.slug !== slug);
    return Promise.resolve();
  }
}

function options(
  value: Fixture,
  client: FakeClient,
  commands: string[][],
  onDeploy: () => void,
  conflictPolicy: "fail" | "replace" = "replace",
): EdgeSourceTreeRestoreOptions {
  return {
    bundleRoot: value.root,
    targetProjectRef: "zyxwvutsrqponmlkjihg",
    accessToken: new SecretValue("management-token", new Redactor()),
    conflictPolicy,
    client,
    resolveSupabaseCommand: () =>
      Promise.resolve({ command: "supabase-test", prefixArgs: ["cli.js"] }),
    runProcess: async (_command, args) => {
      commands.push([...args]);
      const workdir = args[args.indexOf("--workdir") + 1]!;
      const restored = await readFile(
        path.join(workdir, "supabase", "functions", "hello-world", "index.ts"),
      );
      expect(restored).toEqual(value.source);
      const config = await readFile(
        path.join(workdir, "supabase", "config.toml"),
        "utf8",
      );
      expect(config).toContain("verify_jwt = false");
      expect(config).toContain(
        "entrypoint = './functions/hello-world/index.ts'",
      );
      onDeploy();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("Edge Function source-tree restore", () => {
  it("reconstructs CLI source, uses isolated deployment and verifies semantic parity", async () => {
    const value = await fixture();
    const client = new FakeClient();
    client.values = [
      {
        ...value.metadata,
        id: "extra",
        slug: "target-only",
        name: "Target only",
      },
    ];
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => {
        client.values.push({
          ...value.metadata,
          id: "target-id",
          version: 8,
          updated_at: 999,
        });
      }),
    );

    const applied = await handler.apply({ action: action(value), attempt: 1 });
    expect(client.deletes).toEqual(["target-only"]);
    expect(commands).toEqual([
      [
        "cli.js",
        "functions",
        "deploy",
        "hello-world",
        "--project-ref",
        "zyxwvutsrqponmlkjihg",
        "--use-api",
        "--workdir",
        expect.any(String),
      ],
    ]);
    await expect(
      handler.verify({
        action: action(value),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("validates all source bytes before any target mutation", async () => {
    const value = await fixture();
    await writeFile(
      path.join(value.root, ...value.sourcePath.split("/")),
      "modified",
    );
    const client = new FakeClient();
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => undefined),
    );

    await expect(
      handler.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
    });
    expect(client.deletes).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("does not invoke the CLI when fail policy finds target conflicts", async () => {
    const value = await fixture();
    const client = new FakeClient();
    client.values = [{ ...value.metadata, name: "Drifted" }];
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => undefined, "fail"),
    );

    await expect(
      handler.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "RESTORE_TARGET_CONFLICT",
    });
    expect(commands).toEqual([]);
  });

  it("rejects legacy representation and mismatched action artifacts before target access", async () => {
    const value = await fixture();
    const client = new FakeClient();
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => undefined),
    );
    await rewriteIndex(value, (document) => {
      document["representation"] = "management-api-multipart";
    });
    await expect(
      handler.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
    });

    const fresh = await fixture();
    const freshHandler = createEdgeSourceTreeRestoreHandler(
      options(fresh, client, commands, () => undefined),
    );
    await expect(
      freshHandler.apply({
        action: { ...action(fresh), artifacts: ["functions/index.json"] },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(commands).toEqual([]);
  });

  it("rejects source-tree metadata that cannot produce a safe CLI configuration", async () => {
    const value = await fixture();
    await rewriteIndex(value, (document) => {
      const functions = document["functions"] as { metadata: Metadata }[];
      functions[0]!.metadata.import_map_path = "missing.json";
    });
    const client = new FakeClient();
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => undefined),
    );

    await expect(
      handler.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
    });
    expect(commands).toEqual([]);
  });

  it("normalizes CLI dependency and deployment failures without command output", async () => {
    const value = await fixture();
    const client = new FakeClient();
    const commands: string[][] = [];
    const missing = createEdgeSourceTreeRestoreHandler({
      ...options(value, client, commands, () => undefined),
      resolveSupabaseCommand: () => Promise.reject(new Error("missing")),
    });
    await expect(
      missing.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "EDGE_FUNCTION_DEPLOY_DEPENDENCY_MISSING",
    });

    const failing = createEdgeSourceTreeRestoreHandler({
      ...options(value, client, commands, () => undefined),
      runProcess: () =>
        Promise.resolve({ exitCode: 1, stdout: "secret", stderr: "secret" }),
    });
    await expect(
      failing.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "EDGE_FUNCTION_SOURCE_DEPLOY_FAILED",
    });

    const throwing = createEdgeSourceTreeRestoreHandler({
      ...options(value, client, commands, () => undefined),
      runProcess: () => Promise.reject(new Error("transport failed")),
    });
    await expect(
      throwing.apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "EDGE_FUNCTION_SOURCE_DEPLOY_FAILED",
    });
  });

  it("reports failed verification for a stale fingerprint or missing target function", async () => {
    const value = await fixture();
    const client = new FakeClient();
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => undefined),
    );

    await expect(
      handler.verify({
        action: action(value),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
    await expect(handler.verify({ action: action(value) })).resolves.toBe(
      false,
    );
    client.values = [{ ...value.metadata, name: "Drifted" }];
    await expect(handler.verify({ action: action(value) })).resolves.toBe(
      false,
    );
  });

  it("rejects non-active, duplicate and unsafe source index entries before CLI deployment", async () => {
    const client = new FakeClient();
    const commands: string[][] = [];
    const removed = await fixture();
    await rewriteIndex(removed, (document) => {
      const functions = document["functions"] as { metadata: Metadata }[];
      functions[0]!.metadata.status = "REMOVED";
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(removed, client, commands, () => undefined),
      ).apply({ action: action(removed), attempt: 1 }),
    ).rejects.toMatchObject({
      code: "EDGE_FUNCTION_RESTORE_UNSUPPORTED_STATE",
    });

    const duplicate = await fixture();
    await rewriteIndex(duplicate, (document) => {
      const functions = document["functions"] as unknown[];
      functions.push(structuredClone(functions[0]));
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(duplicate, client, commands, () => undefined),
      ).apply({
        action: {
          ...action(duplicate),
          artifacts: [
            "functions/index.json",
            duplicate.sourcePath,
            duplicate.sourcePath,
          ],
        },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const unsafe = await fixture();
    await rewriteIndex(unsafe, (document) => {
      const functions = document["functions"] as {
        source: { files: { path: string }[] };
      }[];
      functions[0]!.source.files[0]!.path =
        "functions/hello-world/source/../escape.ts";
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(unsafe, client, commands, () => undefined),
      ).apply({ action: action(unsafe), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(commands).toEqual([]);
  });

  it("uses CLI defaults for absent optional metadata under fail policy without conflicts", async () => {
    const value = await fixture();
    await rewriteIndex(value, (document) => {
      const functions = document["functions"] as { metadata: Metadata }[];
      delete functions[0]!.metadata.verify_jwt;
      delete functions[0]!.metadata.entrypoint_path;
    });
    const client = new FakeClient();
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler({
      ...options(value, client, commands, () => undefined, "fail"),
      runProcess: async (_command, args) => {
        commands.push([...args]);
        const workdir = args[args.indexOf("--workdir") + 1]!;
        const config = await readFile(
          path.join(workdir, "supabase", "config.toml"),
          "utf8",
        );
        expect(config).toContain("verify_jwt = true");
        expect(config).not.toContain("entrypoint =");
        const target = { ...value.metadata, id: "target-id" };
        delete target.verify_jwt;
        delete target.entrypoint_path;
        client.values.push(target);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const applied = await handler.apply({ action: action(value), attempt: 1 });
    expect(typeof applied.fingerprint).toBe("string");
    expect(commands).toHaveLength(1);
  });

  it("rejects duplicate source files and missing configured entrypoints before CLI deployment", async () => {
    const client = new FakeClient();
    const commands: string[][] = [];
    const duplicate = await fixture();
    await rewriteIndex(duplicate, (document) => {
      const functions = document["functions"] as {
        source: { files: unknown[] };
      }[];
      functions[0]!.source.files.push(
        structuredClone(functions[0]!.source.files[0]),
      );
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(duplicate, client, commands, () => undefined),
      ).apply({
        action: {
          ...action(duplicate),
          artifacts: [
            "functions/index.json",
            duplicate.sourcePath,
            duplicate.sourcePath,
          ],
        },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const entrypoint = await fixture();
    await rewriteIndex(entrypoint, (document) => {
      const functions = document["functions"] as { metadata: Metadata }[];
      functions[0]!.metadata.entrypoint_path = "missing.ts";
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(entrypoint, client, commands, () => undefined),
      ).apply({ action: action(entrypoint), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(commands).toEqual([]);
  });

  it("does not redeploy already semantically matching target functions", async () => {
    const value = await fixture();
    const client = new FakeClient();
    client.values = [
      { ...value.metadata, id: "target-id", version: 99, updated_at: 999 },
    ];
    const commands: string[][] = [];
    const handler = createEdgeSourceTreeRestoreHandler(
      options(value, client, commands, () => undefined),
    );

    const applied = await handler.apply({ action: action(value), attempt: 1 });
    expect(typeof applied.fingerprint).toBe("string");
    expect(commands).toEqual([]);
  });

  it("rejects malformed index and source paths before target access", async () => {
    const client = new FakeClient();
    const commands: string[][] = [];
    const emptyIndex = await fixture();
    await writeFile(path.join(emptyIndex.root, "functions", "index.json"), "");
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(emptyIndex, client, commands, () => undefined),
      ).apply({ action: action(emptyIndex), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const outside = await fixture();
    await rewriteIndex(outside, (document) => {
      const functions = document["functions"] as {
        source: { files: { path: string }[] };
      }[];
      functions[0]!.source.files[0]!.path = "other/index.ts";
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(outside, client, commands, () => undefined),
      ).apply({
        action: {
          ...action(outside),
          artifacts: ["functions/index.json", "other/index.ts"],
        },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });

    const absolute = await fixture();
    await rewriteIndex(absolute, (document) => {
      const functions = document["functions"] as {
        source: { files: { path: string }[] };
      }[];
      functions[0]!.source.files[0]!.path =
        "functions/hello-world/source//absolute.ts";
    });
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(absolute, client, commands, () => undefined),
      ).apply({
        action: {
          ...action(absolute),
          artifacts: [
            "functions/index.json",
            "functions/hello-world/source//absolute.ts",
          ],
        },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(commands).toEqual([]);
  });

  it("checks same-size source corruption before deployment", async () => {
    const value = await fixture();
    await writeFile(
      path.join(value.root, ...value.sourcePath.split("/")),
      Buffer.alloc(value.source.length, 0x78),
    );
    const client = new FakeClient();
    const commands: string[][] = [];
    await expect(
      createEdgeSourceTreeRestoreHandler(
        options(value, client, commands, () => undefined),
      ).apply({ action: action(value), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(commands).toEqual([]);
  });

  it("writes captured import-map configuration and resolves the bundled CLI by default", async () => {
    const value = await fixture();
    const importPath = "functions/hello-world/source/import_map.json";
    const importBytes = Buffer.from('{"imports":{}}\n');
    await writeFile(
      path.join(value.root, ...importPath.split("/")),
      importBytes,
    );
    await rewriteIndex(value, (document) => {
      const functions = document["functions"] as {
        metadata: Metadata;
        source: { files: { path: string; bytes: number; sha256: string }[] };
      }[];
      functions[0]!.metadata.import_map_path =
        "./functions/hello-world/import_map.json";
      functions[0]!.metadata.entrypoint_path = "functions/hello-world/index.ts";
      functions[0]!.source.files.push({
        path: importPath,
        bytes: importBytes.length,
        sha256: digest(importBytes),
      });
    });
    const client = new FakeClient();
    const commands: string[][] = [];
    const configured = options(value, client, commands, () => undefined);
    delete configured.resolveSupabaseCommand;
    const handler = createEdgeSourceTreeRestoreHandler({
      ...configured,
      runProcess: async (_command, args) => {
        commands.push([...args]);
        const workdir = args[args.indexOf("--workdir") + 1]!;
        const config = await readFile(
          path.join(workdir, "supabase", "config.toml"),
          "utf8",
        );
        expect(config).toContain(
          "import_map = './functions/hello-world/import_map.json'",
        );
        client.values.push({ ...value.metadata, id: "target-id", version: 8 });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const applied = await handler.apply({
      action: {
        ...action(value),
        artifacts: ["functions/index.json", value.sourcePath, importPath],
      },
      attempt: 1,
    });
    expect(typeof applied.fingerprint).toBe("string");
    expect(commands).toHaveLength(1);
  });
});
