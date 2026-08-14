import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

async function stagingBundle(): Promise<{
  root: string;
  manifest: ManifestBeforeFinalization;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-finalize-"));
  temporaryDirectories.push(root);
  const registry = await loadCoverageRegistry();
  const components = registry.components.map(({ id, sensitivity }) => ({
    id,
    status: "backed_up" as const,
    sensitivity,
    artifacts: id === "database.schema" ? ["database/schema.sql"] : [],
  }));
  await mkdir(path.join(root, "database"));
  await writeFile(
    path.join(root, "database", "schema.sql"),
    "create table public.example(id bigint primary key);\n",
  );
  await writeFile(
    path.join(root, "coverage.json"),
    canonicalJson({ formatVersion: "1.0.0", components }),
  );
  return {
    root,
    manifest: {
      formatVersion: "1.0.0",
      tool: { name: "pgdumpster", version: "0.0.0-test" },
      operation: {
        id: "019ffcf4-d0b6-7b40-847b-668eb570a987",
        startedAt: "2026-08-13T20:00:00.000Z",
        completedAt: "2026-08-13T20:01:00.000Z",
      },
      source: { projectRef: "abcdefghijklmnopqrst" },
      result: { status: "complete", consistency: "verified" },
      coverageFile: "coverage.json",
      checksumFile: "checksums.sha256",
      components: components.map(({ id, status }) => ({ id, status })),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bundle finalization", () => {
  it("writes deterministic checksums and the valid manifest last", async () => {
    const { root, manifest } = await stagingBundle();
    const finalized = await finalizeBundle(root, manifest);
    expect(finalized.statistics.files).toBe(2);
    expect(await readFile(path.join(root, "manifest.json"), "utf8")).toBe(
      canonicalJson(finalized),
    );

    await rm(path.join(root, "manifest.json"));
    const firstChecksums = await readFile(
      path.join(root, "checksums.sha256"),
      "utf8",
    );
    const repeated = await finalizeBundle(root, manifest);
    expect(repeated).toEqual(finalized);
    expect(await readFile(path.join(root, "checksums.sha256"), "utf8")).toBe(
      firstChecksums,
    );
  });

  it("never emits a completion manifest for an aborted run", async () => {
    const { root, manifest } = await stagingBundle();
    const controller = new AbortController();
    controller.abort(new Error("test interruption"));
    await expect(
      finalizeBundle(root, manifest, { signal: controller.signal }),
    ).rejects.toThrow(/test interruption/u);
    await expect(readFile(path.join(root, "manifest.json"))).rejects.toThrow();
  });

  it("refuses transient checkpoint material", async () => {
    const { root, manifest } = await stagingBundle();
    await mkdir(path.join(root, "checkpoints"));
    await writeFile(path.join(root, "checkpoints", "run.json"), "{}\n");
    await expect(finalizeBundle(root, manifest)).rejects.toThrow(
      /Transient run file/u,
    );
  });

  it("refuses a coverage artifact reference that is not in the bundle", async () => {
    const { root, manifest } = await stagingBundle();
    const coverage = JSON.parse(
      await readFile(path.join(root, "coverage.json"), "utf8"),
    ) as {
      components: { id: string; artifacts: string[] }[];
    };
    coverage.components.find(({ id }) => id === "database.schema")!.artifacts =
      ["database/missing.sql"];
    await writeFile(
      path.join(root, "coverage.json"),
      canonicalJson({
        formatVersion: "1.0.0",
        components: coverage.components,
      }),
    );
    await expect(finalizeBundle(root, manifest)).rejects.toThrow(
      /Coverage artifact does not exist/u,
    );
    await expect(readFile(path.join(root, "manifest.json"))).rejects.toThrow();
  });
});
