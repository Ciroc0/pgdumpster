import {
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preflightPlannedRestoreArtifacts,
  runCli,
} from "../../src/cli/main.js";
import { packBundle } from "../../src/core/bundle/archive.js";
import type { decryptArchiveWithAge } from "../../src/core/bundle/encryption.js";
import {
  finalizeBundle,
  type ManifestBeforeFinalization,
} from "../../src/core/bundle/finalize.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];

async function finalizedBundle(
  parent: string,
  options: { minimalPlan?: boolean } = {},
): Promise<string> {
  const root = path.join(parent, "staging");
  await mkdir(path.join(root, "database"), { recursive: true });
  const registry = await loadCoverageRegistry();
  const components = registry.components.map(({ id, sensitivity }) => ({
    id,
    status:
      options.minimalPlan === true && id !== "database.schema"
        ? ("not_configured" as const)
        : ("backed_up" as const),
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
      startedAt: "2026-08-15T02:00:00.000Z",
      completedAt: "2026-08-15T02:01:00.000Z",
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

async function encryptedFixture(): Promise<{
  encrypted: string;
  configPath: string;
  identity: string;
}> {
  const parent = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-cli-age-input-"),
  );
  temporaryDirectories.push(parent);
  const root = await finalizedBundle(parent);
  const archive = path.join(parent, "pgdumpster-test.tar.zst");
  const encrypted = `${archive}.age`;
  const identity = path.join(parent, "identity.txt");
  const configPath = path.join(parent, "pgdumpster.yaml");
  await packBundle(root, archive);
  await copyFile(archive, encrypted);
  await writeFile(identity, "AGE-SECRET-KEY-1TEST");
  await writeFile(
    configPath,
    "encryption:\n  mode: age\n  identityFile: ./identity.txt\n",
  );
  return { encrypted, configPath, identity };
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI encrypted bundle input", () => {
  it("uses the configured identity file for verify", async () => {
    const { encrypted, configPath, identity } = await encryptedFixture();
    const { stdout, stderr, io } = ioBuffers();
    const ageDecryptor = vi.fn<typeof decryptArchiveWithAge>(
      async (input, output, identityFile) => {
        expect(input).toBe(encrypted);
        expect(identityFile).toBe(identity);
        await copyFile(input, output);
      },
    );

    const exitCode = await runCli(
      ["verify", encrypted, "--config", configPath, "--json"],
      io,
      { ageDecryptor },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(ageDecryptor).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "verified" });
  });

  it("fails closed when encrypted input has no configured identity", async () => {
    const { encrypted } = await encryptedFixture();
    const { stdout, stderr, io } = ioBuffers();

    const exitCode = await runCli(["verify", encrypted, "--json"], io);

    expect(exitCode).toBe(7);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("ENCRYPTION_IDENTITY_MISSING");
  });

  it("rejects blocked apply before reading target credentials or discovering resources", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-cli-restore-preflight-"),
    );
    temporaryDirectories.push(parent);
    const bundle = await finalizedBundle(parent);
    const { stdout, stderr, io } = ioBuffers();

    const fetch = vi.fn();
    const exitCode = await runCli(
      [
        "restore",
        bundle,
        "--target-project-ref",
        "uvwxyzabcdefghijklmn",
        "--target-db-url-env",
        "PGDUMPSTER_TARGET_DB_URL",
        "--apply",
      ],
      io,
      {
        environment: {},
        fetch,
      },
    );

    expect(exitCode).toBe(7);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("RESTORE_PLAN_BLOCKED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a corrupt planned artifact before executor mutation", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-cli-artifact-preflight-"),
    );
    temporaryDirectories.push(parent);
    const bundle = await finalizedBundle(parent, { minimalPlan: true });
    await unlink(path.join(bundle, "database", "schema.sql"));
    const { stdout, stderr, io } = ioBuffers();
    const restoreExecutor = vi.fn();

    const exitCode = await runCli(
      [
        "restore",
        bundle,
        "--target-project-ref",
        "uvwxyzabcdefghijklmn",
        "--target-db-url-env",
        "PGDUMPSTER_TARGET_DB_URL",
        "--apply",
      ],
      io,
      {
        environment: {
          PGDUMPSTER_ACCESS_TOKEN: "management-secret",
          PGDUMPSTER_TARGET_DB_URL: "postgresql://target-secret@localhost/db",
        },
        restoreExecutor,
      },
    );

    expect(exitCode).toBe(7);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("BUNDLE_INCOMPLETE");
    expect(stderr.join("")).not.toContain("target-secret");
    expect(restoreExecutor).not.toHaveBeenCalled();
  });

  it("preflights every planned restore artifact before checkpointing", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-cli-artifact-preflight-direct-"),
    );
    temporaryDirectories.push(parent);
    const bundle = await finalizedBundle(parent, { minimalPlan: true });
    const plan = {
      actions: [
        {
          component: "database.schema",
          status: "planned",
          artifacts: ["database/schema.sql"],
        },
        {
          component: "database.pooler",
          status: "blocked_platform_limit",
          artifacts: [],
        },
      ],
    } as Parameters<typeof preflightPlannedRestoreArtifacts>[1];

    await expect(
      preflightPlannedRestoreArtifacts(bundle, plan),
    ).resolves.toBeUndefined();

    await unlink(path.join(bundle, "database", "schema.sql"));
    await expect(
      preflightPlannedRestoreArtifacts(bundle, plan),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });
});
