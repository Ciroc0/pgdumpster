import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/backup/coordinator.js", () => ({
  executeBackup: vi.fn(),
}));

import {
  executeBackup,
  type ExecuteBackupOptions,
} from "../../src/core/backup/coordinator.js";
import { executeProductBackup } from "../../src/core/backup/product.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";

const temporaryDirectories: string[] = [];
const STOP = "stop-after-product-wiring";
let captured: ExecuteBackupOptions | undefined;

beforeEach(() => {
  captured = undefined;
  vi.mocked(executeBackup).mockImplementation((options) => {
    captured = options;
    return Promise.reject(new Error(STOP));
  });
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-product-wiring-"));
  temporaryDirectories.push(root);
  return root;
}

function common(root: string, redactor: Redactor) {
  return {
    workspaceRoot: root,
    checkpointPath: path.join(root, "checkpoint.json"),
    runId: "product-consistency-wiring",
    projectRef: "abcdefghijklmnopqrst",
    immutableConfigSha256: "a".repeat(64),
    toolVersion: "0.0.0-test",
    startedAt: "2026-08-15T00:00:00.000Z",
    consistency: "verified" as const,
    management: {} as ManagementClient,
    redactor,
    allowPlaintextSecrets: true,
    maxStorageConcurrency: 2,
    maxApiConcurrency: 2,
  };
}

function wiredStepIds(): string[] {
  const execution = captured;
  if (execution === undefined) throw new Error("executeBackup was not called");
  return execution.steps
    .filter(({ consistency }) => consistency !== undefined)
    .map(({ id }) => id);
}

describe("product consistency wiring", () => {
  it("wires Database and File Storage adapters in direct mode only", async () => {
    const root = await workspace();
    const redactor = new Redactor();

    await expect(
      executeProductBackup({
        ...common(root, redactor),
        databaseUrl: new SecretValue(
          "postgresql://postgres:secret@example.invalid/postgres",
          redactor,
        ),
        storageKey: new SecretValue("service-role-test-key", redactor),
      }),
    ).rejects.toThrow(STOP);

    expect(wiredStepIds()).toEqual(["database", "file-storage"]);
  });

  it("wires the same fail-closed surfaces in linked mode", async () => {
    const root = await workspace();
    const redactor = new Redactor();

    await expect(
      executeProductBackup({
        ...common(root, redactor),
        linked: true,
        storageKey: new SecretValue("service-role-test-key", redactor),
      }),
    ).rejects.toThrow(STOP);

    expect(wiredStepIds()).toEqual(["database", "file-storage"]);
  });
});
