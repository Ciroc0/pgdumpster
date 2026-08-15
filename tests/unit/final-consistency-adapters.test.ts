import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/supabase/management/edge.js", () => ({
  captureEdgeState: vi.fn(),
}));
vi.mock("../../src/supabase/management/vault-root-key.js", () => ({
  captureVaultRootKey: vi.fn(),
  VAULT_ROOT_KEY_ARTIFACT: "secrets/database-vault-root-key.json",
}));
vi.mock("../../src/storage/specialized.js", () => ({
  captureSpecializedStorage: vi.fn(),
}));

import {
  createEdgeConsistencyAdapter,
  type EdgeConsistencySnapshot,
} from "../../src/core/backup/edge-consistency-adapter.js";
import {
  createSpecializedStorageConsistencyAdapter,
  type SpecializedStorageConsistencySnapshot,
} from "../../src/core/backup/specialized-storage-consistency-adapter.js";
import {
  createVaultRootKeyConsistencyAdapter,
  type VaultRootKeyConsistencySnapshot,
} from "../../src/core/backup/vault-root-key-consistency-adapter.js";
import type { CoverageDocument } from "../../src/core/bundle/schemas.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type { SpecializedStorageClient } from "../../src/storage/specialized.js";
import { captureSpecializedStorage } from "../../src/storage/specialized.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";
import { captureEdgeState } from "../../src/supabase/management/edge.js";
import { captureVaultRootKey } from "../../src/supabase/management/vault-root-key.js";

type CoverageEntry = CoverageDocument["components"][number];

const temporaryDirectories: string[] = [];
const management = {} as ManagementClient;
const edgeSource = {
  management,
  projectRef: "abcdefghijklmnopqrst",
  maxApiConcurrency: 3,
};
const vaultSource = {
  management,
  projectRef: "abcdefghijklmnopqrst",
};
const storageSource = {
  storage: {} as SpecializedStorageClient,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-final-consistency-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function coverage(
  id: string,
  artifacts: string[],
  status: CoverageEntry["status"] = "backed_up",
  reasonCode?: string,
): CoverageEntry {
  return {
    id,
    status,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    sensitivity: "internal",
    artifacts,
  };
}

function edgeSnapshot(value: unknown): EdgeConsistencySnapshot {
  return value as EdgeConsistencySnapshot;
}

function vaultSnapshot(value: unknown): VaultRootKeyConsistencySnapshot {
  return value as VaultRootKeyConsistencySnapshot;
}

function specializedSnapshot(
  value: unknown,
): SpecializedStorageConsistencySnapshot {
  return value as SpecializedStorageConsistencySnapshot;
}

function installEdgeCapture(version: number, secretDigest: string) {
  let bodyCancelled = false;
  vi.mocked(captureEdgeState).mockImplementation(
    async (_client, _projectRef, protectedSink, ordinary, options) => {
      const signal = options?.signal;

      await protectedSink.writeJson(
        "secrets/edge-secret-digests.json",
        {
          schemaVersion: 1,
          valuesAreDigests: true,
          secrets: [{ name: "EDGE_CANARY", value: secretDigest }],
        },
        signal,
      );
      const bodyPath = "functions/hello-world/source.multipart";
      const body = await ordinary.writeStream(
        bodyPath,
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("deployment-body"));
            controller.close();
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { maxBytes: 1024, signal },
      );
      await ordinary.writeJson(
        "functions/index.json",
        {
          schemaVersion: 1,
          representation: "management-api-multipart",
          functions: [
            {
              metadata: {
                id: "function-id",
                slug: "hello-world",
                status: "ACTIVE",
                version,
                updated_at: version,
                ezbr_sha256: String(version).repeat(64).slice(0, 64),
              },
              body: {
                path: bodyPath,
                bytes: body.bytes,
                sha256: body.sha256,
                contentType: "multipart/form-data; boundary=test",
              },
            },
          ],
        },
        signal,
      );
      return {
        coverage: [
          coverage("edge.functions", ["functions/index.json", bodyPath]),
          coverage(
            "edge.secrets",
            ["secrets/edge-secret-digests.json"],
            "not_exportable",
            "edge_secret_digest_only",
          ),
        ],
      };
    },
  );
  return () => bodyCancelled;
}

function installVaultCapture(rootKey: string) {
  vi.mocked(captureVaultRootKey).mockImplementation(
    async (_client, _projectRef, redactor, sink, signal) => {
      await sink.writeJson(
        "secrets/database-vault-root-key.json",
        {
          schemaVersion: 1,
          algorithm: "pgsodium-root-key-32-byte-hex",
          rootKey,
        },
        signal,
      );
      return {
        rootKey: new SecretValue(rootKey, redactor),
        coverage: coverage("database.vault_root_key", [
          "secrets/database-vault-root-key.json",
        ]),
      };
    },
  );
}

interface VectorFixture {
  key: string;
  data: number[];
}

function installSpecializedCapture(options: {
  pages: VectorFixture[][];
  analyticsTables?: readonly Readonly<Record<string, unknown>>[];
}) {
  vi.mocked(captureSpecializedStorage).mockImplementation(
    async (_client, ordinary, protectedSink, signal) => {
      await ordinary.writeJson(
        "storage/vector-buckets.json",
        {
          schemaVersion: 1,
          buckets: [{ vectorBucketName: "embeddings" }],
        },
        signal,
      );
      await ordinary.writeJson(
        "storage/vector-indexes.json",
        {
          schemaVersion: 1,
          indexes: [
            {
              vectorBucketName: "embeddings",
              indexName: "documents",
              dataType: "float32",
              dimension: 2,
              distanceMetric: "cosine",
            },
          ],
        },
        signal,
      );

      const vectorArtifacts: string[] = [];
      for (const [index, page] of options.pages.entries()) {
        const artifact = `secrets/storage/vectors/${"a".repeat(64)}/${String(index + 1).padStart(8, "0")}.json`;
        vectorArtifacts.push(artifact);
        await protectedSink.writeJson(
          artifact,
          {
            schemaVersion: 1,
            bucketName: "embeddings",
            indexName: "documents",
            vectors: page.map(({ key, data }) => ({
              key,
              data: { float32: data },
              metadata: { source: key },
            })),
          },
          signal,
        );
      }
      await protectedSink.writeJson(
        "secrets/storage/vector-summary.json",
        {
          schemaVersion: 1,
          indexes: [
            {
              bucketName: "embeddings",
              indexName: "documents",
              vectorCount: options.pages.flat().length,
              pageCount: options.pages.length,
            },
          ],
        },
        signal,
      );

      await ordinary.writeJson(
        "storage/analytics-buckets.json",
        {
          schemaVersion: 1,
          buckets: [
            {
              name: "warehouse",
              type: "ANALYTICS",
              format: "iceberg",
              created_at: "2026-08-15T00:00:00Z",
              updated_at: "2026-08-15T00:00:00Z",
            },
          ],
        },
        signal,
      );
      const analyticsArtifact = `storage/analytics-catalog/${"b".repeat(64)}.json`;
      await ordinary.writeJson(
        analyticsArtifact,
        {
          schemaVersion: 1,
          bucket: { name: "warehouse" },
          namespaces: [
            {
              namespace: ["default"],
              properties: { owner: "data" },
              tables: options.analyticsTables ?? [
                { name: "events", "current-snapshot-id": 1 },
                { name: "users", "current-snapshot-id": 2 },
              ],
            },
          ],
        },
        signal,
      );

      return {
        coverage: [
          coverage("storage.vector_buckets", ["storage/vector-buckets.json"]),
          coverage("storage.vector_indexes", ["storage/vector-indexes.json"]),
          coverage("storage.vectors", [
            "secrets/storage/vector-summary.json",
            ...vectorArtifacts,
          ]),
          coverage("storage.analytics_catalog", [
            "storage/analytics-buckets.json",
            analyticsArtifact,
          ]),
          coverage(
            "storage.analytics_data",
            [],
            "failed",
            "analytics_s3_data_export_required",
          ),
        ],
      };
    },
  );
}

describe("final product consistency adapters", () => {
  it("uses Edge metadata evidence without re-downloading deployment bodies", async () => {
    const bodyCancelled = installEdgeCapture(1, "digest-one");
    const adapter = createEdgeConsistencyAdapter(edgeSource);
    const first = edgeSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );

    expect(bodyCancelled()).toBe(true);
    expect(first.functionsIndexSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.secretDigestsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("digest-one");

    installEdgeCapture(2, "digest-one");
    const changed = edgeSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );
    expect(changed.functionsIndexSha256).not.toBe(first.functionsIndexSha256);

    installEdgeCapture(1, "digest-two");
    const secretChanged = edgeSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );
    expect(secretChanged.secretDigestsSha256).not.toBe(
      first.secretDigestsSha256,
    );
  });

  it("prevalidates the complete Edge cleanup scope before deleting", async () => {
    const root = await workspace();
    const functionDirectory = path.join(root, "functions", "hello-world");
    await mkdir(functionDirectory, { recursive: true });
    const index = path.join(root, "functions", "index.json");
    const body = path.join(functionDirectory, "source.multipart");
    await writeFile(index, "index");
    await writeFile(body, "body");

    const adapter = createEdgeConsistencyAdapter(edgeSource);
    await expect(
      adapter.cleanup(
        {
          artifacts: ["functions/index.json", "secrets/api-keys.json"],
          coverage: [],
        },
        { workspaceRoot: root },
      ),
    ).rejects.toMatchObject({ code: "CONSISTENCY_CLEANUP_SCOPE_INVALID" });
    await expect(readFile(index, "utf8")).resolves.toBe("index");

    await adapter.cleanup(
      {
        artifacts: [
          "functions/index.json",
          "functions/hello-world/source.multipart",
        ],
        coverage: [],
      },
      { workspaceRoot: root },
    );
    await expect(access(index)).rejects.toThrow();
    await expect(access(body)).rejects.toThrow();
  });

  it("fingerprints the exact Vault root key without retaining plaintext", async () => {
    const firstKey = "ab".repeat(32);
    installVaultCapture(firstKey);
    const adapter = createVaultRootKeyConsistencyAdapter(vaultSource);
    const first = vaultSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );
    expect(first.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(firstKey);

    installVaultCapture("cd".repeat(32));
    const changed = vaultSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );
    expect(changed.artifactSha256).not.toBe(first.artifactSha256);
  });

  it("keeps Vault cleanup scoped to the root key artifact", async () => {
    const root = await workspace();
    const secrets = path.join(root, "secrets");
    await mkdir(secrets, { recursive: true });
    const vault = path.join(secrets, "database-vault-root-key.json");
    const unrelated = path.join(secrets, "api-keys.json");
    await writeFile(vault, "vault");
    await writeFile(unrelated, "keys");

    const adapter = createVaultRootKeyConsistencyAdapter(vaultSource);
    await expect(
      adapter.cleanup(
        {
          artifacts: [
            "secrets/database-vault-root-key.json",
            "secrets/api-keys.json",
          ],
          coverage: [],
        },
        { workspaceRoot: root },
      ),
    ).rejects.toMatchObject({ code: "CONSISTENCY_CLEANUP_SCOPE_INVALID" });
    await expect(readFile(vault, "utf8")).resolves.toBe("vault");

    await adapter.cleanup(
      {
        artifacts: ["secrets/database-vault-root-key.json"],
        coverage: [],
      },
      { workspaceRoot: root },
    );
    await expect(access(vault)).rejects.toThrow();
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keys");
  });

  it("makes specialized Vector snapshots independent of pagination boundaries", async () => {
    const vectors = [
      { key: "one", data: [0.1, 0.2] },
      { key: "two", data: [0.3, 0.4] },
    ];
    installSpecializedCapture({ pages: [[vectors[0]!], [vectors[1]!]] });
    const adapter = createSpecializedStorageConsistencyAdapter(storageSource);
    const twoPages = specializedSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );

    installSpecializedCapture({ pages: [vectors] });
    const onePage = specializedSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );

    expect(onePage).toEqual(twoPages);
    expect(onePage.vectors).toHaveLength(2);
    expect(JSON.stringify(onePage)).not.toContain("0.1");
  });

  it("detects specialized Vector data drift and ignores Analytics table ordering", async () => {
    installSpecializedCapture({
      pages: [[{ key: "one", data: [0.1, 0.2] }]],
      analyticsTables: [
        { name: "events", "current-snapshot-id": 1 },
        { name: "users", "current-snapshot-id": 2 },
      ],
    });
    const adapter = createSpecializedStorageConsistencyAdapter(storageSource);
    const before = specializedSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );

    installSpecializedCapture({
      pages: [[{ key: "one", data: [9.9, 0.2] }]],
      analyticsTables: [
        { name: "users", "current-snapshot-id": 2 },
        { name: "events", "current-snapshot-id": 1 },
      ],
    });
    const dataChanged = specializedSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );
    expect(dataChanged.vectors).not.toEqual(before.vectors);

    installSpecializedCapture({
      pages: [[{ key: "one", data: [0.1, 0.2] }]],
      analyticsTables: [
        { name: "users", "current-snapshot-id": 2 },
        { name: "events", "current-snapshot-id": 1 },
      ],
    });
    const reorderedOnly = specializedSnapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );
    expect(reorderedOnly).toEqual(before);
  });

  it("prevalidates specialized Storage dynamic cleanup paths", async () => {
    const root = await workspace();
    const vectorDirectory = path.join(
      root,
      "secrets",
      "storage",
      "vectors",
      "a".repeat(64),
    );
    await mkdir(vectorDirectory, { recursive: true });
    const vectorPage = path.join(vectorDirectory, "00000001.json");
    const summary = path.join(
      root,
      "secrets",
      "storage",
      "vector-summary.json",
    );
    await mkdir(path.dirname(summary), { recursive: true });
    await writeFile(vectorPage, "vector");
    await writeFile(summary, "summary");

    const adapter = createSpecializedStorageConsistencyAdapter(storageSource);
    await expect(
      adapter.cleanup(
        {
          artifacts: [
            `secrets/storage/vectors/${"a".repeat(64)}/00000001.json`,
            "secrets/storage/file-object-index.json",
          ],
          coverage: [],
        },
        { workspaceRoot: root },
      ),
    ).rejects.toMatchObject({ code: "CONSISTENCY_CLEANUP_SCOPE_INVALID" });
    await expect(readFile(vectorPage, "utf8")).resolves.toBe("vector");

    await adapter.cleanup(
      {
        artifacts: [
          `secrets/storage/vectors/${"a".repeat(64)}/00000001.json`,
          "secrets/storage/vector-summary.json",
        ],
        coverage: [],
      },
      { workspaceRoot: root },
    );
    await expect(access(vectorPage)).rejects.toThrow();
    await expect(access(summary)).rejects.toThrow();
  });

  it("honors cancellation before final consistency cleanup begins", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const reason = new Error("cancel final consistency cleanup");
    controller.abort(reason);

    await expect(
      createEdgeConsistencyAdapter(edgeSource).cleanup(
        { artifacts: [], coverage: [] },
        { workspaceRoot: root, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });
});
