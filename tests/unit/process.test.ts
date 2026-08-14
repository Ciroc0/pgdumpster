import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSupabaseCommand, runProcess } from "../../src/utils/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("shell-free subprocess execution", () => {
  it("captures stdout, stderr and non-zero exit status", async () => {
    const result = await runProcess(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode=7",
    ]);
    expect(result).toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
  });

  it("enforces timeout and combined output bounds", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/u);
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('1234'); process.stderr.write('5678')"],
        { maxOutputBytes: 4 },
      ),
    ).rejects.toThrow(/output limit/u);
  });

  it("resolves POSIX executables and Windows npm shims without a shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-process-"));
    temporaryDirectories.push(root);
    const executable = path.join(root, "supabase");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o700);
    await expect(
      resolveSupabaseCommand({ PATH: root }, "linux", root),
    ).resolves.toEqual({ command: executable, prefixArgs: [] });

    await rm(executable);
    const shim = path.join(root, "supabase.cmd");
    const entrypoint = path.join(
      root,
      "node_modules",
      "supabase",
      "dist",
      "supabase.js",
    );
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(shim, "@echo off\n");
    await writeFile(entrypoint, "export {};\n");
    await expect(
      resolveSupabaseCommand({ PATH: root }, "win32", root),
    ).resolves.toEqual({ command: process.execPath, prefixArgs: [entrypoint] });
  });

  it("fails when no Supabase executable exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-no-cli-"));
    temporaryDirectories.push(root);
    await expect(
      resolveSupabaseCommand({ PATH: "" }, process.platform, root),
    ).rejects.toThrow(/not found/u);
  });

  it("resolves a project-local Windows npm or pnpm shim", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-local-bin-"));
    temporaryDirectories.push(root);
    const bin = path.join(root, "node_modules", ".bin");
    const entrypoint = path.join(
      root,
      "node_modules",
      "supabase",
      "dist",
      "supabase.js",
    );
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(path.join(bin, "supabase.cmd"), "@echo off\n");
    await writeFile(entrypoint, "export {};\n");
    await expect(
      resolveSupabaseCommand({ PATH: bin }, "win32", root),
    ).resolves.toEqual({ command: process.execPath, prefixArgs: [entrypoint] });
  });

  it("prefers a pinned project-local CLI over an older PATH installation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-pinned-cli-"));
    const globalBin = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-global-cli-"),
    );
    temporaryDirectories.push(root, globalBin);
    const localEntrypoint = path.join(
      root,
      "node_modules",
      "supabase",
      "dist",
      "supabase.js",
    );
    await mkdir(path.dirname(localEntrypoint), { recursive: true });
    await writeFile(localEntrypoint, "export {};\n");
    const globalExecutable = path.join(globalBin, "supabase.exe");
    await writeFile(globalExecutable, "global\n");
    await expect(
      resolveSupabaseCommand({ PATH: globalBin }, "win32", root),
    ).resolves.toEqual({
      command: process.execPath,
      prefixArgs: [localEntrypoint],
    });
  });
});
