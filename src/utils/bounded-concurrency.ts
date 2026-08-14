export type BoundedWorker<T, R> = (
  item: T,
  index: number,
  signal: AbortSignal,
) => Promise<R>;

export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: BoundedWorker<T, R>,
  externalSignal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: Error | undefined;

  const runner = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) throw new Error("Bounded work item disappeared");
      try {
        results[index] = await worker(item, index, controller.signal);
      } catch (error) {
        const normalized =
          error instanceof Error
            ? error
            : new Error("Bounded worker failed", { cause: error });
        firstError ??= normalized;
        controller.abort(normalized);
      }
    }
  };

  try {
    const runnerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: runnerCount }, () => runner()));
    if (firstError !== undefined) throw firstError;
    externalSignal?.throwIfAborted();
    return results;
  } finally {
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
