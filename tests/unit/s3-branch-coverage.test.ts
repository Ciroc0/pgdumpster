import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createS3Client,
  materializeS3Backup,
  publishS3Backup,
  type S3DestinationConfig,
} from "../../src/destination/s3.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];
const runId = "33333333-3333-4333-8333-333333333333";
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

function fakeClient(handler: (command: unknown) => unknown): {
  client: S3Client;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(handler);
  return { client: { send } as unknown as S3Client, send };
}

async function fixture(contents = "s3 branch coverage fixture"): Promise<{
  directory: string;
  file: string;
  bytes: Buffer;
  digest: string;
  objectKey: string;
  markerKey: string;
  statePath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-s3-branches-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "pgdumpster-test.tar.zst");
  const bytes = Buffer.from(contents);
  await writeFile(file, bytes);
  return {
    directory,
    file,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    objectKey: `production/${runId}/${path.basename(file)}`,
    markerKey: `production/${runId}/COMPLETE.json`,
    statePath: path.join(directory, "upload-state.json"),
  };
}

function marker(
  objectKey: string,
  bytes: Buffer,
  overrides: Partial<{
    runId: string;
    objectKey: string;
    size: number;
    sha256: string;
  }> = {},
): {
  schemaVersion: 1;
  type: "pgdumpster.s3.complete";
  runId: string;
  objectKey: string;
  size: number;
  sha256: string;
  verifiedAt: string;
} {
  return {
    schemaVersion: 1,
    type: "pgdumpster.s3.complete",
    runId: overrides.runId ?? runId,
    objectKey: overrides.objectKey ?? objectKey,
    size: overrides.size ?? bytes.length,
    sha256:
      overrides.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
    verifiedAt: "2026-08-15T05:00:00.000Z",
  };
}

function uploadState(
  file: string,
  bytes: Buffer,
  objectKey: string,
  markerKey: string,
  overrides: Partial<{
    bucket: string;
    objectKey: string;
    markerKey: string;
    runId: string;
    localFile: string;
    size: number;
    sha256: string;
    completedParts: { partNumber: number; etag: string; size: number }[];
  }> = {},
): string {
  return canonicalJson({
    schemaVersion: 1,
    bucket: overrides.bucket ?? config.bucket,
    objectKey: overrides.objectKey ?? objectKey,
    markerKey: overrides.markerKey ?? markerKey,
    runId: overrides.runId ?? runId,
    localFile: overrides.localFile ?? path.resolve(file),
    size: overrides.size ?? bytes.length,
    sha256:
      overrides.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
    partSize: 5 * 1024 * 1024,
    uploadId: "upload-existing",
    completedParts: overrides.completedParts ?? [],
    createdAt: "2026-08-15T05:00:00.000Z",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S3 destination branch coverage", () => {
  it("uses default provider settings and credential variants", async () => {
    const explicit = createS3Client(
      { bucket: "backups" },
      {
        AWS_DEFAULT_REGION: "eu-test-2",
        AWS_ACCESS_KEY_ID: "access",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    );
    expect(await explicit.config.region()).toBe("eu-test-2");
    explicit.destroy();

    const fallback = createS3Client({ bucket: "backups" }, {});
    expect(await fallback.config.region()).toBe("us-east-1");
    fallback.destroy();
  });

  it("rejects unsafe run IDs and non-404 marker read failures", async () => {
    const { file } = await fixture();
    const noNetwork = fakeClient(() => {
      throw new Error("network should not be reached");
    });
    await expect(
      publishS3Backup(file, config, {
        runId: "../unsafe",
        client: noNetwork.client,
      }),
    ).rejects.toMatchObject({ code: "S3_DESTINATION_INVALID" });
    expect(noNetwork.send).not.toHaveBeenCalled();

    const failingMarker = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        throw awsError(503, "ServiceUnavailable");
      }
      throw new Error("unexpected command");
    });
    await expect(
      publishS3Backup(file, config, { runId, client: failingMarker.client }),
    ).rejects.toMatchObject({ code: "S3_MARKER_READ_FAILED" });
  });

  it("fails closed for non-streamable and invalid marker body chunks", async () => {
    const { directory } = await fixture();
    const locator = `s3://backups/production/${runId}/`;

    const missingBody = fakeClient((command) => {
      if (command instanceof GetObjectCommand) return {};
      throw new Error("unexpected command");
    });
    await expect(
      materializeS3Backup(locator, directory, config, {
        client: missingBody.client,
      }),
    ).rejects.toMatchObject({ code: "S3_RESPONSE_INVALID" });

    const invalidChunk = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([{ invalid: true }], { objectMode: true }) };
      }
      throw new Error("unexpected command");
    });
    await expect(
      materializeS3Backup(locator, directory, config, {
        client: invalidChunk.client,
      }),
    ).rejects.toMatchObject({ code: "S3_RESPONSE_INVALID" });
  });

  it("requires every completion-marker identity field to match", async () => {
    const { file, bytes, objectKey } = await fixture();
    const variants = [
      marker(objectKey, bytes, { runId: "different-run" }),
      marker(objectKey, bytes, { objectKey: `production/${runId}/other.tar.zst` }),
      marker(objectKey, bytes, { size: bytes.length + 1 }),
      marker(objectKey, bytes, { sha256: "0".repeat(64) }),
    ];

    for (const candidate of variants) {
      const { client } = fakeClient((command) => {
        if (command instanceof GetObjectCommand) {
          return { Body: Readable.from([Buffer.from(canonicalJson(candidate))]) };
        }
        throw new Error("remote object should not be inspected");
      });
      await expect(
        publishS3Backup(file, config, { runId, client }),
      ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
    }
  });

  it("requires every remote metadata identity field to match", async () => {
    const { file, bytes, digest, objectKey } = await fixture();
    const complete = marker(objectKey, bytes);
    const variants = [
      {
        ContentLength: bytes.length + 1,
        Metadata: {
          "pgdumpster-sha256": digest,
          "pgdumpster-size": String(bytes.length),
        },
      },
      {
        ContentLength: bytes.length,
        Metadata: {
          "pgdumpster-sha256": "0".repeat(64),
          "pgdumpster-size": String(bytes.length),
        },
      },
      {
        ContentLength: bytes.length,
        Metadata: {
          "pgdumpster-sha256": digest,
          "pgdumpster-size": String(bytes.length + 1),
        },
      },
    ];

    for (const metadata of variants) {
      const { client } = fakeClient((command) => {
        if (command instanceof GetObjectCommand) {
          return { Body: Readable.from([Buffer.from(canonicalJson(complete))]) };
        }
        if (command instanceof HeadObjectCommand) return metadata;
        throw new Error("backup bytes should not be read");
      });
      await expect(
        publishS3Backup(file, config, { runId, client }),
      ).rejects.toMatchObject({ code: "S3_REMOTE_INTEGRITY_FAILED" });
    }
  });

  it("accepts an existing matching marker after a conditional marker conflict", async () => {
    const { file, bytes, digest, objectKey } = await fixture();
    const complete = marker(objectKey, bytes);
    let markerReads = 0;
    const { client } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key?.endsWith("COMPLETE.json")) {
          markerReads += 1;
          if (markerReads === 1) throw awsError(404, "NoSuchKey");
          return { Body: Readable.from([Buffer.from(canonicalJson(complete))]) };
        }
        return { Body: Readable.from([bytes]) };
      }
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: bytes.length,
          Metadata: {
            "pgdumpster-sha256": digest,
            "pgdumpster-size": String(bytes.length),
          },
        };
      }
      if (command instanceof PutObjectCommand) {
        throw awsError(412, "PreconditionFailed");
      }
      throw new Error("unexpected command");
    });

    const result = await publishS3Backup(file, config, { runId, client });
    expect(result.recovered).toBe(true);
    expect(markerReads).toBe(2);
  });

  it("fails when a published completion marker is not observable", async () => {
    const { file, bytes, digest } = await fixture();
    const { client } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key?.endsWith("COMPLETE.json")) {
          throw awsError(404, "NoSuchKey");
        }
        return { Body: Readable.from([bytes]) };
      }
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: bytes.length,
          Metadata: {
            "pgdumpster-sha256": digest,
            "pgdumpster-size": String(bytes.length),
          },
        };
      }
      if (command instanceof PutObjectCommand) return {};
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, client }),
    ).rejects.toMatchObject({ code: "S3_MARKER_WRITE_FAILED" });
  });

  it("validates persisted upload state before resuming", async () => {
    const { directory, file, bytes, objectKey, markerKey, statePath } =
      await fixture();
    const missingRemote = fakeClient((command) => {
      if (command instanceof GetObjectCommand) throw awsError(404, "NoSuchKey");
      if (command instanceof HeadObjectCommand) throw awsError(404, "NotFound");
      throw new Error("unexpected command");
    });

    await mkdir(statePath);
    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: missingRemote.client,
      }),
    ).rejects.toMatchObject({ code: "S3_UPLOAD_STATE_INVALID" });
    await rm(statePath, { recursive: true });

    await writeFile(statePath, "not-json");
    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: missingRemote.client,
      }),
    ).rejects.toMatchObject({ code: "S3_UPLOAD_STATE_INVALID" });

    await writeFile(
      statePath,
      uploadState(file, bytes, objectKey, markerKey, { bucket: "other" }),
    );
    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: missingRemote.client,
      }),
    ).rejects.toMatchObject({ code: "S3_UPLOAD_STATE_MISMATCH" });
  });

  it("surfaces stale-upload abort and multipart-list failures", async () => {
    const { file, bytes, objectKey, markerKey, statePath } = await fixture();
    await writeFile(
      statePath,
      uploadState(file, bytes, objectKey, markerKey, {
        sha256: "0".repeat(64),
      }),
    );
    const abortFailure = fakeClient((command) => {
      if (command instanceof GetObjectCommand) throw awsError(404, "NoSuchKey");
      if (command instanceof HeadObjectCommand) throw awsError(404, "NotFound");
      if (command instanceof AbortMultipartUploadCommand) {
        throw awsError(503, "ServiceUnavailable");
      }
      throw new Error("unexpected command");
    });
    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: abortFailure.client,
      }),
    ).rejects.toMatchObject({ code: "S3_MULTIPART_ABORT_FAILED" });

    await writeFile(statePath, uploadState(file, bytes, objectKey, markerKey));
    const listFailure = fakeClient((command) => {
      if (command instanceof GetObjectCommand) throw awsError(404, "NoSuchKey");
      if (command instanceof HeadObjectCommand) throw awsError(404, "NotFound");
      if (command instanceof ListPartsCommand) {
        throw awsError(503, "ServiceUnavailable");
      }
      throw new Error("unexpected command");
    });
    await expect(
      publishS3Backup(file, config, {
        runId,
        statePath,
        client: listFailure.client,
      }),
    ).rejects.toMatchObject({ code: "S3_MULTIPART_LIST_FAILED" });
  });

  it("requires a pagination marker for truncated part listings", async () => {
    const { file, bytes, objectKey, markerKey, statePath } = await fixture();
    await writeFile(statePath, uploadState(file, bytes, objectKey, markerKey));
    const { client } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) throw awsError(404, "NoSuchKey");
      if (command instanceof HeadObjectCommand) throw awsError(404, "NotFound");
      if (command instanceof ListPartsCommand) {
        return { IsTruncated: true, Parts: [] };
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, statePath, client }),
    ).rejects.toMatchObject({ code: "S3_RESPONSE_INVALID" });
  });

  it("reconciles paginated completed parts without re-uploading them", async () => {
    const { file, bytes, digest, objectKey, markerKey, statePath } =
      await fixture();
    await writeFile(
      statePath,
      uploadState(file, bytes, objectKey, markerKey, {
        completedParts: [
          { partNumber: 1, etag: "etag-existing", size: bytes.length },
        ],
      }),
    );
    const complete = marker(objectKey, bytes);
    let markerReads = 0;
    let listReads = 0;
    const { client, send } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key?.endsWith("COMPLETE.json")) {
          markerReads += 1;
          if (markerReads === 1) throw awsError(404, "NoSuchKey");
          return { Body: Readable.from([Buffer.from(canonicalJson(complete))]) };
        }
        return { Body: Readable.from([bytes]) };
      }
      if (command instanceof HeadObjectCommand) {
        if (markerReads === 1 && listReads === 0) {
          throw awsError(404, "NotFound");
        }
        return {
          ContentLength: bytes.length,
          Metadata: {
            "pgdumpster-sha256": digest,
            "pgdumpster-size": String(bytes.length),
          },
        };
      }
      if (command instanceof ListPartsCommand) {
        listReads += 1;
        if (listReads === 1) {
          return {
            IsTruncated: true,
            NextPartNumberMarker: "1",
            Parts: [],
          };
        }
        expect(command.input.PartNumberMarker).toBe("1");
        return {
          IsTruncated: false,
          Parts: [
            {
              PartNumber: 1,
              ETag: "etag-existing",
              Size: bytes.length,
            },
          ],
        };
      }
      if (command instanceof CompleteMultipartUploadCommand) return {};
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof UploadPartCommand) {
        throw new Error("reconciled part should not be uploaded again");
      }
      throw new Error("unexpected command");
    });

    const result = await publishS3Backup(file, config, {
      runId,
      statePath,
      client,
    });
    expect(result.recovered).toBe(false);
    expect(listReads).toBe(2);
    expect(
      send.mock.calls.filter(([command]) => command instanceof UploadPartCommand),
    ).toHaveLength(0);
    await expect(access(statePath)).rejects.toThrow();
  });

  it("maps non-conflict multipart completion failures", async () => {
    const { file, statePath } = await fixture();
    const { client } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) throw awsError(404, "NoSuchKey");
      if (command instanceof HeadObjectCommand) throw awsError(404, "NotFound");
      if (command instanceof CreateMultipartUploadCommand) {
        return { UploadId: "upload-new" };
      }
      if (command instanceof UploadPartCommand) return { ETag: "etag-part" };
      if (command instanceof CompleteMultipartUploadCommand) {
        throw awsError(503, "ServiceUnavailable");
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, statePath, client }),
    ).rejects.toMatchObject({ code: "S3_MULTIPART_COMPLETE_FAILED" });
    await expect(readFile(statePath, "utf8")).resolves.toContain("etag-part");
  });

  it("accepts documented locator forms and maps download failures", async () => {
    const { directory, bytes, objectKey } = await fixture();
    const complete = marker(objectKey, bytes);
    const outputDirectory = path.join(directory, "downloads");

    for (const locator of [
      `s3://backups/production/${runId}/COMPLETE.json`,
      `s3://backups/production/${runId}`,
    ]) {
      const { client } = fakeClient((command) => {
        if (command instanceof GetObjectCommand) {
          if (command.input.Key?.endsWith("COMPLETE.json")) {
            return { Body: Readable.from([Buffer.from(canonicalJson(complete))]) };
          }
          return { Body: Readable.from([bytes]) };
        }
        throw new Error("unexpected command");
      });
      const local = await materializeS3Backup(
        locator,
        outputDirectory,
        config,
        { client },
      );
      expect(await readFile(local)).toEqual(bytes);
      await rm(local);
    }

    await expect(
      materializeS3Backup(
        "s3://backups/production/%E0%A4%A",
        outputDirectory,
        config,
        { client: fakeClient(() => ({})).client },
      ),
    ).rejects.toMatchObject({ code: "S3_LOCATOR_INVALID" });

    const downloadFailure = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key?.endsWith("COMPLETE.json")) {
          return { Body: Readable.from([Buffer.from(canonicalJson(complete))]) };
        }
        throw awsError(503, "ServiceUnavailable");
      }
      throw new Error("unexpected command");
    });
    await expect(
      materializeS3Backup(
        `s3://backups/production/${runId}/`,
        outputDirectory,
        config,
        { client: downloadFailure.client },
      ),
    ).rejects.toMatchObject({ code: "S3_DOWNLOAD_FAILED" });
  });
});
