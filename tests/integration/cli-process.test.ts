import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function execute(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli/main.js"), ...args],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env["PATH"],
          SystemRoot: process.env["SystemRoot"],
        },
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe("built CLI process", () => {
  it("executes the ESM entrypoint and returns stable help", async () => {
    const result = await execute(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pgdumpster doctor");
    expect(result.stderr).toBe("");
  });

  it("returns JSON and exit 2 for missing doctor configuration", async () => {
    const result = await execute([
      "doctor",
      "--project-ref",
      "abcdefghijklmnopqrst",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "CONFIG_MISSING_REQUIRED",
      category: "config",
    });
    expect(result.stderr).not.toContain("undefined");
  });
});
