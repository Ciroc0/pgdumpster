import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfigFile } from "../../src/config/file.js";
import { packBundle } from "../../src/core/bundle/archive.js";
import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { withConfiguredBundleInput } from "../../src/destination/bundle-input.js";
import type { materializeS3Backup } from "../../src/destination/s3.js";
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

describe("configured S3 bundle input", () => {
  it("materializes an s3:// locator before normal archive verification and cleans temp state", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "pgdumpster-s3-input-"));
    temporaryDirectories.push(parent);
    const root = await finalizedBundle(parent);
    const archive = path.join(parent, "pgdumpster-test.tar.zst");
    await packBundle(root, archive);
    const configPath = path.join(parent, "pgdumpster.yaml");
    await writeFile(
      configPath,
      "destination:\n  type: s3\n  endpoint: https://s3.example.test\n  region: test-1\n  bucket: backups\n  prefix: production\n",
    );
    const loadedConfig = await loadConfigFile(configPath);
    let materializeDirectory: string | undefined;
    const s3Materializer = vi.fn<typeof materializeS3Backup>(
      async (_locator, outputDirectory) => {
        materializeDirectory = outputDirectory;
        const target = path.join(outputDirectory, path.basename(archive));
        await copyFile(archive, target);
        return target;
      },
    );

    const result = await withConfiguredBundleInput(
      "s3://backups/production/11111111-1111-4111-8111-111111111111/",
      loadedConfig,
      (bundle) => bundle.manifest.source.projectRef,
      { s3Materializer },
    );

    expect(result).toBe("abcdefghijklmnopqrst");
    expect(s3Materializer).toHaveBeenCalledOnce();
    expect(materializeDirectory).toBeDefined();
    await expect(access(materializeDirectory!)).rejects.toThrow();
  });

  it("requires S3 config for remote locators but leaves local inputs unchanged", async () => {
    await expect(
      withConfiguredBundleInput(
        "s3://backups/production/run/",
        undefined,
        () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG_MISSING_REQUIRED",
      category: "config",
    });
  });
});
