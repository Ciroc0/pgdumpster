import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import type { executeProductBackup } from "../../src/core/backup/product.js";
import { packBundle } from "../../src/core/bundle/archive.js";
import type { encryptArchiveWithAge } from "../../src/core/bundle/encryption.js";
import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import type {
  CoverageDocument,
  Manifest,
} from "../../src/core/bundle/schemas.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import type {
  materializeS3Backup,
  publishS3Backup,
} from "../../src/destination/s3.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];
const recipient = `age1${"q".repeat(58)}`;
const runId = "11111111-1111-4111-8111-111111111111";

function completedResult(): { manifest: Manifest; coverage: CoverageDocument } {
  return {
    manifest: {
      formatVersion: "1.0.0",
      tool: { name: "pgdumpster", version: "0.0.0-development" },
      operation: {
        id: runId,
        startedAt: "2026-08-15T03:00:00.000Z",
        completedAt: "2026-08-15T03:01:00.000Z",
      },
      source: { projectRef: "abcdefghijklmnopqrst" },
      result: { status: "complete", consistency: "verified" },
      coverageFile: "coverage.json",
      checksumFile: "checksums.sha256",
      checksumFileSha256: "0".repeat(64),
      components: [{ id: "database.roles", status: "backed_up" }],
      statistics: { files: 1, bytes: 1 },
    },
    coverage: {
      formatVersion: "1.0.0",
      components: [
        {
          id: "database.roles",
          status: "backed_up",
          sensitivity: "sensitive",
          artifacts: ["database/roles.sql"],
        },
      ],
    },
  };
}

function ioBuffers() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

async function config(contents: string): Promise<{
  directory: string;
  configPath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-cli-s3-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "pgdumpster.yaml");
  await writeFile(configPath, contents);
  return { directory, configPath };
}

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

describe("S3 CLI integration", () => {
  it("publishes an encrypted backup to the configured S3-compatible destination", async () => {
    const { configPath } = await config(
      `projectRef: abcdefghijklmnopqrst\nbackup:\n  output: ./backups\nencryption:\n  mode: age\n  recipient: ${recipient}\ndestination:\n  type: s3\n  endpoint: https://s3.example.test\n  region: eu-test-1\n  bucket: backups\n  prefix: production\n`,
    );
    const { stdout, stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>(() =>
      Promise.resolve(completedResult()),
    );
    const archivePacker = vi.fn<typeof packBundle>(async (_root, output) => {
      await writeFile(output, "archive");
    });
    const ageEncryptor = vi.fn<typeof encryptArchiveWithAge>(
      async (_input, output) => {
        await writeFile(output, "encrypted");
      },
    );
    const s3Publisher = vi.fn<typeof publishS3Backup>(
      async (localFile, destination, options) => {
        expect(destination).toMatchObject({
          bucket: "backups",
          endpoint: "https://s3.example.test",
          region: "eu-test-1",
        });
        expect(localFile.endsWith(".tar.zst.age")).toBe(true);
        return {
          locator: `s3://backups/production/${options.runId}/`,
          objectUri: `s3://backups/production/${options.runId}/${path.basename(localFile)}`,
          markerUri: `s3://backups/production/${options.runId}/COMPLETE.json`,
          size: 9,
          sha256: "a".repeat(64),
          recovered: false,
        };
      },
    );

    const exitCode = await runCli(
      ["backup", "--linked", "--config", configPath, "--json"],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        archivePacker,
        ageEncryptor,
        s3Publisher,
        now: () => new Date("2026-08-15T03:00:00.000Z"),
        randomUUID: () => runId,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const result = JSON.parse(stdout.join("")) as {
      output: string;
      remote: { object: string; marker: string; sha256: string };
    };
    expect(result.output).toBe(`s3://backups/production/${runId}/`);
    expect(result.remote.object).toMatch(/\.tar\.zst\.age$/u);
    expect(result.remote.marker).toMatch(/COMPLETE\.json$/u);
    expect(result.remote.sha256).toBe("a".repeat(64));
    expect(s3Publisher).toHaveBeenCalledOnce();
  });

  it("routes s3:// verify through remote materialization before bundle verification", async () => {
    const { directory, configPath } = await config(
      "destination:\n  type: s3\n  endpoint: https://s3.example.test\n  region: eu-test-1\n  bucket: backups\n  prefix: production\n",
    );
    const root = await finalizedBundle(directory);
    const archive = path.join(directory, "pgdumpster-test.tar.zst");
    await packBundle(root, archive);
    const s3Materializer = vi.fn<typeof materializeS3Backup>(
      async (_locator, outputDirectory) => {
        const target = path.join(outputDirectory, path.basename(archive));
        await copyFile(archive, target);
        return target;
      },
    );
    const { stdout, stderr, io } = ioBuffers();

    const exitCode = await runCli(
      [
        "verify",
        `s3://backups/production/${runId}/`,
        "--config",
        configPath,
        "--json",
      ],
      io,
      { s3Materializer },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain('"status":"verified"');
    expect(s3Materializer).toHaveBeenCalledOnce();
  });

  it("keeps plaintext S3 publication behind explicit opt-in", async () => {
    const { configPath } = await config(
      "projectRef: abcdefghijklmnopqrst\ndestination:\n  type: s3\n  bucket: backups\n",
    );
    const { stderr, io } = ioBuffers();
    const backupExecutor = vi.fn<typeof executeProductBackup>();
    const s3Publisher = vi.fn<typeof publishS3Backup>();

    const exitCode = await runCli(
      ["backup", "--linked", "--config", configPath, "--json"],
      io,
      {
        environment: { PGDUMPSTER_ACCESS_TOKEN: "management-secret" },
        backupExecutor,
        s3Publisher,
      },
    );

    expect(exitCode).toBe(7);
    expect(stderr.join("")).toContain("PLAINTEXT_SECRETS_NOT_ALLOWED");
    expect(backupExecutor).not.toHaveBeenCalled();
    expect(s3Publisher).not.toHaveBeenCalled();
  });
});
