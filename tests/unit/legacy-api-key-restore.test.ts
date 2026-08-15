import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLegacyApiKeyRestoreHandler } from "../../src/core/restore/legacy-api-key-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function action(): RestoreAction {
  return {
    id: "restore.api.legacy_keys_state",
    component: "api.legacy_keys_state",
    phase: 17,
    operation: "apply_control_plane_configuration",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "capability_dependent",
    fidelity: "semantic",
    artifacts: ["secrets/api-legacy-keys-state.json"],
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "pgdumpster-legacy-api-"));
  directories.push(value);
  await mkdir(path.join(value, "secrets"));
  await writeFile(
    path.join(value, "secrets", "api-legacy-keys-state.json"),
    JSON.stringify({ schemaVersion: 1, state: { enabled: true } }),
  );
  return value;
}

describe("legacy API-key restore", () => {
  it("updates target state only under replace and verifies parity", async () => {
    const bundleRoot = await root();
    let enabled = false;
    const putEmpty = vi.fn(
      (_path, _schema, options: { query?: Record<string, string> }) => {
        enabled = options.query?.["enabled"] === "true";
        return Promise.resolve({ enabled });
      },
    );
    const handler = createLegacyApiKeyRestoreHandler({
      bundleRoot,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "replace",
      client: { get: () => Promise.resolve({ enabled }), putEmpty },
    });
    const signal = new AbortController().signal;
    const applied = await handler.apply({
      action: action(),
      attempt: 1,
      signal,
    });
    expect(putEmpty).toHaveBeenCalledWith(
      "/v1/projects/uvwxyzabcdefghijklmn/api-keys/legacy",
      expect.anything(),
      { query: { enabled: "true" }, signal },
    );
    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a divergent target before mutation under fail", async () => {
    const bundleRoot = await root();
    const putEmpty = vi.fn();
    const handler = createLegacyApiKeyRestoreHandler({
      bundleRoot,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "fail",
      client: { get: () => Promise.resolve({ enabled: false }), putEmpty },
    });
    await expect(
      handler.apply({ action: action(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(putEmpty).not.toHaveBeenCalled();
  });

  it("is idempotent for matching state and rejects an incorrect artifact", async () => {
    const bundleRoot = await root();
    const putEmpty = vi.fn();
    const handler = createLegacyApiKeyRestoreHandler({
      bundleRoot,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "fail",
      client: { get: () => Promise.resolve({ enabled: true }), putEmpty },
    });
    const applied = await handler.apply({ action: action(), attempt: 1 });
    expect(putEmpty).not.toHaveBeenCalled();
    await expect(
      handler.verify({ action: action(), expectedFingerprint: "wrong" }),
    ).resolves.toBe(false);
    await expect(
      handler.apply({
        action: { ...action(), artifacts: ["secrets/other.json"] },
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
