import { describe, expect, it, vi } from "vitest";

import { runConsistentCopy } from "../../src/core/backup/consistency.js";
import { PgDumpsterError } from "../../src/core/errors/error.js";

function driftError(): PgDumpsterError {
  return new PgDumpsterError({
    code: "BACKUP_SOURCE_DRIFT_DETECTED",
    category: "consistency",
    message: "source changed during inventory",
    retryable: true,
  });
}

describe("backup consistency snapshot-time drift", () => {
  it("retries verified mode when the pre-copy snapshot itself observes drift", async () => {
    const drift = driftError();
    let snapshotCalls = 0;
    const snapshot = vi.fn(() => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return Promise.reject(drift);
      return Promise.resolve({ revision: 2 });
    });
    const copy = vi.fn((attempt: number) =>
      Promise.resolve({ artifact: `payload-${attempt}.bin` }),
    );
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 2,
        snapshot,
        copy,
        cleanup,
        cleanupPartial: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).resolves.toEqual({
      result: { artifact: "payload-2.bin" },
      attempts: 2,
      driftDetected: true,
      stable: true,
    });

    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(copy).toHaveBeenCalledOnce();
    expect(copy).toHaveBeenCalledWith(2, undefined);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans and retries verified mode when the post-copy snapshot observes drift", async () => {
    const drift = driftError();
    let snapshotCalls = 0;
    const snapshot = vi.fn(() => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) return Promise.reject(drift);
      return Promise.resolve({ revision: 1 });
    });
    const copy = vi.fn((attempt: number) =>
      Promise.resolve({ artifact: `payload-${attempt}.bin` }),
    );
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "verified",
        maxRetries: 2,
        snapshot,
        copy,
        cleanup,
        cleanupPartial: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).resolves.toEqual({
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

  it("records best-effort post-copy snapshot drift without discarding the completed copy", async () => {
    const drift = driftError();
    let snapshotCalls = 0;
    const snapshot = vi.fn(() => {
      snapshotCalls += 1;
      return snapshotCalls === 2
        ? Promise.reject(drift)
        : Promise.resolve({ revision: 1 });
    });
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      runConsistentCopy({
        mode: "best-effort",
        maxRetries: 2,
        snapshot,
        copy: () => Promise.resolve({ artifact: "payload.bin" }),
        cleanup,
        cleanupPartial: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).resolves.toEqual({
      result: { artifact: "payload.bin" },
      attempts: 1,
      driftDetected: true,
      stable: false,
    });

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("fails best-effort when no stable pre-copy inventory can be established", async () => {
    const drift = driftError();
    const copy = vi.fn(() => Promise.resolve({ artifact: "payload.bin" }));

    await expect(
      runConsistentCopy({
        mode: "best-effort",
        maxRetries: 2,
        snapshot: () => Promise.reject(drift),
        copy,
        cleanupPartial: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toBe(drift);

    expect(copy).not.toHaveBeenCalled();
  });

  it("fails quiesced mode when a source snapshot reports drift", async () => {
    const drift = driftError();

    await expect(
      runConsistentCopy({
        mode: "quiesced",
        maxRetries: 2,
        snapshot: () => Promise.reject(drift),
        copy: () => Promise.resolve({ artifact: "payload.bin" }),
        cleanup: () => Promise.resolve(),
        cleanupPartial: () => Promise.resolve(),
        isDriftError: (error) => error === drift,
      }),
    ).rejects.toMatchObject({
      code: "QUIESCED_SOURCE_CHANGED",
      category: "consistency",
      details: { attempt: 1 },
    });
  });
});