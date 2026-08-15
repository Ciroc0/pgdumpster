import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import {
  executeRestore,
  restorePlanSha256,
  type RestoreActionHandler,
  type RestoreExecutionResult,
} from "../../src/core/restore/executor.js";
import {
  createRestoreParityReport,
  restoreParityReportSchema,
  writeRestoreParityReport,
} from "../../src/core/restore/parity-report.js";
import {
  restorePlanSchema,
  type RestorePlan,
} from "../../src/core/restore/plan.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { canonicalJson } from "../../src/utils/canonical-json.js";

const temporaryDirectories: string[] = [];
const generatedRestoreFiles: string[] = [];

const sourceProjectRef = "abcdefghijklmnopqrst";
const targetProjectRef = "zyxwvutsrqponmlkjihg";
const backupOperationId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const completedAt = "2026-08-15T21:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function plan(): RestorePlan {
  return restorePlanSchema.parse({
    schemaVersion: 1,
    planId,
    createdAt: "2026-08-15T20:00:00.000Z",
    source: {
      projectRef: sourceProjectRef,
      backupOperationId,
      backupResult: "complete_with_platform_limits",
    },
    target: { projectRef: targetProjectRef },
    conflictPolicy: "replace",
    allowBillableResources: false,
    status: "ready_with_platform_limits",
    actions: [
      {
        id: "restore.database.extensions",
        component: "database.extensions",
        phase: 2,
        operation: "apply_logical_database_state",
        risk: "mutation",
        billable: false,
        dependsOn: [],
        status: "planned",
        sourceStatus: "backed_up",
        restorePolicy: "restore",
        fidelity: "semantic",
        artifacts: ["database/extensions.sql"],
      },
      {
        id: "restore.diagnostics.logs",
        component: "diagnostics.logs",
        phase: 21,
        operation: "skip_diagnostic_state",
        risk: "inspection",
        billable: false,
        dependsOn: [],
        status: "skipped",
        sourceStatus: "not_applicable",
        restorePolicy: "diagnostics_only",
        fidelity: "not_applicable",
        artifacts: [],
      },
      {
        id: "restore.external.smtp_provider",
        component: "external.smtp_provider",
        phase: 21,
        operation: "manual_external_restore",
        risk: "manual",
        billable: false,
        dependsOn: [],
        status: "blocked_platform_limit",
        sourceStatus: "not_exportable",
        restorePolicy: "external",
        fidelity: "manual",
        artifacts: [],
        reasonCode: "manual_external_restore",
      },
    ],
    manualActions: [
      {
        id: "manual.external.smtp_provider",
        component: "external.smtp_provider",
        reasonCode: "manual_external_restore",
        message: "Restore the external SMTP provider outside pgDumpster.",
      },
    ],
  });
}

async function checkpointPath(prefix = "pgdumpster-parity-"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "restore.checkpoint.json");
}

function handler(fingerprint?: string): RestoreActionHandler {
  return {
    apply: vi.fn(() =>
      Promise.resolve(fingerprint === undefined ? {} : { fingerprint }),
    ),
    verify: vi.fn(() => Promise.resolve(true)),
  };
}

async function createOfflineRestoreBundle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-parity-cli-"));
  temporaryDirectories.push(root);
  const registry = await loadCoverageRegistry();
  const coverage = {
    formatVersion: "1.0.0",
    components: registry.components.map(({ id, sensitivity }) => ({
      id,
      status: "not_configured" as const,
      sensitivity,
      artifacts: [] as string[],
    })),
  };
  const coverageText = canonicalJson(coverage);
  await writeFile(path.join(root, "coverage.json"), coverageText);
  const checksums = `${sha256(coverageText)}  coverage.json\n`;
  await writeFile(path.join(root, "checksums.sha256"), checksums);
  const manifest = {
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: "0.0.0-test" },
    operation: {
      id: backupOperationId,
      startedAt: "2026-08-15T19:00:00.000Z",
      completedAt: "2026-08-15T19:01:00.000Z",
    },
    source: { projectRef: sourceProjectRef },
    result: { status: "complete", consistency: "verified" },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    checksumFileSha256: sha256(checksums),
    components: coverage.components.map(({ id, status }) => ({ id, status })),
    statistics: {
      files: 1,
      bytes: Buffer.byteLength(coverageText),
    },
  };
  await writeFile(path.join(root, "manifest.json"), canonicalJson(manifest));
  return root;
}

function cliArtifactPaths(id: string): {
  checkpoint: string;
  parity: string;
} {
  const root = path.resolve(".pgdumpster-restore");
  const files = {
    checkpoint: path.join(root, `${id}.checkpoint.json`),
    parity: path.join(root, `${id}.parity.json`),
  };
  generatedRestoreFiles.push(files.checkpoint, files.parity);
  return files;
}

async function removeGeneratedRestoreFiles(): Promise<void> {
  await Promise.all(
    generatedRestoreFiles
      .splice(0)
      .map((filename) => rm(filename, { force: true })),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await removeGeneratedRestoreFiles();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("restore parity report", () => {
  it("binds successful action evidence to the immutable plan and explicit platform limits", async () => {
    const value = plan();
    const secretCanary = "do-not-export-this-secret";
    const internalFingerprint = sha256(secretCanary);
    const result = await executeRestore({
      plan: value,
      checkpointPath: await checkpointPath(),
      handlers: {
        "database.extensions": handler(internalFingerprint),
      },
      now: () => completedAt,
    });
    const report = createRestoreParityReport(value, result);

    expect(report).toMatchObject({
      schemaVersion: 1,
      planId,
      planSha256: restorePlanSha256(value),
      planCreatedAt: value.createdAt,
      completedAt,
      backupOperationId,
      sourceProjectRef,
      sourceBackupResult: "complete_with_platform_limits",
      targetProjectRef,
      status: "restored_with_platform_limits",
    });
    expect(report.actions).toEqual([
      expect.objectContaining({
        id: "restore.database.extensions",
        planStatus: "planned",
        declaredFidelity: "semantic",
        outcome: "verified",
        verification: "applied_and_verified",
      }),
      expect.objectContaining({
        id: "restore.diagnostics.logs",
        planStatus: "skipped",
        declaredFidelity: "not_applicable",
        outcome: "skipped",
      }),
      expect.objectContaining({
        id: "restore.external.smtp_provider",
        planStatus: "blocked_platform_limit",
        declaredFidelity: "manual",
        outcome: "platform_limit",
        reasonCode: "manual_external_restore",
      }),
    ]);
    expect(report.manualActions).toEqual(value.manualActions);
    expect(result.completedActions).toBe(1);
    expect(result.skippedActions).toBe(1);
    expect(JSON.stringify(result)).not.toContain(internalFingerprint);
    expect(JSON.stringify(report)).not.toContain(internalFingerprint);
    expect(JSON.stringify(report)).not.toContain(secretCanary);
  });

  it("writes canonical parity evidence atomically with restrictive permissions", async () => {
    const value = plan();
    const result = await executeRestore({
      plan: value,
      checkpointPath: await checkpointPath(),
      handlers: { "database.extensions": handler() },
      now: () => completedAt,
    });
    const report = createRestoreParityReport(value, result);
    const directory = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-parity-write-"),
    );
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "restore.parity.json");

    await writeRestoreParityReport(filename, report);

    expect(await readFile(filename, "utf8")).toBe(canonicalJson(report));
    if (process.platform !== "win32") {
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    }
  });

  it("records successful resume re-verification without reapplying the action", async () => {
    const value = plan();
    value.actions = [value.actions[0]!];
    value.manualActions = [];
    value.status = "ready";
    value.source.backupResult = "complete";
    const filename = await checkpointPath("pgdumpster-parity-resume-");
    const apply = vi.fn(() => Promise.resolve({ fingerprint: "a".repeat(64) }));
    const actionHandler: RestoreActionHandler = {
      apply,
      verify: vi.fn(() => Promise.resolve(true)),
    };

    await executeRestore({
      plan: value,
      checkpointPath: filename,
      handlers: { "database.extensions": actionHandler },
      now: () => completedAt,
    });
    const resumed = await executeRestore({
      plan: value,
      checkpointPath: filename,
      handlers: { "database.extensions": actionHandler },
      resume: true,
      now: () => "2026-08-15T21:05:00.000Z",
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(resumed.actionEvidence).toEqual([
      expect.objectContaining({
        outcome: "verified",
        verification: "resume_reverified",
      }),
    ]);
    expect(createRestoreParityReport(value, resumed).completedAt).toBe(
      "2026-08-15T21:05:00.000Z",
    );
  });

  it("records crash recovery verification separately from normal application", async () => {
    const value = plan();
    value.actions = [value.actions[0]!];
    value.manualActions = [];
    value.status = "ready";
    value.source.backupResult = "complete";
    const filename = await checkpointPath("pgdumpster-parity-recovery-");
    const apply = vi.fn(() => Promise.reject(new Error("checkpoint gap")));
    const verify = vi.fn(() => Promise.resolve(true));

    await expect(
      executeRestore({
        plan: value,
        checkpointPath: filename,
        handlers: { "database.extensions": { apply, verify } },
        now: () => completedAt,
      }),
    ).rejects.toThrow("checkpoint gap");

    const resumed = await executeRestore({
      plan: value,
      checkpointPath: filename,
      handlers: { "database.extensions": { apply, verify } },
      resume: true,
      now: () => "2026-08-15T21:06:00.000Z",
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(resumed.actionEvidence[0]).toMatchObject({
      outcome: "verified",
      verification: "resume_recovered",
    });
  });

  it("rejects malformed reports and execution evidence inconsistent with the plan", async () => {
    const value = plan();
    const result = await executeRestore({
      plan: value,
      checkpointPath: await checkpointPath(),
      handlers: { "database.extensions": handler() },
      now: () => completedAt,
    });
    const report = createRestoreParityReport(value, result);

    const mismatchedResult: RestoreExecutionResult = {
      ...result,
      targetProjectRef: sourceProjectRef,
    };
    expect(() =>
      createRestoreParityReport(value, mismatchedResult),
    ).toThrowError(
      expect.objectContaining({ code: "RESTORE_PARITY_EVIDENCE_INVALID" }),
    );

    expect(
      restoreParityReportSchema.safeParse({
        ...report,
        actions: report.actions.map((action, index) =>
          index === 0 ? { ...action, outcome: "skipped" } : action,
        ),
      }).success,
    ).toBe(false);

    const directory = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-parity-invalid-"),
    );
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "invalid.parity.json");
    await expect(
      writeRestoreParityReport(filename, { ...report, unexpected: true }),
    ).rejects.toBeDefined();
    await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a successful CLI parity artifact and returns only non-secret machine output", async () => {
    const root = await createOfflineRestoreBundle();
    const cliPlanId = "33333333-3333-4333-8333-333333333333";
    const files = cliArtifactPaths(cliPlanId);
    await removeGeneratedRestoreFiles();
    generatedRestoreFiles.push(files.checkpoint, files.parity);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const databaseSecret =
      "postgresql://postgres:database-secret@example.invalid/postgres";
    const accessToken = "management-access-token-secret";

    await expect(
      runCli(
        [
          "restore",
          root,
          "--target-project-ref",
          targetProjectRef,
          "--target-db-url-env",
          "TARGET_DATABASE_URL",
          "--apply",
          "--json",
        ],
        {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        },
        {
          environment: {
            TARGET_DATABASE_URL: databaseSecret,
            PGDUMPSTER_ACCESS_TOKEN: accessToken,
          },
          randomUUID: () => cliPlanId,
        },
      ),
    ).resolves.toBe(0);

    const output = stdout.join("");
    const parsed = JSON.parse(output) as { parityReportPath?: string };
    expect(parsed.parityReportPath).toBe(files.parity);
    expect(output).not.toContain(databaseSecret);
    expect(output).not.toContain(accessToken);
    expect(stderr).toEqual([]);
    const parityText = await readFile(files.parity, "utf8");
    expect(parityText).not.toContain(databaseSecret);
    expect(parityText).not.toContain(accessToken);
    expect(
      restoreParityReportSchema.parse(JSON.parse(parityText)),
    ).toMatchObject({
      planId: cliPlanId,
      backupOperationId,
      sourceProjectRef,
      targetProjectRef,
      status: "restored",
    });
  });

  it("does not create successful parity evidence when restore execution fails", async () => {
    const root = await createOfflineRestoreBundle();
    const cliPlanId = "44444444-4444-4444-8444-444444444444";
    const files = cliArtifactPaths(cliPlanId);
    await removeGeneratedRestoreFiles();
    generatedRestoreFiles.push(files.checkpoint, files.parity);
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runCli(
        [
          "restore",
          root,
          "--target-project-ref",
          targetProjectRef,
          "--target-db-url-env",
          "TARGET_DATABASE_URL",
          "--apply",
          "--json",
        ],
        {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        },
        {
          environment: {
            TARGET_DATABASE_URL:
              "postgresql://postgres:secret@example.invalid/postgres",
            PGDUMPSTER_ACCESS_TOKEN: "access-token-secret",
          },
          randomUUID: () => cliPlanId,
          restoreExecutor: () => Promise.reject(new Error("restore failed")),
        },
      ),
    ).resolves.toBe(7);

    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("restore failed");
    await expect(stat(files.parity)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
