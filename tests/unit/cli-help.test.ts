import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/main.js";

function ioBuffers() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

describe("CLI command help", () => {
  it.each([
    ["doctor", "--help"],
    ["backup", "--help"],
    ["inspect", "--help"],
    ["coverage", "--help"],
    ["verify", "--help"],
    ["restore", "--help"],
  ])("returns help before loading configuration for %s", async (...argv) => {
    const { stdout, stderr, io } = ioBuffers();

    const exitCode = await runCli(argv, io);

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("pgDumpster");
    expect(stderr).toEqual([]);
  });
});
