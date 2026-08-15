import {
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packBundle } from "../../src/core/bundle/archive.js";
import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import { withVerifiedBundle } from "../../src/core/bundle/input.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

async function finalizedBundle(parent: string): Promise<string> {
  const root = path.join(parent, "staging");
  await mkdir(path.join(root, "database"), { recursive: true });
  const registry = await loadCoverageRegistry();
  const components = registry.components.map(({ id, sensitivity }) => ({
    id,
    status: "backed_up" as const,
    sensitivity,
    artifacts: id === "database.schema" ? ["database/schema.sql"] : [],
  }));
  await writeFile(
    path.join(root, "database", "schema.sql"),
    "create table public.example(id bigint primary key);\n",
  );
  await writeFile(
    path.join(root, "coverage.json"),
    canonicalJson({ formatVersion: "1.0.0", components }),
  );
  const manifest: ManifestBeforeFinalization = {
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: "0.0.0-test" },
    operation: {
      id: "019ffcf4-d0b6-7b40-847b-668eb570a987",
      startedAt: "2026-08-15T01:00:00.000Z",
      completedAt: "2026-08-15T01:01:00.000Z",
    },
    source: { projectRef: "abcdefghijklmnopqrst" },
    result: { status: "complete", consistency: "verified" },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    components: components.map(({ id, status }) => ({ id, status })),
  };
  await finalizeBundle(root, manifest);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("age-encrypted verified bundle input", () => {
  it("decrypts an encrypted archive before extraction and verification", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-age-input-"));
    temporaryDirectories.push(parent);
    const root = await finalizedBundle(parent);
    const archive = path.join(parent, "pgdumpster-test.tar.zst");
    const encrypted = `${archive}.age`;
    const identity = path.join(parent, "identity.txt");
    await packBundle(root, archive);
    await copyFile(archive, encrypted);
    await writeFile(identity, "AGE-SECRET-KEY-1TEST");
    const ageDecryptor = vi.fn(
      async (input: string, output: string, identityFile: string) => {
        expect(input).toBe(encrypted);
        expect(identityFile).toBe(identity);
        await copyFile(input, output);
      },
    );

    const result = await withVerifiedBundle(
      encrypted,
      (bundle) => ({
        projectRef: bundle.manifest.source.projectRef,
        files: bundle.checksums.size,
      }),
      { ageIdentityFile: identity, ageDecryptor },
    );

    expect(result.projectRef).toBe("abcdefghijklmnopqrst");
    expect(result.files).toBeGreaterThan(0);
    expect(ageDecryptor).toHaveBeenCalledOnce();
  });

  it("fails closed before decryption when no age identity is configured", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-age-input-"));
    temporaryDirectories.push(parent);
    const encrypted = path.join(parent, "pgdumpster-test.tar.zst.age");
    await writeFile(encrypted, "encrypted");

    await expect(
      withVerifiedBundle(encrypted, () => undefined),
    ).rejects.toMatchObject({
      code: "ENCRYPTION_IDENTITY_MISSING",
      category: "encryption",
    });
  });
});
