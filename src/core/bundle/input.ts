import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PgDumpsterError } from "../errors/error.js";
import { extractBundleArchive } from "./archive.js";
import { decryptArchiveWithAge } from "./encryption.js";
import { verifyBundle, type VerifiedBundle } from "./verify.js";

export interface VerifiedBundleInputOptions {
  ageIdentityFile?: string | undefined;
  signal?: AbortSignal | undefined;
  ageDecryptor?: typeof decryptArchiveWithAge | undefined;
}

export async function withVerifiedBundle<T>(
  input: string,
  callback: (bundle: VerifiedBundle) => Promise<T> | T,
  options: VerifiedBundleInputOptions = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const inputStat = await lstat(input);
  if (inputStat.isDirectory() && !inputStat.isSymbolicLink()) {
    return callback(await verifyBundle(input));
  }
  if (!inputStat.isFile() || inputStat.isSymbolicLink()) {
    throw new Error(
      "Bundle input must be a directory, .tar.zst archive, or .tar.zst.age archive",
    );
  }

  const encrypted = input.endsWith(".tar.zst.age");
  if (!encrypted && !input.endsWith(".tar.zst")) {
    throw new Error(
      "Bundle input must be a directory, .tar.zst archive, or .tar.zst.age archive",
    );
  }
  if (encrypted && options.ageIdentityFile === undefined) {
    throw new PgDumpsterError({
      code: "ENCRYPTION_IDENTITY_MISSING",
      category: "encryption",
      message:
        "An age identity file reference is required to read an encrypted bundle.",
      retryable: false,
    });
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "pgdumpster-extract-"));
  try {
    let archive = input;
    if (encrypted) {
      archive = path.join(temporary, path.basename(input, ".age"));
      await (options.ageDecryptor ?? decryptArchiveWithAge)(
        input,
        archive,
        options.ageIdentityFile!,
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    }
    const extraction = path.join(temporary, "bundle");
    await mkdir(extraction, { mode: 0o700 });
    const root = await extractBundleArchive(archive, extraction, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await callback(await verifyBundle(root));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
