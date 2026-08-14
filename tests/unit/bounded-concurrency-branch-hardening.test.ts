import { describe, expect, it } from "vitest";

import { mapBounded } from "../../src/utils/bounded-concurrency.js";

describe("bounded concurrency branch hardening", () => {
  it("rejects invalid concurrency values", async () => {
    for (const concurrency of [0, -1, 1.5]) {
      await expect(
        mapBounded([1], concurrency, (value) => Promise.resolve(value)),
      ).rejects.toThrow("Concurrency must be a positive integer");
    }
  });

  it("handles an empty work list", async () => {
    await expect(
      mapBounded([], 4, (value: number) => Promise.resolve(value)),
    ).resolves.toEqual([]);
  });

  it("preserves input ordering under concurrency", async () => {
    const result = await mapBounded([3, 2, 1], 3, async (value) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, value);
      });

      return value * 10;
    });

    expect(result).toEqual([30, 20, 10]);
  });

  it("honors a pre-aborted external signal", async () => {
    const controller = new AbortController();

    const reason = new Error("cancel bounded work");

    controller.abort(reason);

    await expect(
      mapBounded([1], 1, (value) => Promise.resolve(value), controller.signal),
    ).rejects.toBe(reason);
  });

  it("rethrows the first Error from a worker", async () => {
    const failure = new Error("worker failure");

    await expect(
      mapBounded([1, 2, 3], 2, (value) =>
        value === 1 ? Promise.reject(failure) : Promise.resolve(value),
      ),
    ).rejects.toBe(failure);
  });

  it("normalizes non-Error worker failures", async () => {
    await expect(
      mapBounded([1], 1, async () => {
        await Promise.resolve();

        // This deliberately exercises normalization of hostile/non-Error
        // rejection values crossing an external async boundary.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "non-error failure";
      }),
    ).rejects.toThrow("Bounded worker failed");
  });

  it("fails closed for sparse work arrays", async () => {
    const sparse = new Array<number>(1);

    await expect(
      mapBounded(sparse, 1, (value) => Promise.resolve(value)),
    ).rejects.toThrow("Bounded work item disappeared");
  });

  it("propagates an external abort into active workers", async () => {
    const controller = new AbortController();

    const reason = new Error("external abort");

    const promise = mapBounded(
      [1],
      1,
      (_value, _index, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("External abort", {
                      cause: signal.reason,
                    }),
              );
            },
            {
              once: true,
            },
          );
        }),
      controller.signal,
    );

    setTimeout(() => {
      controller.abort(reason);
    }, 0);

    await expect(promise).rejects.toBe(reason);
  });
});
