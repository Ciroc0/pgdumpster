import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function outputDirectory(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-storage-download-hardening-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function storageKey(): SecretValue {
  return new SecretValue("storage-secret", new Redactor());
}

describe("Storage object download hardening", () => {
  it("rejects an invalid project ref before issuing a request", async () => {
    const root = await outputDirectory();
    const request = vi.fn<typeof fetch>();

    await expect(
      downloadStorageObject(
        {
          bucket: "bucket",
          name: "object.txt",
        },
        {
          projectRef: "not-a-project-ref",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
        },
      ),
    ).rejects.toMatchObject({
      code: "PROJECT_REF_INVALID",
      category: "config",
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("rejects empty bucket, empty name, NUL names and explicit dot segments", async () => {
    const invalidSources = [
      {
        bucket: "",
        name: "object.txt",
      },
      {
        bucket: "bucket",
        name: "",
      },
      {
        bucket: "bucket",
        name: "object\0.txt",
      },
      {
        bucket: "bucket",
        name: "folder/./object.txt",
      },
      {
        bucket: "bucket",
        name: "../object.txt",
      },
    ];

    for (const source of invalidSources) {
      const root = await outputDirectory();
      const request = vi.fn<typeof fetch>();

      await expect(
        downloadStorageObject(source, {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
        }),
      ).rejects.toMatchObject({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        component: "storage.file_objects",
      });

      expect(request).not.toHaveBeenCalled();
    }
  });

  it("rejects output paths that are not real directories", async () => {
    const root = await outputDirectory();
    const filename = path.join(root, "not-a-directory");
    await writeFile(filename, "file");

    const request = vi.fn<typeof fetch>();

    await expect(
      downloadStorageObject(
        {
          bucket: "bucket",
          name: "object.txt",
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: filename,
          fetch: request,
        },
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_OBJECT_DOWNLOAD_FAILED",
      component: "storage.file_objects",
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("fails immediately for a non-retryable HTTP response", async () => {
    const root = await outputDirectory();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not found", {
        status: 404,
      }),
    );

    const sleep = vi.fn(() => Promise.resolve());

    await expect(
      downloadStorageObject(
        {
          bucket: "bucket",
          name: "missing.txt",
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
          sleep,
        },
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_OBJECT_DOWNLOAD_FAILED",
      retryable: false,
      details: {
        httpStatus: 404,
        attempt: 1,
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed when a successful response has no body", async () => {
    const root = await outputDirectory();

    const response = {
      ok: true,
      status: 200,
      body: null,
    } as Response;

    const request = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      downloadStorageObject(
        {
          bucket: "bucket",
          name: "bodyless.txt",
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
          maxAttempts: 1,
        },
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_OBJECT_DOWNLOAD_FAILED",
      details: {
        httpStatus: 200,
        attempt: 1,
      },
    });
  });

  it("retries a transport exception and preserves optional source metadata", async () => {
    const root = await outputDirectory();

    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
        }),
      );

    const sleep = vi.fn(() => Promise.resolve());

    const result = await downloadStorageObject(
      {
        bucket: "bucket",
        name: "object.txt",
        expectedBytes: 2,
        version: null,
        updatedAt: "2026-08-14T20:00:00Z",
      },
      {
        projectRef: "abcdefghijklmnopqrst",
        storageKey: storageKey(),
        outputDirectory: root,
        fetch: request,
        sleep,
        random: () => 0.5,
        maxAttempts: 2,
      },
    );

    expect(result).toMatchObject({
      bytes: 2,
      version: null,
      updatedAt: "2026-08-14T20:00:00Z",
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(125, undefined);
  });

  it("wraps a final transport exception with attempt details and cause", async () => {
    const root = await outputDirectory();

    const upstream = new Error("connection reset");

    const request = vi.fn<typeof fetch>().mockRejectedValue(upstream);

    await expect(
      downloadStorageObject(
        {
          bucket: "bucket",
          name: "object.txt",
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
          maxAttempts: 1,
        },
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_OBJECT_DOWNLOAD_FAILED",
      category: "storage",
      retryable: false,
      details: {
        attempt: 1,
      },
      cause: upstream,
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("passes an AbortSignal to fetch and stops after cancellation", async () => {
    const root = await outputDirectory();
    const controller = new AbortController();

    const request = vi.fn<typeof fetch>((_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(new Error("cancelled during request"));
      return Promise.reject(new Error("transport cancelled"));
    });

    await expect(
      downloadStorageObject(
        {
          bucket: "bucket",
          name: "object.txt",
        },
        {
          projectRef: "abcdefghijklmnopqrst",
          storageKey: storageKey(),
          outputDirectory: root,
          fetch: request,
          signal: controller.signal,
          maxAttempts: 5,
        },
      ),
    ).rejects.toThrow("cancelled during request");

    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels the default retry sleep when the signal is aborted", async () => {
    const root = await outputDirectory();
    const controller = new AbortController();

    const request = vi.fn<typeof fetch>(() => {
      setTimeout(() => {
        controller.abort(new Error("cancel retry sleep"));
      }, 0);

      return Promise.resolve(
        new Response("retry", {
          status: 503,
        }),
      );
    });

    const pending = downloadStorageObject(
      {
        bucket: "bucket",
        name: "object.txt",
      },
      {
        projectRef: "abcdefghijklmnopqrst",
        storageKey: storageKey(),
        outputDirectory: root,
        fetch: request,
        signal: controller.signal,
        random: () => 1,
        maxAttempts: 2,
      },
    );

    await expect(pending).rejects.toThrow("cancel retry sleep");

    expect(request).toHaveBeenCalledOnce();
  });
  it("accepts a normal nested object name and encodes each REST path segment", async () => {
    const root = await outputDirectory();

    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x", {
        status: 200,
      }),
    );

    await downloadStorageObject(
      {
        bucket: "bucket with spaces",
        name: "folder one/file #1.txt",
        expectedBytes: 1,
      },
      {
        projectRef: "abcdefghijklmnopqrst",
        storageKey: storageKey(),
        outputDirectory: root,
        fetch: request,
      },
    );

    const requested = request.mock.calls[0]![0];
    const url =
      typeof requested === "string"
        ? requested
        : requested instanceof URL
          ? requested.href
          : requested.url;

    expect(url).toContain(
      "/bucket%20with%20spaces/folder%20one/file%20%231.txt",
    );
  });
});
