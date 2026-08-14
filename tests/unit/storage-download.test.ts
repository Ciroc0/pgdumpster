import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { downloadStorageObject } from "../../src/storage/download.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("File Storage object download", () => {
  it("streams adversarial keys into a content-addressed safe path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-storage-"));
    temporaryDirectories.push(root);
    const body = Buffer.from("exact object bytes\n");
    const storageKey = new SecretValue("storage-key-canary", new Redactor());
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const object = await downloadStorageObject(
      {
        bucket: "private bucket",
        name: "..name/CON/%2e%2e/Æ/ＦＯＯ.txt",
        expectedBytes: body.length,
        version: "v1",
      },
      {
        projectRef: "abcdefghijklmnopqrst",
        storageKey,
        outputDirectory: root,
        fetch: request,
      },
    );
    const expectedId = createHash("sha256")
      .update("private bucket\0..name/CON/%2e%2e/Æ/ＦＯＯ.txt")
      .digest("hex");
    expect(object).toMatchObject({
      contentId: expectedId,
      path: `storage/file-objects/${expectedId.slice(0, 2)}/${expectedId}`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    });
    expect(await readFile(path.join(root, ...object.path.split("/")))).toEqual(
      body,
    );
    const [requestedUrl, init] = request.mock.calls[0]!;
    expect(
      requestedUrl instanceof URL ? requestedUrl.href : requestedUrl,
    ).toContain(
      "/private%20bucket/..name/CON/%252e%252e/%C3%86/%EF%BC%A6%EF%BC%AF%EF%BC%AF.txt",
    );
    expect(JSON.stringify(init)).toContain("storage-key-canary");
  });

  it("retries retryable status without consuming or exposing its body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-storage-"));
    temporaryDirectories.push(root);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("secret upstream body", { status: 503 }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      downloadStorageObject(
        { bucket: "bucket", name: "object.txt", expectedBytes: 2 },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: new SecretValue("secret", new Redactor()),
          outputDirectory: root,
          fetch: request,
          sleep,
          random: () => 0,
        },
      ),
    ).resolves.toMatchObject({ bytes: 2 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails when metadata size and downloaded bytes drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-storage-"));
    temporaryDirectories.push(root);
    await expect(
      downloadStorageObject(
        { bucket: "bucket", name: "object", expectedBytes: 99 },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: new SecretValue("secret", new Redactor()),
          outputDirectory: root,
          fetch: () => Promise.resolve(new Response("short", { status: 200 })),
        },
      ),
    ).rejects.toMatchObject({ code: "STORAGE_OBJECT_CHANGED_DURING_COPY" });
  });

  it("fails closed for REST keys whose dot segments would be normalized", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-storage-"));
    temporaryDirectories.push(root);
    const request = vi.fn<typeof fetch>();
    await expect(
      downloadStorageObject(
        { bucket: "bucket", name: "folder/../object" },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: new SecretValue("secret", new Redactor()),
          outputDirectory: root,
          fetch: request,
        },
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_API_CONTRACT_CHANGED" });
    expect(request).not.toHaveBeenCalled();
  });
});
