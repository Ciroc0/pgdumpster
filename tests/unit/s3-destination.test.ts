import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  materializeS3Backup,
  publishS3Backup,
  type S3DestinationConfig,
} from "../../src/destination/s3.js";

const temporaryDirectories: string[] = [];

function awsError(status: number, name: string): Error {
  const error = new Error(name) as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    body === null ||
    typeof body !== "object" ||
    !(Symbol.asyncIterator in body)
  ) {
    throw new Error("unsupported fake S3 body");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array))
      throw new Error("invalid fake S3 chunk");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
  contentType?: string | undefined;
}

interface MultipartUpload {
  bucket: string;
  key: string;
  metadata: Record<string, string>;
  parts: Map<number, { body: Buffer; etag: string }>;
}

class FakeS3Service {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, MultipartUpload>();
  failPartOnce: number | undefined;
  failMarkerOnce = false;
  private nextUpload = 1;

  readonly send = vi.fn(
    async (command: unknown): Promise<Record<string, unknown>> => {
      if (command instanceof HeadObjectCommand) {
        const object = this.objects.get(command.input.Key!);
        if (object === undefined) throw awsError(404, "NotFound");
        return {
          ContentLength: object.body.length,
          Metadata: object.metadata,
        };
      }
      if (command instanceof GetObjectCommand) {
        const object = this.objects.get(command.input.Key!);
        if (object === undefined) throw awsError(404, "NoSuchKey");
        return {
          ContentLength: object.body.length,
          Metadata: object.metadata,
          Body: Readable.from([object.body]),
        };
      }
      if (command instanceof CreateMultipartUploadCommand) {
        const uploadId = `upload-${this.nextUpload++}`;
        this.uploads.set(uploadId, {
          bucket: command.input.Bucket!,
          key: command.input.Key!,
          metadata: { ...(command.input.Metadata ?? {}) },
          parts: new Map(),
        });
        return { UploadId: uploadId };
      }
      if (command instanceof UploadPartCommand) {
        const upload = this.uploads.get(command.input.UploadId!);
        if (upload === undefined) throw awsError(404, "NoSuchUpload");
        const partNumber = command.input.PartNumber!;
        if (this.failPartOnce === partNumber) {
          this.failPartOnce = undefined;
          throw awsError(503, "SlowDown");
        }
        const body = await bodyBytes(command.input.Body);
        const etag = `etag-${partNumber}-${body.length}`;
        upload.parts.set(partNumber, { body, etag });
        return { ETag: etag };
      }
      if (command instanceof ListPartsCommand) {
        const upload = this.uploads.get(command.input.UploadId!);
        if (upload === undefined) throw awsError(404, "NoSuchUpload");
        return {
          IsTruncated: false,
          Parts: [...upload.parts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([partNumber, part]) => ({
              PartNumber: partNumber,
              ETag: part.etag,
              Size: part.body.length,
            })),
        };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        const upload = this.uploads.get(command.input.UploadId!);
        if (upload === undefined) throw awsError(404, "NoSuchUpload");
        const parts = command.input.MultipartUpload?.Parts ?? [];
        const body = Buffer.concat(
          parts.map(({ PartNumber }) => {
            const part = upload.parts.get(PartNumber!);
            if (part === undefined) throw new Error("missing multipart part");
            return part.body;
          }),
        );
        this.objects.set(upload.key, {
          body,
          metadata: upload.metadata,
          contentType: "application/octet-stream",
        });
        this.uploads.delete(command.input.UploadId!);
        return { ETag: "completed-etag" };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        this.uploads.delete(command.input.UploadId!);
        return {};
      }
      if (command instanceof PutObjectCommand) {
        if (
          this.failMarkerOnce &&
          command.input.Key?.endsWith("COMPLETE.json")
        ) {
          this.failMarkerOnce = false;
          throw awsError(503, "ServiceUnavailable");
        }
        if (
          command.input.IfNoneMatch === "*" &&
          this.objects.has(command.input.Key!)
        ) {
          throw awsError(412, "PreconditionFailed");
        }
        this.objects.set(command.input.Key!, {
          body: await bodyBytes(command.input.Body),
          metadata: { ...(command.input.Metadata ?? {}) },
          contentType: command.input.ContentType,
        });
        return { ETag: "put-etag" };
      }
      throw new Error(`unsupported fake S3 command: ${String(command)}`);
    },
  );

  client(): S3Client {
    return { send: this.send } as unknown as S3Client;
  }
}

async function fixture(size = 6 * 1024 * 1024): Promise<{
  directory: string;
  file: string;
  statePath: string;
  bytes: Buffer;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-s3-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "pgdumpster-test.tar.zst.age");
  const statePath = path.join(directory, "upload-state.json");
  const bytes = Buffer.alloc(size, 0x5a);
  await writeFile(file, bytes);
  return { directory, file, statePath, bytes };
}

const config: S3DestinationConfig = {
  bucket: "pgdumpster-test",
  prefix: "production/backups",
  region: "eu-west-1",
  partSizeMiB: 5,
  maxConcurrency: 1,
};

const runId = "11111111-1111-4111-8111-111111111111";
const fixedNow = () => new Date("2026-08-15T02:30:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S3-compatible destination", () => {
  it("publishes with multipart upload, reads bytes back, and writes COMPLETE last", async () => {
    const { file, statePath, bytes } = await fixture();
    const service = new FakeS3Service();

    const result = await publishS3Backup(file, config, {
      runId,
      statePath,
      client: service.client(),
      now: fixedNow,
    });

    expect(result.locator).toBe(
      `s3://pgdumpster-test/production/backups/${runId}/`,
    );
    expect(result.objectUri).toMatch(/\.tar\.zst\.age$/u);
    expect(result.recovered).toBe(false);
    expect(result.size).toBe(bytes.length);
    expect(result.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(
      service.send.mock.calls.filter(
        ([command]) => command instanceof UploadPartCommand,
      ),
    ).toHaveLength(2);
    const commandNames = service.send.mock.calls.map(
      ([command]) => (command as object).constructor.name,
    );
    expect(commandNames.at(-2)).toBe("PutObjectCommand");
    expect(commandNames.at(-1)).toBe("GetObjectCommand");
    await expect(access(statePath)).rejects.toThrow();
    expect(
      [...service.objects.keys()].some((key) => key.endsWith("COMPLETE.json")),
    ).toBe(true);
  });

  it("resumes an interrupted multipart upload without re-uploading committed parts", async () => {
    const { file, statePath } = await fixture();
    const service = new FakeS3Service();
    service.failPartOnce = 2;

    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: service.client(),
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "S3_UPLOAD_PART_FAILED" });

    const saved = JSON.parse(await readFile(statePath, "utf8")) as {
      completedParts: { partNumber: number }[];
    };
    expect(saved.completedParts.map(({ partNumber }) => partNumber)).toEqual([
      1,
    ]);

    const result = await publishS3Backup(file, config, {
      runId,
      statePath,
      client: service.client(),
      now: fixedNow,
    });

    expect(result.recovered).toBe(false);
    const creates = service.send.mock.calls.filter(
      ([command]) => command instanceof CreateMultipartUploadCommand,
    );
    const uploadedNumbers = service.send.mock.calls
      .filter(([command]) => command instanceof UploadPartCommand)
      .map(([command]) => (command as UploadPartCommand).input.PartNumber);
    expect(creates).toHaveLength(1);
    expect(uploadedNumbers).toEqual([1, 2, 2]);
    await expect(access(statePath)).rejects.toThrow();
  });

  it("recovers a completed object when the process failed before writing COMPLETE", async () => {
    const { file, statePath } = await fixture(1024);
    const service = new FakeS3Service();
    service.failMarkerOnce = true;

    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: service.client(),
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "S3_MARKER_WRITE_FAILED" });

    const createsBefore = service.send.mock.calls.filter(
      ([command]) => command instanceof CreateMultipartUploadCommand,
    ).length;
    const result = await publishS3Backup(file, config, {
      runId,
      statePath,
      client: service.client(),
      now: fixedNow,
    });
    const createsAfter = service.send.mock.calls.filter(
      ([command]) => command instanceof CreateMultipartUploadCommand,
    ).length;

    expect(result.recovered).toBe(true);
    expect(createsAfter).toBe(createsBefore);
    await expect(access(statePath)).rejects.toThrow();
  });

  it("materializes a committed remote backup and rejects corrupted bytes", async () => {
    const { directory, file, statePath, bytes } = await fixture(2048);
    const service = new FakeS3Service();
    const published = await publishS3Backup(file, config, {
      runId,
      statePath,
      client: service.client(),
      now: fixedNow,
    });
    const output = path.join(directory, "download");

    const materialized = await materializeS3Backup(
      published.locator,
      output,
      config,
      { client: service.client() },
    );
    expect(await readFile(materialized)).toEqual(bytes);

    await rm(materialized);
    const objectKey = decodeURIComponent(
      new URL(published.objectUri).pathname.slice(1),
    );
    const object = service.objects.get(objectKey)!;
    object.body = Buffer.from("corrupt");

    await expect(
      materializeS3Backup(published.locator, output, config, {
        client: service.client(),
      }),
    ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
    await expect(access(materialized)).rejects.toThrow();
  });

  it("fails closed for out-of-scope locators and conflicting committed objects", async () => {
    const { file, statePath } = await fixture(1024);
    const service = new FakeS3Service();

    await expect(
      materializeS3Backup(
        `s3://other-bucket/production/backups/${runId}/`,
        path.dirname(file),
        config,
        { client: service.client() },
      ),
    ).rejects.toMatchObject({ code: "S3_LOCATOR_OUT_OF_SCOPE" });

    const objectKey = `production/backups/${runId}/${path.basename(file)}`;
    service.objects.set(objectKey, {
      body: Buffer.from("not this backup"),
      metadata: {
        "pgdumpster-sha256": "0".repeat(64),
        "pgdumpster-size": "15",
      },
    });
    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: service.client(),
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
  });
});
