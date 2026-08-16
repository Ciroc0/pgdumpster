import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
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
import {
  createRestoreCheckpoint,
  writeRestoreCheckpoint,
} from "../../src/core/checkpoint/restore.js";
import {
  restorePlanSha256,
  type executeRestore,
  type RestoreActionEvidence,
} from "../../src/core/restore/executor.js";
import {
  restorePlanSchema,
  writeRestorePlan,
} from "../../src/core/restore/plan.js";
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

  it("does not require a Management credential for a database-only restore plan", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-cli-database-credential-scope-"),
    );
    temporaryDirectories.push(parent);
    const bundle = await finalizedBundle(parent, { minimalPlan: true });
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
        "--json",
      ],
      io,
      {
        environment: {
          PGDUMPSTER_TARGET_DB_URL: "postgresql://target-secret@localhost/db",
        },
        fetch,
        restoreExecutor: ({ plan }) =>
          Promise.resolve({
            status: "restored",
            planId: plan.planId,
            planSha256: restorePlanSha256(plan),
            backupOperationId: plan.source.backupOperationId,
            sourceProjectRef: plan.source.projectRef,
            targetProjectRef: plan.target.projectRef,
            completedAt: "2026-08-16T01:10:00.000Z",
            completedActions: 1,
            skippedActions: plan.actions.length - 1,
            manualActions: plan.manualActions,
            actionEvidence: plan.actions.map((action) => {
              const base = {
                id: action.id,
                component: action.component,
                sourceStatus: action.sourceStatus,
                declaredFidelity: action.fidelity,
              };
              return action.status === "planned"
                ? {
                    ...base,
                    planStatus: "planned" as const,
                    outcome: "verified" as const,
                    verification: "applied_and_verified" as const,
                  }
                : {
                    ...base,
                    planStatus: "skipped" as const,
                    outcome: "skipped" as const,
                  };
            }),
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const output = JSON.parse(stdout.join("")) as {
      status: string;
      planPath: string;
      parityReportPath: string;
    };
    expect(output).toMatchObject({ status: "restored" });
    await Promise.all([
      unlink(output.planPath),
      unlink(output.parityReportPath),
    ]);
  });

  it("resumes from the persisted immutable plan without overwriting it", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-cli-restore-resume-"),
    );
    temporaryDirectories.push(parent);
    const bundle = await finalizedBundle(parent, { minimalPlan: true });
    const { stdout: dryRunOutput, io: dryRunIo } = ioBuffers();
    const baseArguments = [
      "restore",
      bundle,
      "--target-project-ref",
      "uvwxyzabcdefghijklmn",
      "--target-db-url-env",
      "PGDUMPSTER_TARGET_DB_URL",
    ];

    expect(
      await runCli([...baseArguments, "--dry-run", "--json"], dryRunIo),
    ).toBe(0);
    const plan = restorePlanSchema.parse(JSON.parse(dryRunOutput.join("")));
    const stateDirectory = path.join(parent, "restore-state");
    const checkpointPath = path.join(
      stateDirectory,
      `${plan.planId}.checkpoint.json`,
    );
    const planPath = path.join(stateDirectory, `${plan.planId}.plan.json`);
    await mkdir(stateDirectory);
    await writeRestorePlan(planPath, plan);
    await writeRestoreCheckpoint(
      checkpointPath,
      createRestoreCheckpoint({
        planId: plan.planId,
        planSha256: restorePlanSha256(plan),
        backupOperationId: plan.source.backupOperationId,
        sourceProjectRef: plan.source.projectRef,
        targetProjectRef: plan.target.projectRef,
        actions: plan.actions.map(({ id, status }) => ({
          id,
          planned: status === "planned",
        })),
        now: plan.createdAt,
      }),
    );
    const persistedBefore = await readFile(planPath, "utf8");
    const { stderr, io } = ioBuffers();
    const restoreExecutor = vi.fn<typeof executeRestore>(
      ({ plan: persistedPlan }) =>
        Promise.resolve({
          status:
            persistedPlan.manualActions.length > 0 ||
            persistedPlan.actions.some(
              ({ status }) => status === "blocked_platform_limit",
            )
              ? "restored_with_platform_limits"
              : "restored",
          planId: persistedPlan.planId,
          planSha256: restorePlanSha256(persistedPlan),
          backupOperationId: persistedPlan.source.backupOperationId,
          sourceProjectRef: persistedPlan.source.projectRef,
          targetProjectRef: persistedPlan.target.projectRef,
          completedAt: "2026-08-16T02:00:00.000Z",
          completedActions: persistedPlan.actions.filter(
            ({ status }) => status === "planned",
          ).length,
          skippedActions: persistedPlan.actions.filter(
            ({ status }) => status === "skipped",
          ).length,
          manualActions: persistedPlan.manualActions,
          actionEvidence: persistedPlan.actions.map(
            (action): RestoreActionEvidence => {
              if (
                action.status !== "planned" &&
                action.status !== "skipped" &&
                action.status !== "blocked_platform_limit"
              ) {
                throw new Error(`Unexpected action status: ${action.status}`);
              }
              const outcome =
                action.status === "planned"
                  ? "verified"
                  : action.status === "skipped"
                    ? "skipped"
                    : "platform_limit";
              return {
                id: action.id,
                component: action.component,
                sourceStatus: action.sourceStatus,
                declaredFidelity: action.fidelity,
                planStatus: action.status,
                outcome,
                reasonCode: action.reasonCode,
                ...(outcome === "verified"
                  ? { verification: "applied_and_verified" }
                  : {}),
              };
            },
          ),
        }),
    );

    expect(
      await runCli(
        [...baseArguments, "--apply", "--resume", checkpointPath, "--json"],
        io,
        {
          environment: {
            PGDUMPSTER_TARGET_DB_URL: "postgresql://target-secret@localhost/db",
          },
          restoreExecutor,
        },
      ),
    ).toBe(0);
    expect(stderr).toEqual([]);
    expect(restoreExecutor).toHaveBeenCalledTimes(1);
    expect(restoreExecutor.mock.calls[0]?.[0].plan.planId).toBe(plan.planId);
    expect(await readFile(planPath, "utf8")).toBe(persistedBefore);
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
