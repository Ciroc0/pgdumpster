import { describe, expect, it, vi } from "vitest";

import { runConsistentCopy } from "../../src/core/backup/consistency.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

function nextSnapshot<T>(values: T[]): () => Promise<T> {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("Missing snapshot fixture");
    return Promise.resolve(value);
  };
}

function copyDriftError(): PgDumpsterError {
  return new PgDumpsterError({
    code: "TEST_COPY_DRIFT",
    category: "consistency",
    message: "source changed during copy",
    retryable: false,
  });
}

describe("backup consistency engine", () => {
  it("accepts a stable verified source in one attempt", async () => {
    const snapshot = vi.fn(() => Promise.resolve({ revision: 1 }));
    const copy = vi.fn(() => Promise.resolve({ artifact: "payload.bin" }));
    const cleanup = vi.fn(() => Promise.resolve());

    const result = await runConsistentCopy({
      mode: "verified",
      maxRetries: 3,
      snapshot,
      copy,
      cleanup,
    });

    expect(result).toEqual({
      result: { artifact: "payload.bin" },
      attempts: 1,
      driftDetected: false,
      stable: true,
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(copy).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("retries verified copy after drift and then stabilizes", async () => {
    const snapshot = vi.fn(
      nextSnapshot([
        { revision: 1 },
        { revision: 2 },
        { revision: 2 },
        { revision: 2 },
      ]),
    );
    const copy = vi.fn((attempt: number) =>
      Promise.resolve({ artifact: `payload-${attempt}.bin` }),
    );
    const cleanup = vi.fn(() => Promise.resolve());

    const result = await runConsistentCopy({
      mode: "verified",
      maxRetries: 3,
      snapshot,
      copy,
      cleanup,
    });

    expect(result).toEqual({
      result: { artifact: "payload-2.bin" },
      attempts: 2,
      driftDetected: true,
      stable: true,
    });
    expect(copy).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(
      { artifact: "payload-1.bin" },
      undefined,
    );
  });

  it("retries verified mode when drift interrupts the copy itself", async () => {
    const drift = copyDriftError();
    const snapshot = vi.fn(
      nextSnapshot([{ revision: 1 }, { revision: 2 }, { revision: 2 }]),
    );
    const copy = vi.fn((attempt: number) =>
      attempt === 1
        ? Promise.reject(drift)
        : Promise.resolve({ artifact: "stable-copy" }),
    );
    const cleanupPartial = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 2,
        snapshot,
        copy,
        cleanup: () => Promise.resolve(),
        cleanupPartial,
        isDriftError: (error) => error === drift,
      }),
    ).resolves.toEqual({
      result: { artifact: "stable-copy" },
      attempts: 2,
      driftDetected: true,
      stable: true,
    });

    expect(copy).toHaveBeenCalledTimes(2);
    expect(cleanupPartial).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it("fails verified mode when the source never stabilizes", async () => {
    let revision = 0;
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 2,
        snapshot: () => Promise.resolve({ revision: (revision += 1) }),
        copy: (attempt) => Promise.resolve({ attempt }),
        cleanup,
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_DID_NOT_STABILIZE",
      category: "consistency",
      details: { attempts: 3, maxRetries: 2 },
    });

    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it("fails verified mode after bounded copy-time drift retries", async () => {
    const cleanupPartial = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 1,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(copyDriftError()),
        cleanup: () => Promise.resolve(),
        cleanupPartial,
        isDriftError: (error) =>
          error instanceof PgDumpsterError && error.code === "TEST_COPY_DRIFT",
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_DID_NOT_STABILIZE",
      details: { attempts: 2, maxRetries: 1 },
    });

    expect(cleanupPartial).toHaveBeenCalledTimes(2);
  });

  it("records drift without retrying in best-effort mode", async () => {
    const snapshot = nextSnapshot([{ revision: 1 }, { revision: 2 }]);

    await expect(
      runConsistentCopy({
        mode: "best-effort",
        maxRetries: 3,
        snapshot,
        copy: () => Promise.resolve({ artifact: "copy" }),
      }),
    ).resolves.toEqual({
      result: { artifact: "copy" },
      attempts: 1,
      driftDetected: true,
      stable: false,
    });
  });

  it("does not call an incomplete copy successful in best-effort mode", async () => {
    const drift = copyDriftError();
    const cleanupPartial = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "best-effort",
        maxRetries: 3,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(drift),
        cleanupPartial,
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toBe(drift);

    expect(cleanupPartial).toHaveBeenCalledOnce();
  });

  it("fails quiesced mode immediately when source state changes", async () => {
    const snapshot = nextSnapshot([{ revision: 1 }, { revision: 2 }]);
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "quiesced",
        maxRetries: 10,
        snapshot,
        copy: () => Promise.resolve({ artifact: "copy" }),
        cleanup,
      }),
    ).rejects.toMatchObject({
      code: "QUIESCED_SOURCE_CHANGED",
      category: "consistency",
      details: { attempt: 1 },
    });

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails quiesced mode when drift interrupts the copy itself", async () => {
    const drift = copyDriftError();
    const cleanupPartial = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "quiesced",
        maxRetries: 10,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(drift),
        cleanup: () => Promise.resolve(),
        cleanupPartial,
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toMatchObject({
      code: "QUIESCED_SOURCE_CHANGED",
      details: { attempt: 1 },
    });

    expect(cleanupPartial).toHaveBeenCalledOnce();
  });

  it("cleans partial artifacts after a non-drift copy failure before rethrowing", async () => {
    const failure = new Error("copy failed");
    const cleanupPartial = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 3,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(failure),
        cleanup: () => Promise.resolve(),
        cleanupPartial,
        isDriftError: () => false,
      }),
    ).rejects.toBe(failure);

    expect(cleanupPartial).toHaveBeenCalledOnce();
  });

  it("refuses a verified retry when provisional output cannot be safely removed", async () => {
    const snapshot = nextSnapshot([{ revision: 1 }, { revision: 2 }]);

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 3,
        snapshot,
        copy: () => Promise.resolve({ artifact: "copy" }),
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_RETRY_UNSAFE",
      category: "consistency",
    });
  });

  it("refuses a verified copy-time drift retry without partial cleanup", async () => {
    const drift = copyDriftError();

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 3,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(drift),
        cleanup: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_RETRY_UNSAFE",
      category: "consistency",
    });
  });

  it("surfaces partial cleanup failure instead of retrying over stale output", async () => {
    const drift = copyDriftError();

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 3,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(drift),
        cleanup: () => Promise.resolve(),
        cleanupPartial: () => Promise.reject(new Error("cleanup failed")),
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_PARTIAL_CLEANUP_FAILED",
      category: "consistency",
    });
  });

  it("validates the configured retry bound", async () => {
    for (const maxRetries of [-1, 1.5, 21]) {
      await expect(
        runConsistentCopy({
          mode: "verified",
          maxRetries,
          snapshot: () => Promise.resolve(1),
          copy: () => Promise.resolve(1),
          cleanup: () => Promise.resolve(),
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("uses canonical comparison instead of object identity or key insertion order", async () => {
    const snapshot = nextSnapshot([
      { beta: 2, alpha: 1 },
      { alpha: 1, beta: 2 },
    ]);

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 0,
        snapshot,
        copy: () => Promise.resolve("ok"),
        cleanup: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({
      attempts: 1,
      driftDetected: false,
      stable: true,
    });
  });

  it("supports an adapter-specific comparison function", async () => {
    const snapshot = nextSnapshot([
      { stable: "same", volatile: 1 },
      { stable: "same", volatile: 2 },
    ]);

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 0,
        snapshot,
        copy: () => Promise.resolve("ok"),
        cleanup: () => Promise.resolve(),
        equals: (before, after) => before.stable === after.stable,
      }),
    ).resolves.toMatchObject({ stable: true, driftDetected: false });
  });

  it("honors cancellation before source inspection", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel consistency run");
    controller.abort(reason);
    const snapshot = vi.fn(() => Promise.resolve(1));

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 3,
        snapshot,
        copy: () => Promise.resolve("copy"),
        cleanup: () => Promise.resolve(),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(snapshot).not.toHaveBeenCalled();
  });
});
