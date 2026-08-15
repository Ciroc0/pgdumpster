import type { z } from "zod";

import { PgDumpsterError } from "../../core/errors/error.js";
import type { SecretValue } from "../../security/secret-value.js";

const API_ORIGIN = "https://api.supabase.com";

export interface ManagementClientOptions {
  accessToken: SecretValue;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  query?: Readonly<Record<string, string>> | undefined;
  accept?: string | undefined;
}

interface RequestExecutionOptions extends RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: string | undefined;
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const abortError = (): Error =>
    signal?.reason instanceof Error
      ? signal.reason
      : new Error("Operation aborted", { cause: signal?.reason });
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function requestScope(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (
    (segments[0] === "v1" || segments[0] === "v2") &&
    segments[1] === "projects" &&
    segments[2]
  ) {
    return `project:${segments[2]}`;
  }
  if (
    (segments[0] === "v1" || segments[0] === "v2") &&
    segments[1] === "organizations" &&
    segments[2]
  ) {
    return `organization:${segments[2]}`;
  }
  return "global";
}

function secondsHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || !/^\d+(?:\.\d+)?$/u.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function retryDelay(
  response: Response,
  attempt: number,
  random: () => number,
  maximum: number,
): number {
  const documentedReset = secondsHeader(response.headers, "x-ratelimit-reset");
  const retryAfter = secondsHeader(response.headers, "retry-after");
  const headerSeconds = retryAfter ?? documentedReset;
  if (headerSeconds !== undefined) {
    return Math.min(maximum, Math.ceil(headerSeconds * 1000));
  }
  const exponential = Math.min(maximum, 500 * 2 ** (attempt - 1));
  return Math.ceil(exponential * random());
}

function responseError(response: Response): PgDumpsterError {
  const details = {
    status: response.status,
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("sb-request-id") ??
      undefined,
  };
  if (response.status === 401 || response.status === 403) {
    return new PgDumpsterError({
      code: "AUTH_MANAGEMENT_API_FAILED",
      category: "auth",
      message:
        "Supabase Management API authentication or authorization failed.",
      retryable: false,
      details,
    });
  }
  if (response.status === 429) {
    return new PgDumpsterError({
      code: "PLATFORM_API_RATE_LIMITED",
      category: "rate_limit",
      message: "Supabase Management API rate limit was exhausted.",
      retryable: true,
      details,
    });
  }
  return new PgDumpsterError({
    code: "PLATFORM_FEATURE_UNAVAILABLE",
    category: "control_plane",
    message: `Supabase Management API returned HTTP ${response.status}.`,
    retryable: response.status >= 500,
    details,
  });
}

export class ManagementClient {
  readonly #token: SecretValue;
  readonly #fetch: typeof fetch;
  readonly #sleep: NonNullable<ManagementClientOptions["sleep"]>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #maxRetryDelayMs: number;
  readonly #notBefore = new Map<string, number>();

  constructor(options: ManagementClientOptions) {
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
  }

  async #requestResponse(
    pathname: string,
    options: RequestExecutionOptions,
  ): Promise<Response> {
    if (
      !/^\/v[12]\//u.test(pathname) ||
      pathname.includes("?") ||
      pathname.includes("#")
    ) {
      throw new Error(
        "Management API path must be an absolute /v1/ or /v2/ path",
      );
    }
    const requestUrl = new URL(pathname, API_ORIGIN);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      requestUrl.searchParams.set(name, value);
    }
    const scope = requestScope(pathname);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      const waitUntil = this.#notBefore.get(scope) ?? 0;
      const proactiveDelay = Math.max(0, waitUntil - this.#now());
      if (proactiveDelay > 0) {
        await this.#sleep(proactiveDelay, options.signal);
      }

      let response: Response;
      try {
        response = await this.#fetch(requestUrl.href, {
          method: options.method,
          headers: {
            accept: options.accept ?? "application/json",
            authorization: `Bearer ${this.#token.expose()}`,
            ...(options.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            "user-agent": "pgdumpster/0.0.0-development",
          },
          ...(options.body === undefined ? {} : { body: options.body }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        lastError = new PgDumpsterError({
          code: "PLATFORM_FEATURE_UNAVAILABLE",
          category: "network",
          message: "Supabase Management API request failed before a response.",
          retryable: true,
          cause: error,
        });
        if (attempt === this.#maxAttempts) throw lastError;
        await this.#sleep(
          Math.ceil(
            Math.min(this.#maxRetryDelayMs, 500 * 2 ** (attempt - 1)) *
              this.#random(),
          ),
          options.signal,
        );
        continue;
      }

      const remaining = secondsHeader(
        response.headers,
        "x-ratelimit-remaining",
      );
      const reset = secondsHeader(response.headers, "x-ratelimit-reset");
      if (remaining === 0 && reset !== undefined) {
        this.#notBefore.set(scope, this.#now() + reset * 1000);
      }
      if (!response.ok) {
        lastError = responseError(response);
        if (
          attempt === this.#maxAttempts ||
          (response.status !== 429 && response.status < 500)
        ) {
          throw lastError;
        }
        await this.#sleep(
          retryDelay(response, attempt, this.#random, this.#maxRetryDelayMs),
          options.signal,
        );
        continue;
      }

      return response;
    }
    throw lastError;
  }

  async getRaw(
    pathname: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.#requestResponse(pathname, { ...options, method: "GET" });
  }

  async #parseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new PgDumpsterError({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        category: "platform_contract",
        message: "Supabase Management API returned invalid JSON.",
        retryable: false,
        cause: error,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new PgDumpsterError({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        category: "platform_contract",
        message:
          "Supabase Management API response no longer matches the validated contract.",
        retryable: false,
        details: {
          issues: parsed.error.issues.map(({ code, path }) => ({ code, path })),
        },
      });
    }
    return parsed.data;
  }

  async get<T>(
    pathname: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.#requestResponse(pathname, {
      ...options,
      method: "GET",
    });
    return this.#parseJson(response, schema);
  }

  async put<TBody, TResponse>(
    pathname: string,
    body: TBody,
    bodySchema: z.ZodType<TBody>,
    responseSchema: z.ZodType<TResponse>,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const parsedBody = bodySchema.safeParse(body);
    if (!parsedBody.success) {
      throw new PgDumpsterError({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        category: "platform_contract",
        message:
          "Management API request no longer matches its validated contract.",
        retryable: false,
        details: {
          issues: parsedBody.error.issues.map(({ code, path }) => ({
            code,
            path,
          })),
        },
      });
    }
    const response = await this.#requestResponse(pathname, {
      ...options,
      method: "PUT",
      body: JSON.stringify(parsedBody.data),
    });
    return this.#parseJson(response, responseSchema);
  }

  async post<TBody, TResponse>(
    pathname: string,
    body: TBody,
    bodySchema: z.ZodType<TBody>,
    responseSchema: z.ZodType<TResponse>,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const parsedBody = bodySchema.safeParse(body);
    if (!parsedBody.success) {
      throw new PgDumpsterError({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        category: "platform_contract",
        message:
          "Management API request no longer matches its validated contract.",
        retryable: false,
        details: {
          issues: parsedBody.error.issues.map(({ code, path }) => ({
            code,
            path,
          })),
        },
      });
    }
    const response = await this.#requestResponse(pathname, {
      ...options,
      method: "POST",
      body: JSON.stringify(parsedBody.data),
    });
    return this.#parseJson(response, responseSchema);
  }

  async delete<TResponse>(
    pathname: string,
    responseSchema: z.ZodType<TResponse>,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const response = await this.#requestResponse(pathname, {
      ...options,
      method: "DELETE",
    });
    return this.#parseJson(response, responseSchema);
  }

  async patch<TBody>(
    pathname: string,
    body: TBody,
    bodySchema: z.ZodType<TBody>,
    options: RequestOptions = {},
  ): Promise<void> {
    const parsedBody = bodySchema.safeParse(body);
    if (!parsedBody.success) {
      throw new PgDumpsterError({
        code: "PLATFORM_API_CONTRACT_CHANGED",
        category: "platform_contract",
        message:
          "Management API request no longer matches its validated contract.",
        retryable: false,
        details: {
          issues: parsedBody.error.issues.map(({ code, path }) => ({
            code,
            path,
          })),
        },
      });
    }
    await this.#requestResponse(pathname, {
      ...options,
      method: "PATCH",
      body: JSON.stringify(parsedBody.data),
    });
  }
}
