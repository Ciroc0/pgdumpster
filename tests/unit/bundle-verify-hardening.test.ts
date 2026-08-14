import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import {
  manifestSchema,
  type Manifest,
} from "../../src/core/bundle/schemas.js";
import { verifyBundle } from "../../src/core/bundle/verify.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

async function validBundle(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-verify-hardening-"),
  );

  temporaryDirectories.push(root);

  await mkdir(path.join(root, "database"));

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
    canonicalJson({
      formatVersion: "1.0.0",
      components,
    }),
  );

  const manifest: ManifestBeforeFinalization = {
    formatVersion: "1.0.0",
    tool: {
      name: "pgdumpster",
      version: "0.0.0-test",
    },
    operation: {
      id: "019ffcf4-d0b6-7b40-847b-668eb570a987",
      startedAt: "2026-08-14T20:00:00.000Z",
      completedAt: "2026-08-14T20:01:00.000Z",
    },
    source: {
      projectRef: "abcdefghijklmnopqrst",
    },
    result: {
      status: "complete",
      consistency: "verified",
    },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    components: components.map(({ id, status }) => ({
      id,
      status,
    })),
  };

  await finalizeBundle(root, manifest);

  return root;
}

async function readManifest(root: string): Promise<Manifest> {
  return manifestSchema.parse(
    JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")),
  );
}

async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  await writeFile(path.join(root, "manifest.json"), canonicalJson(manifest));
}

async function replaceChecksums(root: string, text: string): Promise<void> {
  await writeFile(path.join(root, "checksums.sha256"), text);

  const manifest = await readManifest(root);

  await writeManifest(root, {
    ...manifest,
    checksumFileSha256: sha256(text),
  });
}

describe("bundle verification hardening", () => {
  it("rejects a bundle root that is not a directory", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-verify-root-"),
    );

    temporaryDirectories.push(parent);

    const file = path.join(parent, "bundle");
    await writeFile(file, "not a directory");

    await expect(verifyBundle(file)).rejects.toMatchObject({
      code: "BUNDLE_INCOMPLETE",
      category: "integrity",
    });
  });

  it("detects checksum index mutation before parsing entries", async () => {
    const root = await validBundle();

    await writeFile(path.join(root, "checksums.sha256"), "mutated\n");

    await expect(verifyBundle(root)).rejects.toThrow(
      "Checksum index digest does not match manifest",
    );
  });

  it("rejects malformed checksum index lines", async () => {
    const root = await validBundle();

    await replaceChecksums(root, "not a checksum line\n");

    await expect(verifyBundle(root)).rejects.toThrow("Invalid checksum line");
  });

  it("forbids manifest and checksum metadata from indexing themselves", async () => {
    const root = await validBundle();

    const text = `${"a".repeat(64)}  manifest.json\n`;

    await replaceChecksums(root, text);

    await expect(verifyBundle(root)).rejects.toThrow(
      "Checksum index cannot include manifest.json",
    );
  });

  it("rejects duplicate checksum paths", async () => {
    const root = await validBundle();

    const original = await readFile(
      path.join(root, "checksums.sha256"),
      "utf8",
    );

    const first = original.split("\n").find(Boolean);

    if (first === undefined) {
      throw new Error("Expected checksum fixture entry");
    }

    await replaceChecksums(root, `${original}${first}\n`);

    await expect(verifyBundle(root)).rejects.toThrow("Duplicate checksum path");
  });

  it("rejects case-fold checksum collisions", async () => {
    const root = await validBundle();
    const digest = "a".repeat(64);

    await replaceChecksums(
      root,
      [`${digest}  coverage.json`, `${digest}  Coverage.json`, ""].join("\n"),
    );

    await expect(verifyBundle(root)).rejects.toThrow(/case|collision/iu);
  });

  it("rejects manifest statistics that do not match payloads", async () => {
    const root = await validBundle();
    const manifest = await readManifest(root);

    await writeManifest(root, {
      ...manifest,
      statistics: {
        ...manifest.statistics,
        files: manifest.statistics.files + 1,
      },
    });

    await expect(verifyBundle(root)).rejects.toThrow(
      "Manifest statistics do not match checksummed payloads",
    );
  });

  it("rejects a manifest result that disagrees with coverage", async () => {
    const root = await validBundle();
    const manifest = await readManifest(root);

    await writeManifest(root, {
      ...manifest,
      result: {
        ...manifest.result,
        status: "complete_with_platform_limits",
      },
    });

    await expect(verifyBundle(root)).rejects.toThrow(
      /does not match coverage result/u,
    );
  });

  it("rejects manifest and coverage component-count drift", async () => {
    const root = await validBundle();
    const manifest = await readManifest(root);

    await writeManifest(root, {
      ...manifest,
      components: manifest.components.slice(1),
    });

    await expect(verifyBundle(root)).rejects.toThrow(
      "Manifest and coverage component counts differ",
    );
  });

  it("rejects manifest and coverage component-status drift", async () => {
    const root = await validBundle();
    const manifest = await readManifest(root);

    const components = manifest.components.map((component, index) =>
      index === 0
        ? {
            ...component,
            status: "not_configured" as const,
          }
        : component,
    );

    await writeManifest(root, {
      ...manifest,
      components,
    });

    await expect(verifyBundle(root)).rejects.toThrow(
      "Manifest/coverage mismatch",
    );
  });
});
