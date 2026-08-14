import { describe, expect, it } from "vitest";

import { mapBounded } from "../../src/utils/bounded-concurrency.js";

describe("bounded concurrency", () => {
  it("never exceeds the requested concurrency and preserves result order", async () => {
    let active = 0;
    let maximum = 0;
    const results = await mapBounded([5, 4, 3, 2, 1], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBe(2);
    expect(results).toEqual([10, 8, 6, 4, 2]);
  });

  it("aborts sibling work and does not start the entire tail after failure", async () => {
    const started: number[] = [];
    await expect(
      mapBounded([0, 1, 2, 3, 4, 5], 2, async (value, index, signal) => {
        void index;
        started.push(value);
        if (value === 1) throw new Error("worker failed");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 20);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
        return value;
      }),
    ).rejects.toThrow("worker failed");
    expect(started).toEqual([0, 1]);
  });

  it("rejects invalid concurrency and a pre-aborted operation", async () => {
    await expect(
      mapBounded([1], 0, (value) => Promise.resolve(value)),
    ).rejects.toThrow(/positive integer/u);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      mapBounded([1], 1, (value) => Promise.resolve(value), controller.signal),
    ).rejects.toThrow("cancelled");
  });
});
