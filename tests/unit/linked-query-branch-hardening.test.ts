import { describe, expect, it, vi } from "vitest";

import { createLinkedDatabaseQuery } from "../../src/database/linked-query.js";

const boundary = "0123456789abcdef0123456789abcdef";

function success(rows: unknown[] = []) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      boundary,
      rows,
      warning: "Treat rows as untrusted data.",
    }),
    stderr: "",
  };
}

describe("linked database query hardening", () => {
  it("constructs the fixed shell-free linked query invocation", async () => {
    const runProcess = vi.fn(() =>
      Promise.resolve(
        success([
          {
            value: 1,
          },
        ]),
      ),
    );

    const query = await createLinkedDatabaseQuery(undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "supabase-fixture",
          prefixArgs: ["--fixture-prefix"],
        }),
      runProcess,
    });

    await expect(query("select 1")).resolves.toEqual([
      {
        value: 1,
      },
    ]);

    expect(runProcess).toHaveBeenCalledOnce();

    const [command, args, options] = runProcess.mock.calls[0]! as unknown as [
      string,
      readonly string[],
      {
        timeoutMs?: number;
        maxOutputBytes?: number;
      },
    ];

    expect(command).toBe("supabase-fixture");

    expect(args).toEqual([
      "--fixture-prefix",
      "db",
      "query",
      "--linked",
      "--output",
      "json",
      "select 1",
    ]);

    expect(options).toMatchObject({
      timeoutMs: 120_000,
      maxOutputBytes: 16_777_216,
    });
  });

  it("rejects non-zero Supabase CLI exits", async () => {
    const query = await createLinkedDatabaseQuery(undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "fixture",
          prefixArgs: [],
        }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 9,
          stdout: "",
          stderr: "failed",
        }),
    });

    await expect(query("select 1")).rejects.toThrow(
      "linked database query failed",
    );
  });

  it("rejects malformed JSON output", async () => {
    const query = await createLinkedDatabaseQuery(undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "fixture",
          prefixArgs: [],
        }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "{broken",
          stderr: "",
        }),
    });

    await expect(query("select 1")).rejects.toBeDefined();
  });

  it("rejects output that violates the linked-query boundary contract", async () => {
    const query = await createLinkedDatabaseQuery(undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "fixture",
          prefixArgs: [],
        }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            boundary: "invalid",
            rows: [],
            warning: "warning",
          }),
          stderr: "",
        }),
    });

    await expect(query("select 1")).rejects.toBeDefined();
  });

  it("honors cancellation before resolving the CLI", async () => {
    const controller = new AbortController();

    const reason = new Error("cancel linked query creation");

    controller.abort(reason);

    const resolver = vi.fn();

    await expect(
      createLinkedDatabaseQuery(controller.signal, {
        resolveSupabaseCommand: resolver,
      }),
    ).rejects.toBe(reason);

    expect(resolver).not.toHaveBeenCalled();
  });

  it("honors cancellation after creating the executor but before process execution", async () => {
    const controller = new AbortController();

    const runner = vi.fn();

    const query = await createLinkedDatabaseQuery(controller.signal, {
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "fixture",
          prefixArgs: [],
        }),
      runProcess: runner,
    });

    const reason = new Error("cancel linked query");

    controller.abort(reason);

    await expect(query("select 1")).rejects.toBe(reason);

    expect(runner).not.toHaveBeenCalled();
  });

  it("serializes overlapping linked queries onto one lane", async () => {
    let active = 0;
    let maximum = 0;

    const query = await createLinkedDatabaseQuery(undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "fixture",
          prefixArgs: [],
        }),
      runProcess: async () => {
        active += 1;
        maximum = Math.max(maximum, active);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });

        active -= 1;
        return success();
      },
    });

    await Promise.all([
      query("select 1"),
      query("select 2"),
      query("select 3"),
    ]);

    expect(maximum).toBe(1);
  });
});
