import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ResolvedCommand {
  command: string;
  prefixArgs: readonly string[];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function resolveSupabaseCommand(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  workingDirectory = process.cwd(),
): Promise<ResolvedCommand> {
  const localEntrypoint = path.join(
    workingDirectory,
    "node_modules",
    "supabase",
    "dist",
    "supabase.js",
  );
  if (await isReadableFile(localEntrypoint)) {
    return { command: process.execPath, prefixArgs: [localEntrypoint] };
  }
  const pathValue = environment["PATH"] ?? environment["Path"] ?? "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  if (platform !== "win32") {
    for (const directory of directories) {
      const candidate = path.join(directory, "supabase");
      if (await isExecutable(candidate)) {
        return { command: candidate, prefixArgs: [] };
      }
    }
  } else {
    for (const directory of directories) {
      for (const extension of [".exe", ".com"] as const) {
        const candidate = path.join(directory, `supabase${extension}`);
        if (await isExecutable(candidate)) {
          return { command: candidate, prefixArgs: [] };
        }
      }
      const shim = path.join(directory, "supabase.cmd");
      const npmEntrypoints = [
        // npm global bin directory: <prefix>/supabase.cmd with packages under
        // <prefix>/node_modules.
        path.join(directory, "node_modules", "supabase", "dist", "supabase.js"),
        // Project-local npm/pnpm bin directory: node_modules/.bin.
        path.resolve(directory, "..", "supabase", "dist", "supabase.js"),
      ];
      if (await isExecutable(shim)) {
        for (const npmEntrypoint of npmEntrypoints) {
          if (await isExecutable(npmEntrypoint)) {
            return { command: process.execPath, prefixArgs: [npmEntrypoint] };
          }
        }
      }
    }
  }
  throw new Error("Supabase CLI executable was not found on PATH");
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
      env: options.environment ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish(() => {
          reject(new Error("Subprocess output limit exceeded"));
        });
        return;
      }
      target.push(chunk);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(new Error(`Subprocess timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.once("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.once("close", (code) => {
      finish(() => {
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  });
}
