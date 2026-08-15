import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  publishS3Backup,
  type S3DestinationConfig,
} from "../../src/destination/s3.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];
const runId = "44444444-4444-4444-8444-444444444444";
const config: S3DestinationConfig = {
  bucket: "backups",
  prefix: "production",
  partSizeMiB: 5,
  maxConcurrency: 1,
};

function awsError(status: number, name: string): Error {
  const error = new Error(name) as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}

function fakeClient(handler: (command: unknown) => unknown): S3Client {
  return { send: vi.fn(handler) } as unknown as S3Client;
}

async function fixture(): Promise<{
  file: string;
  bytes: Buffer;
  digest: string;
  objectKey: string;
  markerBody: Buffer;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-s3-margin-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "pgdumpster-test.tar.zst");
  const bytes = Buffer.from("coverage margin payload");
  await writeFile(file, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `production/${runId}/${path.basename(file)}`;
  const markerBody = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      type: "pgdumpster.s3.complete",
      runId,
      objectKey,
      size: bytes.length,
      sha256: digest,
      verifiedAt: "2026-08-15T05:20:00.000Z",
    }),
  );
  return { file, bytes, digest, objectKey, markerBody };
}

function matchingHead(bytes: Buffer, digest: string): {
  ContentLength: number;
  Metadata: Record<string, string>;
} {
  return {
    ContentLength: bytes.length,
    Metadata: {
      "pgdumpster-sha256": digest,
      "pgdumpster-size": String(bytes.length),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S3 coverage margin", () => {
  it("maps a non-not-found HeadObject failure", async () => {
    const { file } = await fixture();
    const client = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        throw awsError(404, "NoSuchKey");
      }
      if (command instanceof HeadObjectCommand) {
        throw awsError(503, "ServiceUnavailable");
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, client }),
    ).rejects.toMatchObject({ code: "S3_HEAD_FAILED" });
  });

  it("rejects a committed marker whose object disappeared", async () => {
    const { file, markerBody } = await fixture();
    const client = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([markerBody]) };
      }
      if (command instanceof HeadObjectCommand) {
        throw awsError(404, "NotFound");
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, client }),
    ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
  });

  it("rejects same-size remote bytes with a different SHA-256", async () => {
    const { file, bytes, digest, markerBody } = await fixture();
    let gets = 0;
    const corrupted = Buffer.alloc(bytes.length, 0x78);
    const client = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        gets += 1;
        return {
          Body: Readable.from([gets === 1 ? markerBody : corrupted]),
        };
      }
      if (command instanceof HeadObjectCommand) {
        return matchingHead(bytes, digest);
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, client }),
    ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
  });

  it("rejects remote bytes whose size differs from the marker", async () => {
    const { file, bytes, digest, markerBody } = await fixture();
    let gets = 0;
    const truncated = bytes.subarray(0, bytes.length - 1);
    const client = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        gets += 1;
        return {
          Body: Readable.from([gets === 1 ? markerBody : truncated]),
        };
      }
      if (command instanceof HeadObjectCommand) {
        return matchingHead(bytes, digest);
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, client }),
    ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
  });
});
