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
  createS3Client,
  materializeS3Backup,
  publishS3Backup,
  type S3DestinationConfig,
} from "../../src/destination/s3.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];
const runId = "22222222-2222-4222-8222-222222222222";
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

function fakeClient(
  handler: (command: unknown) => unknown | Promise<unknown>,
): {
  client: S3Client;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(handler);
  return { client: { send } as unknown as S3Client, send };
}

async function fixture(contents = "remote backup fixture"): Promise<{
  directory: string;
  file: string;
  bytes: Buffer;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-s3-hardening-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, "pgdumpster-test.tar.zst");
  const bytes = Buffer.from(contents);
  await writeFile(file, bytes);
  return { directory, file, bytes };
}

function marker(
  objectKey: string,
  bytes: Buffer,
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
    runId,
    objectKey,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    verifiedAt: "2026-08-15T03:15:00.000Z",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S3 destination hardening", () => {
  it("validates provider settings and explicit environment credentials", () => {
    expect(() => createS3Client({ bucket: "" }, {})).toThrowError(
      expect.objectContaining({ code: "S3_DESTINATION_INVALID" }),
    );
    expect(() =>
      createS3Client({ bucket: "backups", partSizeMiB: 4 }, {}),
    ).toThrowError(expect.objectContaining({ code: "S3_DESTINATION_INVALID" }));
    expect(() =>
      createS3Client({ bucket: "backups", maxConcurrency: 17 }, {}),
    ).toThrowError(expect.objectContaining({ code: "S3_DESTINATION_INVALID" }));
    expect(() =>
      createS3Client({ bucket: "backups", prefix: "../escape" }, {}),
    ).toThrowError(expect.objectContaining({ code: "S3_DESTINATION_INVALID" }));
    expect(() =>
      createS3Client({ bucket: "backups", prefix: "bad\\prefix" }, {}),
    ).toThrowError(expect.objectContaining({ code: "S3_DESTINATION_INVALID" }));
    expect(() =>
      createS3Client(
        { bucket: "backups" },
        { AWS_ACCESS_KEY_ID: "only-one-half" },
      ),
    ).toThrowError(expect.objectContaining({ code: "S3_CREDENTIALS_INVALID" }));

    const client = createS3Client(
      {
        bucket: "backups",
        endpoint: "https://s3.example.test",
        region: "test-1",
        forcePathStyle: true,
      },
      {
        AWS_ACCESS_KEY_ID: "access",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "session",
      },
    );
    expect(client).toBeInstanceOf(S3Client);
    client.destroy();
  });

  it("fails before any network operation for cancellation and invalid local input", async () => {
    const { directory } = await fixture();
    const { client, send } = fakeClient(() => Promise.resolve({}));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      publishS3Backup(path.join(directory, "missing.tar.zst"), config, {
        runId,
        client,
      }),
    ).rejects.toMatchObject({ code: "S3_LOCAL_INPUT_INVALID" });

    const empty = path.join(directory, "empty.tar.zst");
    await writeFile(empty, "");
    await expect(
      publishS3Backup(empty, config, { runId, client }),
    ).rejects.toMatchObject({ code: "S3_LOCAL_INPUT_INVALID" });

    await expect(
      publishS3Backup(empty, config, {
        runId,
        client,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects malformed, out-of-scope, and incomplete remote locators", async () => {
    const { directory } = await fixture();
    const { client } = fakeClient(() =>
      Promise.reject(awsError(404, "NoSuchKey")),
    );

    await expect(
      materializeS3Backup("https://example.test/not-s3", directory, config, {
        client,
      }),
    ).rejects.toMatchObject({ code: "S3_LOCATOR_INVALID" });
    await expect(
      materializeS3Backup("s3://backups/", directory, config, { client }),
    ).rejects.toMatchObject({ code: "S3_LOCATOR_INVALID" });
    await expect(
      materializeS3Backup(
        `s3://different/production/${runId}/`,
        directory,
        config,
        { client },
      ),
    ).rejects.toMatchObject({ code: "S3_LOCATOR_OUT_OF_SCOPE" });
    await expect(
      materializeS3Backup(`s3://backups/other/${runId}/`, directory, config, {
        client,
      }),
    ).rejects.toMatchObject({ code: "S3_LOCATOR_OUT_OF_SCOPE" });
    await expect(
      materializeS3Backup(
        `s3://backups/production/${runId}/`,
        directory,
        config,
        { client },
      ),
    ).rejects.toMatchObject({ code: "S3_BACKUP_INCOMPLETE" });
  });

  it("rejects oversized, malformed, and unsafe completion markers", async () => {
    const { directory, bytes } = await fixture();
    const locator = `s3://backups/production/${runId}/`;
    const responses = [
      Buffer.alloc(65_537, 0x20),
      Buffer.from("not-json"),
      Buffer.from(
        canonicalJson(marker(`production/${runId}/nested/file.tar.zst`, bytes)),
      ),
      Buffer.from(canonicalJson(marker(`production/${runId}/file.zip`, bytes))),
    ];

    for (const response of responses) {
      const { client } = fakeClient(() =>
        Promise.resolve({ Body: Readable.from([response]) }),
      );
      await expect(
        materializeS3Backup(locator, directory, config, { client }),
      ).rejects.toMatchObject({
        category: "destination",
      });
    }
  });

  it("refuses to overwrite an existing local materialization", async () => {
    const { directory, bytes } = await fixture();
    const objectKey = `production/${runId}/pgdumpster-remote.tar.zst`;
    const complete = marker(objectKey, bytes);
    const target = path.join(directory, "pgdumpster-remote.tar.zst");
    await writeFile(target, "existing local backup");
    let requests = 0;
    const { client } = fakeClient((command) => {
      requests += 1;
      if (command instanceof GetObjectCommand && requests === 1) {
        return { Body: Readable.from([Buffer.from(canonicalJson(complete))]) };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([bytes]) };
      }
      throw new Error("unexpected command");
    });

    await expect(
      materializeS3Backup(
        `s3://backups/production/${runId}/`,
        directory,
        config,
        { client },
      ),
    ).rejects.toMatchObject({ code: "S3_DOWNLOAD_OUTPUT_EXISTS" });
    expect(await readFile(target, "utf8")).toBe("existing local backup");
  });

  it("fails closed when multipart creation or a part response lacks required identity", async () => {
    const { file } = await fixture();
    const markerMiss = () => Promise.reject(awsError(404, "NoSuchKey"));

    {
      const { client } = fakeClient((command) => {
        if (command instanceof GetObjectCommand) return markerMiss();
        if (command instanceof HeadObjectCommand)
          throw awsError(404, "NotFound");
        if (command instanceof CreateMultipartUploadCommand) return {};
        throw new Error("unexpected command");
      });
      await expect(
        publishS3Backup(file, config, { runId, client }),
      ).rejects.toMatchObject({ code: "S3_RESPONSE_INVALID" });
    }

    {
      const { client } = fakeClient((command) => {
        if (command instanceof GetObjectCommand) return markerMiss();
        if (command instanceof HeadObjectCommand)
          throw awsError(404, "NotFound");
        if (command instanceof CreateMultipartUploadCommand)
          return { UploadId: "upload-1" };
        if (command instanceof UploadPartCommand) return {};
        throw new Error("unexpected command");
      });
      await expect(
        publishS3Backup(file, config, { runId, client }),
      ).rejects.toMatchObject({ code: "S3_RESPONSE_INVALID" });
    }
  });

  it("uses conditional multipart completion and aborts on an overwrite conflict", async () => {
    const { file, directory } = await fixture();
    const statePath = path.join(directory, "upload-state.json");
    let aborts = 0;
    const { client, send } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) throw awsError(404, "NoSuchKey");
      if (command instanceof HeadObjectCommand) throw awsError(404, "NotFound");
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: "upload-conflict" };
      if (command instanceof UploadPartCommand) return { ETag: "part-etag" };
      if (command instanceof CompleteMultipartUploadCommand)
        throw awsError(412, "PreconditionFailed");
      if (command instanceof AbortMultipartUploadCommand) {
        aborts += 1;
        return {};
      }
      throw new Error("unexpected command");
    });

    await expect(
      publishS3Backup(file, config, { runId, statePath, client }),
    ).rejects.toMatchObject({ code: "S3_OBJECT_ALREADY_EXISTS" });
    const completion = send.mock.calls.find(
      ([command]) => command instanceof CompleteMultipartUploadCommand,
    )?.[0] as CompleteMultipartUploadCommand | undefined;
    expect(completion?.input.IfNoneMatch).toBe("*");
    expect(aborts).toBe(1);
    await expect(access(statePath)).resolves.toBeUndefined();
  });

  it("restarts a vanished multipart upload and preserves safe state", async () => {
    const { file, directory, bytes } = await fixture();
    const statePath = path.join(directory, "upload-state.json");
    let currentUpload = "upload-old";
    let completed = false;
    let markerBody: Buffer | undefined;
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(
      statePath,
      canonicalJson({
        schemaVersion: 1,
        bucket: "backups",
        objectKey: `production/${runId}/${path.basename(file)}`,
        markerKey: `production/${runId}/COMPLETE.json`,
        runId,
        localFile: path.resolve(file),
        size: bytes.length,
        sha256: digest,
        partSize: 5 * 1024 * 1024,
        uploadId: currentUpload,
        completedParts: [],
        createdAt: "2026-08-15T03:00:00.000Z",
      }),
    );

    const { client } = fakeClient((command) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key?.endsWith("COMPLETE.json")) {
          if (markerBody === undefined) throw awsError(404, "NoSuchKey");
          return { Body: Readable.from([markerBody]) };
        }
        return { Body: Readable.from([bytes]) };
      }
      if (command instanceof HeadObjectCommand) {
        if (!completed) throw awsError(404, "NotFound");
        return {
          ContentLength: bytes.length,
          Metadata: {
            "pgdumpster-sha256": digest,
            "pgdumpster-size": String(bytes.length),
          },
        };
      }
      if (command instanceof ListPartsCommand) {
        throw awsError(404, "NoSuchUpload");
      }
      if (command instanceof CreateMultipartUploadCommand) {
        currentUpload = "upload-new";
        return { UploadId: currentUpload };
      }
      if (command instanceof UploadPartCommand) return { ETag: "new-etag" };
      if (command instanceof CompleteMultipartUploadCommand) {
        completed = true;
        return {};
      }
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body;
        if (typeof body !== "string") {
          throw new Error("unexpected completion marker body");
        }
        markerBody = Buffer.from(body);
        return {};
      }
      if (command instanceof AbortMultipartUploadCommand) return {};
      throw new Error("unexpected command");
    });

    const result = await publishS3Backup(file, config, {
      runId,
      statePath,
      client,
    });
    expect(result.sha256).toBe(digest);
    expect(currentUpload).toBe("upload-new");
    await expect(access(statePath)).rejects.toThrow();
  });
});
