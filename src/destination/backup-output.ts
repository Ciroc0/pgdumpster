import { lstat, rm } from "node:fs/promises";

import type { PgDumpsterConfig } from "../config/file.js";
import { packBundle } from "../core/bundle/archive.js";
import { encryptArchiveWithAge } from "../core/bundle/encryption.js";
import { PgDumpsterError } from "../core/errors/error.js";
import {
  publishS3Backup,
  type S3PublicationResult,
} from "./s3.js";

export interface BackupOutputPublicationOptions {
  workspaceRoot: string;
  checkpointPath: string;
  runId: string;
  destination: PgDumpsterConfig["destination"];
  encryption: PgDumpsterConfig["encryption"];
  archiveRequested: boolean;
  resume: boolean;
  environment?: NodeJS.ProcessEnv | undefined;
  archivePacker?: typeof packBundle | undefined;
  ageEncryptor?: typeof encryptArchiveWithAge | undefined;
  s3Publisher?: typeof publishS3Backup | undefined;
}

export interface BackupOutputPublicationResult {
  output: string;
  remote?: S3PublicationResult | undefined;
}

function publicationError(
  code: string,
  category: "destination" | "encryption",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PgDumpsterError {
  return new PgDumpsterError({
    code,
    category,
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
}

function fsCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (fsCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function cleanupStrict(
  paths: readonly { path: string; recursive?: boolean }[],
  error: PgDumpsterError,
): Promise<void> {
  const results = await Promise.allSettled(
    paths.map(({ path, recursive }) =>
      rm(path, {
        force: true,
        ...(recursive === true ? { recursive: true } : {}),
      }),
    ),
  );
  if (results.some(({ status }) => status === "rejected")) throw error;
}

export async function publishBackupOutput(
  options: BackupOutputPublicationOptions,
): Promise<BackupOutputPublicationResult> {
  const remote = options.destination.type === "s3";
  const encrypted = options.encryption.mode === "age";
  const archiveRequired = remote || encrypted || options.archiveRequested;
  const archivePath = `${options.workspaceRoot}.tar.zst`;
  const encryptedPath = `${archivePath}.age`;
  const transportPath = encrypted ? encryptedPath : archivePath;
  const statePath = `${options.workspaceRoot}.s3-upload.json`;

  if (!archiveRequired) {
    await rm(options.checkpointPath, { force: true });
    return { output: options.workspaceRoot };
  }

  const reuseRemoteTransport =
    remote && options.resume && (await regularFileExists(transportPath));
  if (!reuseRemoteTransport) {
    if (remote && options.resume) {
      await rm(archivePath, { force: true });
      await rm(encryptedPath, { force: true });
    }
    try {
      await (options.archivePacker ?? packBundle)(
        options.workspaceRoot,
        archivePath,
      );
      if (encrypted) {
        if (options.encryption.recipient === undefined) {
          throw publicationError(
            "CONFIG_MISSING_REQUIRED",
            "encryption",
            "age backup encryption requires encryption.recipient.",
          );
        }
        await (options.ageEncryptor ?? encryptArchiveWithAge)(
          archivePath,
          encryptedPath,
          options.encryption.recipient,
          {
            ...(options.environment === undefined
              ? {}
              : { environment: options.environment }),
          },
        );
        await rm(archivePath, { force: true });
      }
    } catch (error) {
      if (remote) {
        await rm(archivePath, { force: true }).catch(() => undefined);
      } else if (encrypted) {
        await Promise.allSettled([
          rm(archivePath, { force: true }),
          rm(encryptedPath, { force: true }),
          rm(options.workspaceRoot, { recursive: true, force: true }),
          rm(options.checkpointPath, { force: true }),
        ]);
      }
      throw error;
    }
  }

  if (remote) {
    const published = await (options.s3Publisher ?? publishS3Backup)(
      transportPath,
      options.destination,
      {
        runId: options.runId,
        statePath,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      },
    );
    await cleanupStrict(
      [
        { path: archivePath },
        { path: encryptedPath },
        { path: options.workspaceRoot, recursive: true },
        { path: options.checkpointPath },
        { path: statePath },
      ],
      publicationError(
        "S3_LOCAL_CLEANUP_FAILED",
        "destination",
        "Remote backup was committed but local staging cleanup failed.",
        { locator: published.locator },
      ),
    );
    return { output: published.locator, remote: published };
  }

  if (encrypted) {
    await cleanupStrict(
      [
        { path: options.workspaceRoot, recursive: true },
        { path: options.checkpointPath },
      ],
      publicationError(
        "ENCRYPTION_FAILED",
        "encryption",
        "Encrypted backup was created but plaintext staging cleanup failed.",
        { encryptedOutput: encryptedPath },
      ),
    );
    return { output: encryptedPath };
  }

  await rm(options.checkpointPath, { force: true });
  return { output: archivePath };
}
