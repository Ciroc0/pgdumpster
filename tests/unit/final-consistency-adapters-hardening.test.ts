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

import { createEdgeConsistencyAdapter } from "../../src/core/backup/edge-consistency-adapter.js";
import { createSpecializedStorageConsistencyAdapter } from "../../src/core/backup/specialized-storage-consistency-adapter.js";
import { createVaultRootKeyConsistencyAdapter } from "../../src/core/backup/vault-root-key-consistency-adapter.js";
import type { BundleArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import type { CoverageDocument } from "../../src/core/bundle/schemas.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";
import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
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
const VECTOR_PAGE = `secrets/storage/vectors/${"a".repeat(64)}/00000001.json`;
const VECTOR_PAGE_TWO = `secrets/storage/vectors/${"a".repeat(64)}/00000002.json`;
const ANALYTICS_CATALOG = `storage/analytics-catalog/${"b".repeat(64)}.json`;

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
    path.join(tmpdir(), "pgdumpster-final-consistency-hardening-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function coverage(id: string, artifacts: string[]): CoverageEntry {
  return {
    id,
    status: "backed_up",
    sensitivity: "internal",
    artifacts,
  };
}

async function writeRequiredSpecializedCatalogs(
  ordinary: BundleArtifactSink,
  signal?: AbortSignal,
): Promise<void> {
  await ordinary.writeJson(
    "storage/vector-buckets.json",
    { schemaVersion: 1, buckets: [] },
    signal,
  );
  await ordinary.writeJson(
    "storage/vector-indexes.json",
    { schemaVersion: 1, indexes: [] },
    signal,
  );
  await ordinary.writeJson(
    "storage/analytics-buckets.json",
    { schemaVersion: 1, buckets: [] },
    signal,
  );
}

async function writeValidVectorSummary(
  protectedSink: ProtectedArtifactSink,
  signal?: AbortSignal,
): Promise<void> {
  await protectedSink.writeJson(
    "secrets/storage/vector-summary.json",
    {
      schemaVersion: 1,
      indexes: [
        {
          bucketName: "embeddings",
          indexName: "documents",
          vectorCount: 1,
        },
      ],
    },
    signal,
  );
}

async function writeValidVectorPage(
  protectedSink: ProtectedArtifactSink,
  relativePath = VECTOR_PAGE,
  key = "vector-one",
  signal?: AbortSignal,
): Promise<void> {
  await protectedSink.writeJson(
    relativePath,
    {
      schemaVersion: 1,
      bucketName: "embeddings",
      indexName: "documents",
      vectors: [{ key, data: { float32: [0.1, 0.2] } }],
    },
    signal,
  );
}

describe("final consistency adapter hardening", () => {
  it("fails closed on malformed Edge index shapes", async () => {
    const malformedFunctions: unknown[] = [
      "not-an-array",
      [null],
      ["invalid-entry"],
      [[]],
    ];

    for (const functions of malformedFunctions) {
      vi.mocked(captureEdgeState).mockImplementationOnce(
        async (_client, _ref, protectedSink, ordinary, options) => {
          await protectedSink.writeJson(
            "secrets/edge-secret-digests.json",
            { schemaVersion: 1, secrets: [] },
            options?.signal,
          );
          await ordinary.writeJson(
            "functions/index.json",
            { schemaVersion: 1, functions },
            options?.signal,
          );
          return { coverage: [] };
        },
      );

      await expect(
        createEdgeConsistencyAdapter(edgeSource).snapshot({
          workspaceRoot: "unused",
        }),
      ).rejects.toMatchObject({
        code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
        category: "consistency",
      });
    }
  });

  it("rejects unexpected Edge ordinary, stream and protected artifacts", async () => {
    vi.mocked(captureEdgeState).mockImplementationOnce(
      async (_client, _ref, _protectedSink, ordinary, options) => {
        await ordinary.writeJson(
          "functions/unexpected.json",
          { schemaVersion: 1 },
          options?.signal,
        );
        return { coverage: [] };
      },
    );
    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID" });

    let cancelled = false;
    vi.mocked(captureEdgeState).mockImplementationOnce(
      async (_client, _ref, _protectedSink, ordinary, options) => {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        });
        await ordinary.writeStream("functions/not-a-body.bin", stream, {
          maxBytes: 1,
          signal: options?.signal,
        });
        return { coverage: [] };
      },
    );
    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID" });
    expect(cancelled).toBe(true);

    vi.mocked(captureEdgeState).mockImplementationOnce(
      async (_client, _ref, protectedSink) => {
        await protectedSink.writeJson("secrets/not-edge.json", {
          schemaVersion: 1,
        });
        return { coverage: [] };
      },
    );
    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID" });
  });

  it("requires both Edge markers and wraps non-consistency capture failures", async () => {
    vi.mocked(captureEdgeState).mockResolvedValueOnce({ coverage: [] });
    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
      category: "consistency",
    });

    vi.mocked(captureEdgeState).mockRejectedValueOnce(
      new Error("edge unavailable"),
    );
    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "EDGE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
    });

    vi.mocked(captureEdgeState).mockRejectedValueOnce(
      new PgDumpsterError({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        category: "platform_contract",
        message: "fixture",
        retryable: false,
      }),
    );
    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "EDGE_CONSISTENCY_SNAPSHOT_FAILED",
      details: { sourceCode: "PLATFORM_API_CONTRACT_CHANGED" },
    });
  });

  it("supports body-less Edge metadata and removes partial Edge output", async () => {
    vi.mocked(captureEdgeState).mockImplementationOnce(
      async (_client, _ref, protectedSink, ordinary, options) => {
        await protectedSink.writeJson(
          "secrets/edge-secret-digests.json",
          { schemaVersion: 1, secrets: [] },
          options?.signal,
        );
        await ordinary.writeJson(
          "functions/index.json",
          {
            schemaVersion: 1,
            representation: "management-api-multipart",
            functions: [{ metadata: { slug: "hello" }, body: null }],
          },
          options?.signal,
        );
        return { coverage: [] };
      },
    );

    await expect(
      createEdgeConsistencyAdapter(edgeSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).resolves.toMatchObject({ schemaVersion: 1 });

    const root = await workspace();
    await mkdir(path.join(root, "functions", "hello"), { recursive: true });
    await mkdir(path.join(root, "secrets"), { recursive: true });
    await writeFile(path.join(root, "functions", "index.json"), "index");
    await writeFile(
      path.join(root, "functions", "hello", "source.multipart"),
      "body",
    );
    await writeFile(
      path.join(root, "secrets", "edge-secret-digests.json"),
      "secret-digests",
    );

    const adapter = createEdgeConsistencyAdapter(edgeSource);
    await adapter.cleanupPartial?.({ workspaceRoot: root });

    await expect(access(path.join(root, "functions"))).rejects.toThrow();
    await expect(
      access(path.join(root, "secrets", "edge-secret-digests.json")),
    ).rejects.toThrow();
  });

  it("fails closed when Vault snapshot evidence is wrong or missing", async () => {
    vi.mocked(captureVaultRootKey).mockImplementationOnce(
      async (_client, _ref, _redactor, sink, signal) => {
        await sink.writeJson("secrets/not-vault.json", { value: "x" }, signal);
        throw new Error("unreachable");
      },
    );
    await expect(
      createVaultRootKeyConsistencyAdapter(vaultSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID" });

    vi.mocked(captureVaultRootKey).mockResolvedValueOnce({
      rootKey: new SecretValue("ab".repeat(32), new Redactor()),
      coverage: coverage("database.vault_root_key", []),
    });
    await expect(
      createVaultRootKeyConsistencyAdapter(vaultSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING" });

    vi.mocked(captureVaultRootKey).mockRejectedValueOnce(
      new Error("vault unavailable"),
    );
    await expect(
      createVaultRootKeyConsistencyAdapter(vaultSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "VAULT_ROOT_KEY_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
    });
  });

  it("deduplicates Vault cleanup input and supports partial cleanup", async () => {
    const root = await workspace();
    const relative = "secrets/database-vault-root-key.json";
    const absolute = path.join(root, "secrets", "database-vault-root-key.json");
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "vault");

    const adapter = createVaultRootKeyConsistencyAdapter(vaultSource);
    await adapter.cleanup(
      { artifacts: [relative, relative], coverage: [] },
      { workspaceRoot: root },
    );
    await expect(access(absolute)).rejects.toThrow();

    await writeFile(absolute, "vault-again");
    await adapter.cleanupPartial?.({ workspaceRoot: root });
    await expect(access(absolute)).rejects.toThrow();
  });

  it("normalizes Analytics catalogs across irregular namespace/table shapes", async () => {
    const analyticsShapes: unknown[] = [
      { not: "an array" },
      [null, "plain", [], { namespace: ["z"], tables: "not-an-array" }],
      [
        { namespace: ["z"], tables: [{ name: "b" }, { name: "a" }] },
        { namespace: ["a"], tables: [{ name: "c" }] },
      ],
    ];

    for (const namespaces of analyticsShapes) {
      vi.mocked(captureSpecializedStorage).mockImplementationOnce(
        async (_client, ordinary, protectedSink, signal) => {
          await writeRequiredSpecializedCatalogs(ordinary, signal);
          await writeValidVectorSummary(protectedSink, signal);
          await ordinary.writeJson(
            ANALYTICS_CATALOG,
            { schemaVersion: 1, namespaces },
            signal,
          );
          return { coverage: [] };
        },
      );

      await expect(
        createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
          workspaceRoot: "unused",
        }),
      ).resolves.toMatchObject({ schemaVersion: 1 });
    }
  });

  it("rejects invalid specialized Vector page envelope fields", async () => {
    const invalidPages: Readonly<Record<string, unknown>>[] = [
      { bucketName: 1, indexName: "documents", vectors: [] },
      { bucketName: "embeddings", indexName: 1, vectors: [] },
      { bucketName: "embeddings", indexName: "documents", vectors: {} },
    ];

    for (const value of invalidPages) {
      vi.mocked(captureSpecializedStorage).mockImplementationOnce(
        async (_client, _ordinary, protectedSink, signal) => {
          await protectedSink.writeJson(VECTOR_PAGE, value, signal);
          return { coverage: [] };
        },
      );

      await expect(
        createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
          workspaceRoot: "unused",
        }),
      ).rejects.toMatchObject({
        code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
      });
    }
  });

  it("rejects malformed specialized Vector summaries", async () => {
    const invalidSummaries: Readonly<Record<string, unknown>>[] = [
      { indexes: "not-an-array" },
      { indexes: [null] },
      { indexes: ["invalid"] },
      { indexes: [[]] },
      { indexes: [{ bucketName: 1, indexName: "i", vectorCount: 1 }] },
      { indexes: [{ bucketName: "b", indexName: 1, vectorCount: 1 }] },
      { indexes: [{ bucketName: "b", indexName: "i", vectorCount: "1" }] },
      { indexes: [{ bucketName: "b", indexName: "i", vectorCount: 1.5 }] },
      { indexes: [{ bucketName: "b", indexName: "i", vectorCount: -1 }] },
    ];

    for (const value of invalidSummaries) {
      vi.mocked(captureSpecializedStorage).mockImplementationOnce(
        async (_client, _ordinary, protectedSink, signal) => {
          await protectedSink.writeJson(
            "secrets/storage/vector-summary.json",
            value,
            signal,
          );
          return { coverage: [] };
        },
      );

      await expect(
        createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
          workspaceRoot: "unused",
        }),
      ).rejects.toMatchObject({
        code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
      });
    }
  });

  it("rejects unexpected and duplicate specialized artifacts", async () => {
    const cases: (() => void)[] = [
      () => {
        vi.mocked(captureSpecializedStorage).mockImplementationOnce(
          async (_client, ordinary) => {
            await ordinary.writeJson("storage/unexpected.json", {
              schemaVersion: 1,
            });
            return { coverage: [] };
          },
        );
      },
      () => {
        vi.mocked(captureSpecializedStorage).mockImplementationOnce(
          async (_client, ordinary) => {
            await ordinary.writeJson("storage/vector-buckets.json", {
              schemaVersion: 1,
              buckets: [],
            });
            await ordinary.writeJson("storage/vector-buckets.json", {
              schemaVersion: 1,
              buckets: [],
            });
            return { coverage: [] };
          },
        );
      },
      () => {
        vi.mocked(captureSpecializedStorage).mockImplementationOnce(
          async (_client, _ordinary, protectedSink) => {
            await protectedSink.writeJson("secrets/storage/unexpected.json", {
              schemaVersion: 1,
            });
            return { coverage: [] };
          },
        );
      },
      () => {
        vi.mocked(captureSpecializedStorage).mockImplementationOnce(
          async (_client, _ordinary, protectedSink) => {
            await writeValidVectorSummary(protectedSink);
            await writeValidVectorSummary(protectedSink);
            return { coverage: [] };
          },
        );
      },
      () => {
        vi.mocked(captureSpecializedStorage).mockImplementationOnce(
          async (_client, _ordinary, protectedSink) => {
            await writeValidVectorPage(protectedSink);
            await writeValidVectorPage(protectedSink);
            return { coverage: [] };
          },
        );
      },
      () => {
        vi.mocked(captureSpecializedStorage).mockImplementationOnce(
          async (_client, _ordinary, protectedSink) => {
            await writeValidVectorPage(protectedSink, VECTOR_PAGE, "same-key");
            await writeValidVectorPage(
              protectedSink,
              VECTOR_PAGE_TWO,
              "same-key",
            );
            return { coverage: [] };
          },
        );
      },
    ];

    for (const install of cases) {
      install();
      await expect(
        createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
          workspaceRoot: "unused",
        }),
      ).rejects.toMatchObject({ category: "consistency" });
    }
  });

  it("rejects invalid specialized Vector values and unstable keys", async () => {
    const invalidVectors: unknown[] = [
      null,
      "invalid",
      [],
      { data: {} },
      { key: 1, data: {} },
      { key: "", data: {} },
    ];

    for (const vector of invalidVectors) {
      vi.mocked(captureSpecializedStorage).mockImplementationOnce(
        async (_client, _ordinary, protectedSink, signal) => {
          await protectedSink.writeJson(
            VECTOR_PAGE,
            {
              bucketName: "embeddings",
              indexName: "documents",
              vectors: [vector],
            },
            signal,
          );
          return { coverage: [] };
        },
      );

      await expect(
        createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
          workspaceRoot: "unused",
        }),
      ).rejects.toMatchObject({
        code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID",
      });
    }
  });

  it("requires complete specialized snapshot evidence and wraps source failures", async () => {
    vi.mocked(captureSpecializedStorage).mockResolvedValueOnce({
      coverage: [],
    });
    await expect(
      createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING" });

    vi.mocked(captureSpecializedStorage).mockImplementationOnce(
      async (_client, ordinary, _protectedSink, signal) => {
        await writeRequiredSpecializedCatalogs(ordinary, signal);
        return { coverage: [] };
      },
    );
    await expect(
      createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING" });

    vi.mocked(captureSpecializedStorage).mockImplementationOnce(
      async (_client, ordinary, protectedSink, signal) => {
        await writeRequiredSpecializedCatalogs(ordinary, signal);
        await writeValidVectorSummary(protectedSink, signal);
        return {
          coverage: [
            coverage("storage.analytics_catalog", [ANALYTICS_CATALOG]),
          ],
        };
      },
    );
    await expect(
      createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING" });

    vi.mocked(captureSpecializedStorage).mockRejectedValueOnce(
      new Error("specialized storage unavailable"),
    );
    await expect(
      createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "SPECIALIZED_STORAGE_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
    });
  });

  it("rejects streamed specialized snapshot artifacts and handles cancel failure", async () => {
    vi.mocked(captureSpecializedStorage).mockImplementationOnce(
      async (_client, ordinary) => {
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            throw new Error("cancel failed");
          },
        });
        await ordinary.writeStream("storage/vector-stream.bin", stream, {
          maxBytes: 1,
        });
        return { coverage: [] };
      },
    );

    await expect(
      createSpecializedStorageConsistencyAdapter(storageSource).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({ code: "CONSISTENCY_SNAPSHOT_ARTIFACT_INVALID" });
  });

  it("removes all specialized partial-output classes without touching unrelated files", async () => {
    const root = await workspace();
    const vectorPage = path.join(
      root,
      "secrets",
      "storage",
      "vectors",
      "a".repeat(64),
      "00000001.json",
    );
    const analytics = path.join(
      root,
      "storage",
      "analytics-catalog",
      `${"b".repeat(64)}.json`,
    );
    const fixed = [
      path.join(root, "storage", "vector-buckets.json"),
      path.join(root, "storage", "vector-indexes.json"),
      path.join(root, "secrets", "storage", "vector-summary.json"),
      path.join(root, "storage", "analytics-buckets.json"),
    ];
    const unrelated = path.join(root, "storage", "keep.txt");

    await mkdir(path.dirname(vectorPage), { recursive: true });
    await mkdir(path.dirname(analytics), { recursive: true });
    await Promise.all(
      [...fixed, vectorPage, analytics, unrelated].map(async (filename) => {
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, "fixture");
      }),
    );

    const adapter = createSpecializedStorageConsistencyAdapter(storageSource);
    await adapter.cleanupPartial?.({ workspaceRoot: root });

    for (const filename of [...fixed, vectorPage, analytics]) {
      await expect(access(filename)).rejects.toThrow();
    }
    await expect(readFile(unrelated, "utf8")).resolves.toBe("fixture");
  });
});
