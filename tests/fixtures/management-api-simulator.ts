export interface SimulatedManagementResponse {
  readonly body?: unknown;
  readonly delayMs?: number;
  readonly error?: Error;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

export interface SimulatedManagementRequest {
  readonly body?: string;
  readonly headers: Headers;
  readonly method: string;
  readonly url: URL;
}

export interface ManagementApiSimulator {
  readonly fetch: typeof fetch;
  readonly requests: readonly SimulatedManagementRequest[];
}

/**
 * Deterministic, in-process Management API transport simulator.
 *
 * Each route consumes its queued response steps in order. That models delayed
 * responses, connection resets, rate limiting, changing pagination, eventual
 * consistency and mutations between source snapshots without a live service.
 */
export function createManagementApiSimulator(options: {
  readonly routes: Readonly<
    Record<string, readonly SimulatedManagementResponse[]>
  >;
  readonly onDelay?: (milliseconds: number) => void;
}): ManagementApiSimulator {
  const queues = new Map(
    Object.entries(options.routes).map(([route, responses]) => [
      route,
      [...responses],
    ]),
  );
  const requests: SimulatedManagementRequest[] = [];

  const fetch: typeof globalThis.fetch = (input, init) => {
    try {
      const url = new URL(input instanceof Request ? input.url : input);
      const route = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
      const queue = queues.get(route);
      if (queue === undefined || queue.length === 0) {
        throw new Error(`No simulated Management API response for ${route}`);
      }

      const headers = new Headers(init?.headers);
      requests.push({
        url,
        headers,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });

      const step = queue.shift()!;
      if (step.delayMs !== undefined) options.onDelay?.(step.delayMs);
      if (step.error !== undefined) throw step.error;

      return Promise.resolve(
        new Response(
          step.body === undefined ? null : JSON.stringify(step.body),
          {
            status: step.status ?? 200,
            headers: {
              "content-type": "application/json",
              ...(step.headers ?? {}),
            },
          },
        ),
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Simulated Management API request failed", {
              cause: error,
            }),
      );
    }
  };

  return { fetch, requests };
}
