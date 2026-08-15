import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LoadedConfig } from "../config/file.js";
import type { decryptArchiveWithAge } from "../core/bundle/encryption.js";
import {
  withVerifiedBundle,
  type VerifiedBundleInputOptions,
} from "../core/bundle/input.js";
import type { VerifiedBundle } from "../core/bundle/verify.js";
import { PgDumpsterError } from "../core/errors/error.js";
import { materializeS3Backup } from "./s3.js";

export interface ConfiguredBundleInputOptions {
  environment?: NodeJS.ProcessEnv | undefined;
  ageDecryptor?: typeof decryptArchiveWithAge | undefined;
  s3Materializer?: typeof materializeS3Backup | undefined;
  signal?: AbortSignal | undefined;
}

function verifiedOptions(
  loadedConfig: LoadedConfig | undefined,
  options: ConfiguredBundleInputOptions,
): VerifiedBundleInputOptions {
  const ageIdentityFile =
    loadedConfig?.config.encryption.mode === "age"
      ? loadedConfig.config.encryption.identityFile
      : undefined;
  return {
    ...(ageIdentityFile === undefined ? {} : { ageIdentityFile }),
    ...(options.ageDecryptor === undefined
      ? {}
      : { ageDecryptor: options.ageDecryptor }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export async function withConfiguredBundleInput<T>(
  input: string,
  loadedConfig: LoadedConfig | undefined,
  callback: (bundle: VerifiedBundle) => Promise<T> | T,
  options: ConfiguredBundleInputOptions = {},
): Promise<T> {
  const verifyOptions = verifiedOptions(loadedConfig, options);
  if (!input.startsWith("s3://")) {
    return withVerifiedBundle(input, callback, verifyOptions);
  }
  if (loadedConfig?.config.destination.type !== "s3") {
    throw new PgDumpsterError({
      code: "CONFIG_MISSING_REQUIRED",
      category: "config",
      message:
        "Reading an s3:// backup requires an S3 destination configuration.",
      retryable: false,
    });
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "pgdumpster-s3-input-"));
  try {
    const local = await (options.s3Materializer ?? materializeS3Backup)(
      input,
      temporary,
      loadedConfig.config.destination,
      {
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return await withVerifiedBundle(local, callback, verifyOptions);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
