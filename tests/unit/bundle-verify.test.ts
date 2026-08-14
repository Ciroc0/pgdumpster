import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { verifyBundle } from "../../src/core/bundle/verify.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createValidBundle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-test-"));
  temporaryDirectories.push(root);
  const registry = await loadCoverageRegistry();
  const coverage = {
    formatVersion: "1.0.0",
    components: registry.components.map(({ id, sensitivity }) => ({
      id,
      status: "backed_up",
      sensitivity,
      artifacts: id === "database.schema" ? ["database/schema.sql"] : [],
    })),
  };
  const coverageText = canonicalJson(coverage);
  const schemaText = "create table public.example(id bigint primary key);\n";
  await writeFile(path.join(root, "coverage.json"), coverageText);
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.join(root, "database")),
  );
  await writeFile(path.join(root, "database", "schema.sql"), schemaText);
  const checksums = [
    `${sha256(coverageText)}  coverage.json`,
    `${sha256(schemaText)}  database/schema.sql`,
  ]
    .join("\n")
    .concat("\n");
  await writeFile(path.join(root, "checksums.sha256"), checksums);
  const manifest = {
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
    checksumFileSha256: sha256(checksums),
    components: coverage.components.map(({ id, status }) => ({ id, status })),
    statistics: {
      files: 2,
      bytes: Buffer.byteLength(coverageText) + Buffer.byteLength(schemaText),
    },
  };
  await writeFile(path.join(root, "manifest.json"), canonicalJson(manifest));
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("bundle verification", () => {
  it("deep-verifies a complete directory bundle and powers all offline CLI commands", async () => {
    const root = await createValidBundle();
    const bundle = await verifyBundle(root);
    expect(bundle.checksums.size).toBe(2);

    for (const command of ["verify", "inspect", "coverage"] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      await expect(
        runCli([command, root, "--json"], {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        }),
      ).resolves.toBe(0);
      expect(stdout.join("")).not.toContain("secretValue");
      expect(stderr).toEqual([]);
    }
  });

  it("rejects modified, missing, and critical extra files", async () => {
    const modified = await createValidBundle();
    await writeFile(path.join(modified, "database", "schema.sql"), "changed\n");
    await expect(verifyBundle(modified)).rejects.toThrow(/Checksum mismatch/u);

    const missing = await createValidBundle();
    await rm(path.join(missing, "database", "schema.sql"));
    await expect(verifyBundle(missing)).rejects.toThrow(
      /Missing checksummed file/u,
    );

    const extra = await createValidBundle();
    await writeFile(path.join(extra, "unexpected.txt"), "unexpected");
    await expect(verifyBundle(extra)).rejects.toThrow(/Unindexed extra file/u);
  });

  it("rejects symlinks before restore could consume them", async () => {
    const root = await createValidBundle();
    const target = path.join(root, "database");
    const link = path.join(root, "linked-database");
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(verifyBundle(root)).rejects.toThrow(
      /Symbolic links are forbidden/u,
    );
  });

  it("uses stable CLI exit codes for usage and integrity failures", async () => {
    const output = {
      stdout: () => undefined,
      stderr: () => undefined,
    };
    await expect(runCli(["unknown"], output)).resolves.toBe(2);
    await expect(runCli(["verify", "missing"], output)).resolves.toBe(7);
  });
});
