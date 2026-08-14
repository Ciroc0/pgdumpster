import { mkdir } from "node:fs/promises";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";
import type { SecretValue } from "../security/secret-value.js";
import { writeFileAtomic } from "../utils/atomic-file.js";
import { canonicalJson } from "../utils/canonical-json.js";
import {
  createLinkedDatabaseQuery,
  type LinkedDatabaseQueryDependencies,
} from "../database/linked-query.js";

const { Client } = pg;

const nullableString = z.string().nullable();
const bucketRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  public: z.boolean(),
  type: z.enum(["STANDARD", "ANALYTICS"]),
  file_size_limit: z.coerce.bigint().nonnegative().nullable(),
  allowed_mime_types: z.array(z.string()).nullable(),
  created_at: nullableString,
  updated_at: nullableString,
});
const objectRowSchema = z.object({
  id: z.string().min(1),
  bucket_id: z.string().min(1),
  name: z.string().min(1),
  owner: nullableString,
  owner_id: nullableString,
  version: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
  last_accessed_at: nullableString,
  metadata: z.record(z.string(), z.unknown()).nullable(),
  user_metadata: z.record(z.string(), z.unknown()).nullable(),
});

export interface FileStorageBucket {
  id: string;
  name: string;
  public: boolean;
  type: "STANDARD";
  fileSizeLimit: string | null;
  allowedMimeTypes: string[] | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface FileStorageObject {
  id: string;
  bucket: string;
  name: string;
  owner: string | null;
  ownerId: string | null;
  version: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastAccessedAt: string | null;
  expectedBytes: number | null;
  metadata: Record<string, unknown> | null;
  userMetadata: Record<string, unknown> | null;
}

export interface FileStorageCatalog {
  schemaVersion: 1;
  buckets: FileStorageBucket[];
  objects: FileStorageObject[];
}

export interface FileStorageCatalogRows {
  buckets: unknown[];
  objects: unknown[];
}

export interface FileStorageCatalogClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface FileStorageCatalogDependencies {
  createClient?: (connectionString: string) => FileStorageCatalogClient;
}

export type LinkedFileStorageCatalogDependencies =
  LinkedDatabaseQueryDependencies;

function metadataBytes(
  metadata: Record<string, unknown> | null,
): number | null {
  if (metadata === null) return null;
  const value = metadata["size"];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeFileStorageCatalog(
  rows: FileStorageCatalogRows,
): FileStorageCatalog {
  const allBuckets = z.array(bucketRowSchema).parse(rows.buckets);
  const standardBuckets = allBuckets.filter(({ type }) => type === "STANDARD");
  const bucketIds = new Set(standardBuckets.map(({ id }) => id));
  const objects = z
    .array(objectRowSchema)
    .parse(rows.objects)
    .filter(({ bucket_id }) => bucketIds.has(bucket_id));
  const identities = new Set<string>();
  for (const object of objects) {
    const identity = `${object.bucket_id}\0${object.name}`;
    if (identities.has(identity)) {
      throw new Error("Duplicate File Storage object identity");
    }
    identities.add(identity);
  }
  return {
    schemaVersion: 1,
    buckets: standardBuckets
      .map((bucket) => ({
        id: bucket.id,
        name: bucket.name,
        public: bucket.public,
        type: "STANDARD" as const,
        fileSizeLimit: bucket.file_size_limit?.toString() ?? null,
        allowedMimeTypes: bucket.allowed_mime_types,
        createdAt: bucket.created_at,
        updatedAt: bucket.updated_at,
      }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    objects: objects
      .map((object) => ({
        id: object.id,
        bucket: object.bucket_id,
        name: object.name,
        owner: object.owner,
        ownerId: object.owner_id,
        version: object.version,
        createdAt: object.created_at,
        updatedAt: object.updated_at,
        lastAccessedAt: object.last_accessed_at,
        expectedBytes: metadataBytes(object.metadata),
        metadata: object.metadata,
        userMetadata: object.user_metadata,
      }))
      .sort((left, right) =>
        `${left.bucket}\0${left.name}`.localeCompare(
          `${right.bucket}\0${right.name}`,
          "en",
        ),
      ),
  };
}

const BUCKETS_SQL = `
select
  id::text,
  name::text,
  public,
  type::text,
  file_size_limit,
  allowed_mime_types,
  created_at::text,
  updated_at::text
from storage.buckets
order by id
`;

const OBJECTS_SQL = `
select
  id::text,
  bucket_id::text,
  name::text,
  owner::text,
  owner_id::text,
  version::text,
  created_at::text,
  updated_at::text,
  last_accessed_at::text,
  metadata,
  user_metadata
from storage.objects
order by bucket_id, name
`;

async function persistFileStorageCatalog(
  catalog: FileStorageCatalog,
  outputDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  const storageDirectory = path.join(outputDirectory, "storage");
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    path.join(storageDirectory, "file-catalog.json"),
    canonicalJson(catalog),
    { signal },
  );
}

export async function collectLinkedFileStorageCatalog(
  outputDirectory: string,
  signal?: AbortSignal,
  dependencies: LinkedFileStorageCatalogDependencies = {},
): Promise<FileStorageCatalog> {
  signal?.throwIfAborted();
  try {
    const query = await createLinkedDatabaseQuery(signal, dependencies);
    const buckets = await query(BUCKETS_SQL);
    const objects = await query(OBJECTS_SQL);
    const catalog = normalizeFileStorageCatalog({ buckets, objects });
    await persistFileStorageCatalog(catalog, outputDirectory, signal);
    return catalog;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "STORAGE_INVENTORY_FAILED",
      category: "storage",
      message: "Linked File Storage catalog inventory failed.",
      retryable: false,
      component: "storage.file_metadata",
      cause: error,
    });
  }
}

export async function collectFileStorageCatalog(
  connectionString: SecretValue,
  outputDirectory: string,
  signal?: AbortSignal,
  dependencies: FileStorageCatalogDependencies = {},
): Promise<FileStorageCatalog> {
  signal?.throwIfAborted();
  const client =
    dependencies.createClient?.(connectionString.expose()) ??
    new Client({
      connectionString: connectionString.expose(),
      application_name: "pgdumpster-storage-catalog",
      connectionTimeoutMillis: 10_000,
      statement_timeout: 300_000,
    });
  try {
    await client.connect();
    const buckets = await client.query(BUCKETS_SQL);
    signal?.throwIfAborted();
    const objects = await client.query(OBJECTS_SQL);
    signal?.throwIfAborted();
    const catalog = normalizeFileStorageCatalog({
      buckets: buckets.rows,
      objects: objects.rows,
    });
    await persistFileStorageCatalog(catalog, outputDirectory, signal);
    return catalog;
  } catch (error) {
    signal?.throwIfAborted();
    throw new PgDumpsterError({
      code: "STORAGE_INVENTORY_FAILED",
      category: "storage",
      message: "File Storage catalog inventory failed.",
      retryable: false,
      component: "storage.file_metadata",
      cause: error,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
