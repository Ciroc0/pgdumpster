import { describe, expect, it, vi } from "vitest";

import { runConsistentCopy } from "../../src/core/backup/consistency.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

function driftError(): PgDumpsterError {
  return new PgDumpsterError({
    code: "BACKUP_SOURCE_DRIFT_DETECTED",
    category: "consistency",
    message: "source drift",
    retryable: true,
  });
}

describe("backup consistency hardening", () => {
  it("surfaces completed-copy cleanup failure instead of retrying", async () => {
    let revision = 0;
    const cleanupFailure = new Error("completed cleanup failed");

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 1,
        snapshot: () => Promise.resolve({ revision: ++revision }),
        copy: () => Promise.resolve({ artifact: "payload.bin" }),
        cleanup: () => Promise.reject(cleanupFailure),
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_PARTIAL_CLEANUP_FAILED",
      category: "consistency",
      cause: cleanupFailure,
    });
  });

  it("rethrows an ordinary copy failure even when partial cleanup is unavailable", async () => {
    const failure = new Error("ordinary copy failure");

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 1,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => Promise.reject(failure),
        cleanup: () => Promise.resolve(),
        isDriftError: () => false,
      }),
    ).rejects.toBe(failure);
  });

  it("cleans a completed copy without reusing an already-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel after copy");
    const cleanup = vi.fn(
      (_result: { artifact: string }, signal?: AbortSignal) => {
        expect(signal).toBeUndefined();
        return Promise.resolve();
      },
    );

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 1,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => {
          controller.abort(reason);
          return Promise.resolve({ artifact: "payload.bin" });
        },
        cleanup,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans partial output without reusing an aborted signal after copy failure", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel during copy");
    const cleanupPartial = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBeUndefined();
      return Promise.resolve();
    });

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 1,
        snapshot: () => Promise.resolve({ revision: 1 }),
        copy: () => {
          controller.abort(reason);
          return Promise.reject(driftError());
        },
        cleanup: () => Promise.resolve(),
        cleanupPartial,
        isDriftError: (error) =>
          error instanceof PgDumpsterError &&
          error.code === "BACKUP_SOURCE_DRIFT_DETECTED",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(cleanupPartial).toHaveBeenCalledOnce();
  });

  it("cleans a completed copy before rethrowing a non-drift post-snapshot failure", async () => {
    const failure = new Error("inventory unavailable");
    let snapshots = 0;
    const result = { artifact: "payload.bin" };
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 1,
        snapshot: () => {
          snapshots += 1;
          return snapshots === 1
            ? Promise.resolve({ revision: 1 })
            : Promise.reject(failure);
        },
        copy: () => Promise.resolve(result),
        cleanup,
        isDriftError: () => false,
      }),
    ).rejects.toBe(failure);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(result, undefined);
  });

  it("fails quiesced mode when the post-copy snapshot itself reports drift", async () => {
    const drift = driftError();
    let snapshots = 0;
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "quiesced",
        maxRetries: 3,
        snapshot: () => {
          snapshots += 1;
          return snapshots === 1
            ? Promise.resolve({ revision: 1 })
            : Promise.reject(drift);
        },
        copy: () => Promise.resolve({ artifact: "payload.bin" }),
        cleanup,
        cleanupPartial: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toMatchObject({
      code: "QUIESCED_SOURCE_CHANGED",
      category: "consistency",
      details: { attempt: 1 },
    });

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
