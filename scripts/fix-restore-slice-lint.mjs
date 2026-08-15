import { readFile, rm, writeFile } from "node:fs/promises";

function replaceAllRequired(text, search, replacement, label) {
  const count = text.split(search).length - 1;
  if (count < 1) throw new Error(`${label}: expected at least one match`);
  return text.replaceAll(search, replacement);
}

function replaceRegexRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`${label}: expected a match`);
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

async function edit(pathname, transform) {
  const before = await readFile(pathname, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${pathname}: codemod made no changes`);
  await writeFile(pathname, after, "utf8");
}

await edit("src/core/restore/edge-function-handler.ts", (text) =>
  replaceAllRequired(
    text,
    "body: source as unknown as BodyInit,",
    "body: source,",
    "Edge deployment stream body",
  ),
);

await edit("src/core/restore/file-storage-handlers.ts", (input) => {
  let text = input;
  text = replaceRegexRequired(
    text,
    /export interface StorageMutationClient \{[\s\S]*?\n\}\n\nexport interface StorageObjectEvidence/,
    `export interface StorageMutationClient {
  createBucket: (
    id: string,
    options: StorageBucketMutationOptions,
  ) => Promise<StorageResult>;
  updateBucket: (
    id: string,
    options: StorageBucketMutationOptions,
  ) => Promise<StorageResult>;
  emptyBucket: (id: string) => Promise<StorageResult>;
  deleteBucket: (id: string) => Promise<StorageResult>;
  from: (id: string) => {
    remove: (paths: string[]) => Promise<StorageResult>;
  };
}

export interface StorageObjectEvidence`,
    "Storage mutation client callable properties",
  );
  text = replaceRegexRequired(
    text,
    /return new StorageClient\(([\s\S]*?)\) as unknown as StorageMutationClient;/,
    "return new StorageClient($1);",
    "StorageClient structural assignment",
  );
  text = replaceAllRequired(
    text,
    "body: body as unknown as BodyInit,",
    "body,",
    "Storage upload stream body",
  );
  text = replaceAllRequired(
    text,
    "names.slice(offset, offset + 1000) as string[]",
    "names.slice(offset, offset + 1000)",
    "Storage remove batch assertion",
  );
  return text;
});

await edit("tests/unit/database-supplement-restore.test.ts", (text) =>
  replaceAllRequired(
    text,
    "const restore = vi.fn().mockResolvedValue(undefined);",
    `const restore = vi
      .fn<
        NonNullable<DatabaseSupplementRestoreDependencies["restoreSqlArtifact"]>
      >()
      .mockResolvedValue(undefined);`,
    "Typed SQL restore mocks",
  ),
);

await edit("tests/unit/edge-function-restore.test.ts", (input) => {
  let text = input;
  text = replaceRegexRequired(
    text,
    /class FakeEdgeClient implements EdgeFunctionRestoreClient \{[\s\S]*?\n\}\n\nfunction options\(/,
    `class FakeEdgeClient implements EdgeFunctionRestoreClient {
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
    if (value === undefined) throw new Error(\`missing function \${slug}\`);
    return Promise.resolve(cloneMetadata(value.metadata));
  }

  body(slug: string) {
    const value = this.values.get(slug);
    if (value === undefined) throw new Error(\`missing function \${slug}\`);
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
    this.mutations.push(\`deploy:\${input.slug}\`);
    const desired = this.desired.get(input.slug);
    if (desired === undefined) throw new Error(\`no desired \${input.slug}\`);
    const body = await readFile(input.sourcePath);
    const target = {
      metadata: {
        ...cloneMetadata(desired),
        id: \`target-\${input.slug}\`,
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
    this.mutations.push(\`delete:\${slug}\`);
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

function options(`,
    "Typed Edge fake client",
  );
  text = replaceAllRequired(
    text,
    "const fetchImpl: typeof fetch = vi.fn(async (input, init) => {",
    `const fetchImpl: typeof fetch = vi.fn<typeof fetch>(async (input, init) => {
      await Promise.resolve();`,
    "Typed Edge fetch mock",
  );
  text = replaceRegexRequired(
    text,
    /const unauthorized: typeof fetch = vi\.fn\(async \(\) =>\s*new Response\("sensitive provider body", \{ status: 403 \}\),\s*\);/,
    `const unauthorized: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("sensitive provider body", { status: 403 })),
    );`,
    "Edge unauthorized fetch mock",
  );
  text = replaceRegexRequired(
    text,
    /const invalidJson: typeof fetch = vi\.fn\(async \(\) =>\s*new Response\("not-json", \{ status: 200 \}\),\s*\);/,
    `const invalidJson: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("not-json", { status: 200 })),
    );`,
    "Edge invalid JSON fetch mock",
  );
  return text;
});

await edit("tests/unit/file-storage-restore.test.ts", (input) => {
  let text = input;
  text = replaceRegexRequired(
    text,
    /function mutationClient\([\s\S]*?\n\}\n\nfunction restoreOptions\(/,
    `function mutationClient(
  target: FileStorageCatalog,
  evidence = new Map<string, StorageObjectEvidence>(),
): StorageMutationClient {
  const createBucket = vi.fn<StorageMutationClient["createBucket"]>(
    (id, options) => {
      target.buckets.push(
        bucket(id, {
          public: options.public,
          fileSizeLimit: options.fileSizeLimit,
          allowedMimeTypes: options.allowedMimeTypes,
        }),
      );
      return Promise.resolve(success());
    },
  );
  const updateBucket = vi.fn<StorageMutationClient["updateBucket"]>(
    (id, options) => {
      const current = target.buckets.find((entry) => entry.id === id);
      if (current !== undefined) {
        current.public = options.public;
        current.fileSizeLimit = options.fileSizeLimit;
        current.allowedMimeTypes = options.allowedMimeTypes;
      }
      return Promise.resolve(success());
    },
  );
  const emptyBucket = vi.fn<StorageMutationClient["emptyBucket"]>((id) => {
    target.objects = target.objects.filter((entry) => entry.bucket !== id);
    for (const key of [...evidence.keys()]) {
      if (key.startsWith(\`\${id}\\0\`)) evidence.delete(key);
    }
    return Promise.resolve(success());
  });
  const deleteBucket = vi.fn<StorageMutationClient["deleteBucket"]>((id) => {
    target.buckets = target.buckets.filter((entry) => entry.id !== id);
    return Promise.resolve(success());
  });
  const from: StorageMutationClient["from"] = (id) => ({
    remove: vi.fn<ReturnType<StorageMutationClient["from"]>["remove"]>(
      (names) => {
        const namesToRemove = new Set(names);
        target.objects = target.objects.filter(
          (entry) => entry.bucket !== id || !namesToRemove.has(entry.name),
        );
        for (const name of names) evidence.delete(objectIdentity(id, name));
        return Promise.resolve(success());
      },
    ),
  });
  return { createBucket, updateBucket, emptyBucket, deleteBucket, from };
}

function restoreOptions(`,
    "Typed File Storage mutation client",
  );
  text = replaceRegexRequired(
    text,
    /collectTarget: async \(\) => target,\s*readTargetObject: async \(bucketId, name\) =>\s*evidence\.get\(objectIdentity\(bucketId, name\)\),/,
    `collectTarget: () => Promise.resolve(target),
    readTargetObject: (bucketId, name) =>
      Promise.resolve(evidence.get(objectIdentity(bucketId, name))),`,
    "File Storage object dependencies",
  );
  text = text.replace(
    /collectTarget: async \(\) => ([A-Za-z_][A-Za-z0-9_]*),/gu,
    "collectTarget: () => Promise.resolve($1),",
  );
  text = replaceRegexRequired(
    text,
    /collectTarget: async \(\) =>\s*uploaded \? cloneCatalog\(fixture\.catalog\) : emptyTarget,/,
    `collectTarget: () =>
        Promise.resolve(uploaded ? cloneCatalog(fixture.catalog) : emptyTarget),`,
    "Conditional File Storage target collector",
  );
  text = replaceRegexRequired(
    text,
    /client\.createBucket = vi\.fn\(async \(\) => \(\{\s*data: null,\s*error: \{ message: "do not surface provider detail", statusCode: "500" \},\s*\}\)\);/,
    `client.createBucket = vi.fn<StorageMutationClient["createBucket"]>(() =>
      Promise.resolve({
        data: null,
        error: { message: "do not surface provider detail", statusCode: "500" },
      }),
    );`,
    "Typed failing bucket mock",
  );
  text = replaceAllRequired(
    text,
    "const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {",
    `const fetchImpl: typeof fetch = vi.fn<typeof fetch>(async (_input, init) => {
      await Promise.resolve();`,
    "Typed File Storage fetch mock",
  );
  text = replaceRegexRequired(
    text,
    /const uploadFailure: typeof fetch = vi\.fn\(async \(\) =>\s*new Response\("failure", \{ status: 503 \}\),\s*\);/,
    `const uploadFailure: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("failure", { status: 503 })),
    );`,
    "Typed upload failure fetch",
  );
  text = replaceRegexRequired(
    text,
    /const verifyFailure: typeof fetch = vi\.fn\(async \(\) =>\s*new Response\("failure", \{ status: 500 \}\),\s*\);/,
    `const verifyFailure: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("failure", { status: 500 })),
    );`,
    "Typed verify failure fetch",
  );
  return text;
});

await edit("tests/unit/vector-storage-restore.test.ts", (input) => {
  let text = input;
  text = replaceRegexRequired(
    text,
    /class FakeVectorClient implements VectorMutationClient \{[\s\S]*?\n\}\n\nfunction options\(/,
    `class FakeVectorClient implements VectorMutationClient {
  readonly buckets = new Map<string, FakeBucketState>();
  readonly mutations: string[] = [];
  cycleVectorsFor?: string;

  listBuckets(): Promise<unknown> {
    return Promise.resolve({
      data: {
        vectorBuckets: [...this.buckets.keys()]
          .sort((left, right) => left.localeCompare(right, "en"))
          .map((vectorBucketName) => ({ vectorBucketName })),
      },
      error: null,
    });
  }

  getBucket(bucketName: string): Promise<unknown> {
    const bucket = this.buckets.get(bucketName);
    return Promise.resolve(
      bucket === undefined
        ? { data: null, error: { status: 404 } }
        : {
            data: {
              vectorBucket: {
                vectorBucketName: bucket.vectorBucketName,
                creationTime: bucket.creationTime ?? 999,
              },
            },
            error: null,
          },
    );
  }

  createBucket(bucketName: string): Promise<unknown> {
    this.mutations.push(\`create-bucket:\${bucketName}\`);
    this.buckets.set(bucketName, {
      vectorBucketName: bucketName,
      indexes: new Map(),
    });
    return Promise.resolve({ data: {}, error: null });
  }

  deleteBucket(bucketName: string): Promise<unknown> {
    const bucket = this.buckets.get(bucketName);
    if ((bucket?.indexes.size ?? 0) > 0) {
      return Promise.resolve({ data: null, error: { statusCode: "409" } });
    }
    this.mutations.push(\`delete-bucket:\${bucketName}\`);
    this.buckets.delete(bucketName);
    return Promise.resolve({ data: {}, error: null });
  }

  from(bucketName: string): VectorBucketMutationClient {
    const currentBucket = (): FakeBucketState => {
      const value = this.buckets.get(bucketName);
      if (value === undefined) throw new Error(\`missing bucket \${bucketName}\`);
      return value;
    };
    return {
      listIndexes: () =>
        Promise.resolve({
          data: {
            indexes: [...currentBucket().indexes.keys()]
              .sort((left, right) => left.localeCompare(right, "en"))
              .map((indexName) => ({ indexName })),
          },
          error: null,
        }),
      getIndex: (indexName) => {
        const index = currentBucket().indexes.get(indexName);
        return Promise.resolve(
          index === undefined
            ? { data: null, error: { status: 404 } }
            : {
                data: {
                  index: {
                    indexName: index.indexName,
                    vectorBucketName: index.vectorBucketName,
                    dataType: index.dataType,
                    dimension: index.dimension,
                    distanceMetric: index.distanceMetric,
                    ...(index.metadataConfiguration === undefined
                      ? {}
                      : { metadataConfiguration: index.metadataConfiguration }),
                    creationTime: index.creationTime ?? 999,
                  },
                },
                error: null,
              },
        );
      },
      createIndex: (indexInput) => {
        this.mutations.push(
          \`create-index:\${bucketName}/\${indexInput.indexName}\`,
        );
        currentBucket().indexes.set(indexInput.indexName, {
          vectorBucketName: bucketName,
          indexName: indexInput.indexName,
          dataType: indexInput.dataType,
          dimension: indexInput.dimension,
          distanceMetric: indexInput.distanceMetric,
          ...(indexInput.metadataConfiguration === undefined
            ? {}
            : { metadataConfiguration: indexInput.metadataConfiguration }),
          vectors: new Map(),
        });
        return Promise.resolve({ data: {}, error: null });
      },
      deleteIndex: (indexName) => {
        this.mutations.push(\`delete-index:\${bucketName}/\${indexName}\`);
        currentBucket().indexes.delete(indexName);
        return Promise.resolve({ data: {}, error: null });
      },
      index: (indexName): VectorIndexMutationClient => {
        const currentIndex = (): FakeIndexState => {
          const value = currentBucket().indexes.get(indexName);
          if (value === undefined) {
            throw new Error(\`missing index \${bucketName}/\${indexName}\`);
          }
          return value;
        };
        return {
          listVectors: (listOptions) => {
            const vectorIdentity = \`\${bucketName}\\0\${indexName}\`;
            if (this.cycleVectorsFor === vectorIdentity) {
              return Promise.resolve({
                data: { vectors: [], nextToken: "repeat-token" },
                error: null,
              });
            }
            const values = [...currentIndex().vectors.values()].sort(
              (left, right) => left.key.localeCompare(right.key, "en"),
            );
            const offset =
              listOptions.nextToken === undefined
                ? 0
                : Number(listOptions.nextToken);
            const page = values.slice(
              offset,
              offset + listOptions.maxResults,
            );
            const next = offset + page.length;
            return Promise.resolve({
              data: {
                vectors: page,
                ...(next < values.length ? { nextToken: String(next) } : {}),
              },
              error: null,
            });
          },
          putVectors: ({ vectors }) => {
            this.mutations.push(
              \`put:\${bucketName}/\${indexName}:\${vectors.length}\`,
            );
            for (const value of vectors) {
              currentIndex().vectors.set(value.key, structuredClone(value));
            }
            return Promise.resolve({ data: {}, error: null });
          },
          deleteVectors: ({ keys }) => {
            this.mutations.push(
              \`delete-vectors:\${bucketName}/\${indexName}:\${keys.length}\`,
            );
            for (const key of keys) currentIndex().vectors.delete(key);
            return Promise.resolve({ data: {}, error: null });
          },
        };
      },
    };
  }

  addBucket(name: string): FakeBucketState {
    const value: FakeBucketState = {
      vectorBucketName: name,
      creationTime: 42,
      indexes: new Map(),
    };
    this.buckets.set(name, value);
    return value;
  }

  addIndex(
    bucketName: string,
    overrides: Partial<Omit<FakeIndexState, "vectors">> = {},
  ): FakeIndexState {
    const bucket = this.buckets.get(bucketName) ?? this.addBucket(bucketName);
    const value: FakeIndexState = {
      indexName: "documents",
      vectorBucketName: bucketName,
      dataType: "float32",
      dimension: 3,
      distanceMetric: "cosine",
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["raw_text"],
      },
      creationTime: 84,
      vectors: new Map(),
      ...overrides,
    };
    bucket.indexes.set(value.indexName, value);
    return value;
  }
}

function options(`,
    "Typed Vector fake client",
  );
  text = replaceRegexRequired(
    text,
    /client\.createBucket = vi\.fn\(async \(\) => \(\{\s*data: null,\s*error: \{ statusCode: "503", message: "provider detail" \},\s*\}\)\);/,
    `client.createBucket = vi.fn<VectorMutationClient["createBucket"]>(() =>
      Promise.resolve({
        data: null,
        error: { statusCode: "503", message: "provider detail" },
      }),
    );`,
    "Typed Vector failure mock",
  );
  return text;
});

await rm(new URL(import.meta.url));
