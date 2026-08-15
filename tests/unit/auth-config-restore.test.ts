import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthConfigRestoreHandler } from "../../src/core/restore/auth-config-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function action(artifacts = ["secrets/auth-config.json"]): RestoreAction {
  return {
    id: "restore.auth.config",
    component: "auth.config",
    phase: 15,
    operation: "apply_auth_configuration",
    risk: "mutation",
    billable: false,
    dependsOn: ["restore.auth.data"],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "apply_after_database",
    fidelity: "semantic",
    artifacts,
  };
}

describe("Auth config restore handler", () => {
  it("patches only documented non-secret fields and verifies semantic parity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-auth-restore-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "secrets"));
    await writeFile(
      path.join(root, "secrets", "auth-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          site_url: "https://source.example.invalid",
          disable_signup: true,
          external_google_secret: "must-not-be-sent",
        },
      }),
    );
    const target: Record<string, unknown> = {
      site_url: "https://target.example.invalid",
      disable_signup: false,
    };
    const patch = vi.fn((_path, body: Record<string, unknown>) => {
      Object.assign(target, body);
      return Promise.resolve();
    });
    const handler = createAuthConfigRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      client: {
        get: () => Promise.resolve(target),
        patch,
      },
    });

    const applied = await handler.apply({ action: action(), attempt: 1 });

    expect(patch).toHaveBeenCalledWith(
      "/v1/projects/uvwxyzabcdefghijklmn/config/auth",
      {
        disable_signup: true,
        site_url: "https://source.example.invalid",
      },
      expect.anything(),
    );
    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("rejects an unexpected artifact list before mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-auth-restore-"));
    temporaryDirectories.push(root);
    const patch = vi.fn();
    const handler = createAuthConfigRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      client: { get: vi.fn(), patch },
    });

    await expect(
      handler.apply({ action: action(["secrets/other.json"]), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(patch).not.toHaveBeenCalled();
  });
});
