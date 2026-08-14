import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";

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

async function target(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-registry-hardening-"),
  );

  temporaryDirectories.push(directory);

  return path.join(directory, "coverage-registry.yaml");
}

describe("coverage registry hardening", () => {
  it("loads an explicitly supplied valid registry path", async () => {
    const registry = await loadCoverageRegistry();

    const filename = await target();

    await writeFile(filename, stringify(registry));

    await expect(loadCoverageRegistry(filename)).resolves.toEqual(registry);
  });

  it("rejects duplicate component identifiers", async () => {
    const registry = await loadCoverageRegistry();

    const filename = await target();

    await writeFile(
      filename,
      stringify({
        ...registry,
        components: [
          ...registry.components,
          {
            ...registry.components[0]!,
          },
        ],
      }),
    );

    await expect(loadCoverageRegistry(filename)).rejects.toThrow(
      "Duplicate coverage component",
    );
  });

  it("rejects duplicate status vocabulary values", async () => {
    const registry = await loadCoverageRegistry();

    const filename = await target();

    await writeFile(
      filename,
      stringify({
        ...registry,
        status_values: [
          registry.status_values[0]!,
          registry.status_values[0]!,
          registry.status_values[2]!,
          registry.status_values[3]!,
          registry.status_values[4]!,
        ],
      }),
    );

    await expect(loadCoverageRegistry(filename)).rejects.toThrow(
      "Coverage status vocabulary contains duplicates",
    );
  });

  it("rejects strict-schema drift", async () => {
    const registry = await loadCoverageRegistry();

    const filename = await target();

    await writeFile(
      filename,
      stringify({
        ...registry,
        unexpected_field: true,
      }),
    );

    await expect(loadCoverageRegistry(filename)).rejects.toBeDefined();
  });
});
