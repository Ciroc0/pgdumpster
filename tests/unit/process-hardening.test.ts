import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSupabaseCommand, runProcess } from "../../src/utils/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function root(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));

  temporaryDirectories.push(directory);
  return directory;
}

async function executable(filename: string): Promise<void> {
  await writeFile(filename, "fixture\n");
  await chmod(filename, 0o700);
}

describe("process hardening", () => {
  it("forwards explicit cwd and environment", async () => {
    const directory = await root("pgdumpster-process-cwd-");

    const result = await runProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.env.PGDUMPSTER_TEST + '|' + process.cwd())",
      ],
      {
        cwd: directory,
        environment: {
          ...process.env,
          PGDUMPSTER_TEST: "environment-ok",
        },
      },
    );

    const separator = result.stdout.indexOf("|");

    expect(result.stdout.slice(0, separator)).toBe("environment-ok");

    expect(path.resolve(result.stdout.slice(separator + 1))).toBe(
      path.resolve(directory),
    );
  });

  it("honors an already-aborted subprocess signal", async () => {
    const controller = new AbortController();

    controller.abort(new Error("cancel subprocess"));

    await expect(
      runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  it("prefers Windows .exe over .com", async () => {
    const directory = await root("pgdumpster-process-exe-");

    const exe = path.join(directory, "supabase.exe");

    const com = path.join(directory, "supabase.com");

    await executable(exe);
    await executable(com);

    await expect(
      resolveSupabaseCommand(
        {
          PATH: directory,
        },
        "win32",
        directory,
      ),
    ).resolves.toEqual({
      command: exe,
      prefixArgs: [],
    });
  });

  it("falls back to Windows .com", async () => {
    const directory = await root("pgdumpster-process-com-");

    const com = path.join(directory, "supabase.com");

    await executable(com);

    await expect(
      resolveSupabaseCommand(
        {
          PATH: directory,
        },
        "win32",
        directory,
      ),
    ).resolves.toEqual({
      command: com,
      prefixArgs: [],
    });
  });

  it("rejects a cmd shim without a usable JS entrypoint", async () => {
    const directory = await root("pgdumpster-process-shim-");

    await executable(path.join(directory, "supabase.cmd"));

    await expect(
      resolveSupabaseCommand(
        {
          PATH: directory,
        },
        "win32",
        directory,
      ),
    ).rejects.toThrow("not found");
  });

  it("uses Path when uppercase PATH is absent", async () => {
    const directory = await root("pgdumpster-process-path-key-");

    const command = path.join(directory, "supabase");

    await executable(command);

    await expect(
      resolveSupabaseCommand(
        {
          Path: directory,
        },
        "linux",
        directory,
      ),
    ).resolves.toEqual({
      command,
      prefixArgs: [],
    });
  });

  it("ignores a project-local CLI path that is a directory", async () => {
    const workingDirectory = await root("pgdumpster-process-local-dir-");

    const bin = await root("pgdumpster-process-fallback-");

    const localEntrypoint = path.join(
      workingDirectory,
      "node_modules",
      "supabase",
      "dist",
      "supabase.js",
    );

    await mkdir(localEntrypoint, {
      recursive: true,
    });

    const command = path.join(bin, "supabase");

    await executable(command);

    await expect(
      resolveSupabaseCommand(
        {
          PATH: bin,
        },
        "linux",
        workingDirectory,
      ),
    ).resolves.toEqual({
      command,
      prefixArgs: [],
    });
  });
});
