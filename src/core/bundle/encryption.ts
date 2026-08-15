import { randomUUID } from "node:crypto";
import { chmod, lstat, link, open, rm } from "node:fs/promises";
import path from "node:path";

import { PgDumpsterError } from "../errors/error.js";
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from "../../utils/process.js";

const AGE_PROCESS_TIMEOUT_MS = 2_147_000_000;
const AGE_DIAGNOSTIC_LIMIT_BYTES = 65_536;

export type AgeProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

export interface AgeOperationOptions {
  signal?: AbortSignal | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  runProcess?: AgeProcessRunner | undefined;
}

function encryptionError(
  code: "ENCRYPTION_FAILED" | "DECRYPTION_FAILED",
  message: string,
  cause?: unknown,
  details?: Readonly<Record<string, unknown>>,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category: "encryption",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function dependencyError(cause: unknown): PgDumpsterError {
  return new PgDumpsterError({
    code: "DEPENDENCY_NOT_FOUND",
    category: "dependency",
    message: "age executable was not found or could not be started.",
    retryable: false,
    cause,
  });
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function assertRegularFile(
  filePath: string,
  code: "ENCRYPTION_FAILED" | "DECRYPTION_FAILED",
  description: string,
): Promise<void> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw encryptionError(
        code,
        `${description} must be a regular non-symlink file.`,
      );
    }
  } catch (error) {
    if (error instanceof PgDumpsterError) throw error;
    throw encryptionError(
      code,
      `${description} could not be inspected.`,
      error,
    );
  }
}

async function assertOutputParent(
  output: string,
  code: "ENCRYPTION_FAILED" | "DECRYPTION_FAILED",
): Promise<void> {
  try {
    const stat = await lstat(path.dirname(path.resolve(output)));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw encryptionError(
        code,
        "Encryption output parent must be a real directory.",
      );
    }
  } catch (error) {
    if (error instanceof PgDumpsterError) throw error;
    throw encryptionError(
      code,
      "Encryption output parent is unavailable.",
      error,
    );
  }
}

async function publishTemporary(
  temporary: string,
  output: string,
  code: "ENCRYPTION_FAILED" | "DECRYPTION_FAILED",
): Promise<void> {
  await assertRegularFile(temporary, code, "age output");
  await chmod(temporary, 0o600);
  // Windows requires a writable file descriptor for fsync/FileHandle.sync().
  // The file is already complete at this point, so r+ is used only to make the
  // durability flush portable; no bytes are modified through this handle.
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await link(temporary, output);
  await rm(temporary);
}

async function runAge(
  args: readonly string[],
  operation: "encrypt" | "decrypt",
  options: AgeOperationOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const runner = options.runProcess ?? runProcess;
  let result: ProcessResult;
  try {
    result = await runner("age", args, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
      timeoutMs: AGE_PROCESS_TIMEOUT_MS,
      maxOutputBytes: AGE_DIAGNOSTIC_LIMIT_BYTES,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isMissingExecutable(error)) throw dependencyError(error);
    throw encryptionError(
      operation === "encrypt" ? "ENCRYPTION_FAILED" : "DECRYPTION_FAILED",
      operation === "encrypt"
        ? "age encryption process failed to start or complete."
        : "age decryption process failed to start or complete.",
      error,
    );
  }
  options.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw encryptionError(
      operation === "encrypt" ? "ENCRYPTION_FAILED" : "DECRYPTION_FAILED",
      operation === "encrypt"
        ? "age encryption failed."
        : "age decryption failed.",
      undefined,
      { exitCode: result.exitCode },
    );
  }
}

export async function encryptArchiveWithAge(
  archive: string,
  output: string,
  recipient: string,
  options: AgeOperationOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!archive.endsWith(".tar.zst") || !output.endsWith(".tar.zst.age")) {
    throw encryptionError(
      "ENCRYPTION_FAILED",
      "age encryption requires .tar.zst input and .tar.zst.age output.",
    );
  }
  if (!recipient.startsWith("age1") || recipient.length < 20) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message: "age recipient is invalid.",
      retryable: false,
    });
  }
  await assertRegularFile(archive, "ENCRYPTION_FAILED", "Archive input");
  await assertOutputParent(output, "ENCRYPTION_FAILED");
  const temporary = path.join(
    path.dirname(path.resolve(output)),
    `.${path.basename(output)}.partial-${randomUUID()}`,
  );
  try {
    await runAge(
      ["--encrypt", "--recipient", recipient, "--output", temporary, archive],
      "encrypt",
      options,
    );
    await publishTemporary(temporary, output, "ENCRYPTION_FAILED");
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function decryptArchiveWithAge(
  encrypted: string,
  output: string,
  identityFile: string,
  options: AgeOperationOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!encrypted.endsWith(".tar.zst.age") || !output.endsWith(".tar.zst")) {
    throw encryptionError(
      "DECRYPTION_FAILED",
      "age decryption requires .tar.zst.age input and .tar.zst output.",
    );
  }
  await assertRegularFile(encrypted, "DECRYPTION_FAILED", "Encrypted input");
  await assertRegularFile(
    identityFile,
    "DECRYPTION_FAILED",
    "age identity file",
  );
  await assertOutputParent(output, "DECRYPTION_FAILED");
  const temporary = path.join(
    path.dirname(path.resolve(output)),
    `.${path.basename(output)}.partial-${randomUUID()}`,
  );
  try {
    await runAge(
      [
        "--decrypt",
        "--identity",
        identityFile,
        "--output",
        temporary,
        encrypted,
      ],
      "decrypt",
      options,
    );
    await publishTemporary(temporary, output, "DECRYPTION_FAILED");
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
