import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiKeyRestoreHandler } from "../../src/core/restore/api-key-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const sourceKey = {
  id: "source-key",
  type: "secret",
  name: "source_key",
  api_key: "sb_secret_source",
  description: "source key",
};

function action(): RestoreAction {
  return {
    id: "restore.api.modern_keys",
    component: "api.modern_keys",
    phase: 17,
    operation: "create_replacement_api_keys",
    risk: "mutation",
    billable: false,
    dependsOn: [],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "generate_replacements_and_rotation_map",
    fidelity: "replacement",
    artifacts: ["secrets/api-keys.json"],
  };
}

async function fixture(): Promise<{ root: string; rotationMapPath: string }> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-api-key-restore-"),
  );
  directories.push(root);
  await mkdir(path.join(root, "secrets"));
  await writeFile(
    path.join(root, "secrets", "api-keys.json"),
    JSON.stringify({ schemaVersion: 1, keys: [sourceKey] }),
  );
  return { root, rotationMapPath: path.join(root, "api-key-rotation.json") };
}

describe("modern API-key restore", () => {
  it("creates replacement credentials, redacts both values, and writes a protected rotation map", async () => {
    const { root, rotationMapPath } = await fixture();
    let target: Record<string, unknown>[] = [];
    const registered = vi.fn();
    const post = vi.fn((_path, body: Record<string, unknown>) => {
      target = [{ id: "target-key", ...body, api_key: "sb_secret_target" }];
      return Promise.resolve(target[0]);
    });
    const handler = createApiKeyRestoreHandler({
      bundleRoot: root,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "uvwxyzabcdefghijklmn",
      rotationMapPath,
      registerSecret: registered,
      client: { get: () => Promise.resolve(target), post },
    });

    const signal = new AbortController().signal;
    const applied = await handler.apply({
      action: action(),
      attempt: 1,
      signal,
    });

    expect(post).toHaveBeenCalledWith(
      "/v1/projects/uvwxyzabcdefghijklmn/api-keys",
      { type: "secret", name: "source_key", description: "source key" },
      expect.anything(),
      expect.anything(),
      { query: { reveal: "true" }, signal },
    );
    expect(registered).toHaveBeenCalledWith("sb_secret_source");
    expect(registered).toHaveBeenCalledWith("sb_secret_target");
    const map = JSON.parse(await readFile(rotationMapPath, "utf8")) as {
      entries: { source: { api_key: string }; target: { api_key: string } }[];
    };
    expect(map.entries[0]).toMatchObject({
      source: { api_key: "sb_secret_source" },
      target: { api_key: "sb_secret_target" },
    });
    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a target identity collision before creating a replacement", async () => {
    const { root, rotationMapPath } = await fixture();
    const post = vi.fn();
    const handler = createApiKeyRestoreHandler({
      bundleRoot: root,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "uvwxyzabcdefghijklmn",
      rotationMapPath,
      registerSecret: vi.fn(),
      client: {
        get: () =>
          Promise.resolve([{ ...sourceKey, api_key: "sb_secret_existing" }]),
        post,
      },
    });

    await expect(
      handler.apply({ action: action(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(post).not.toHaveBeenCalled();
  });

  it("maps generated legacy target keys without attempting to create them", async () => {
    const { root, rotationMapPath } = await fixture();
    await writeFile(
      path.join(root, "secrets", "api-keys.json"),
      JSON.stringify({
        schemaVersion: 1,
        keys: [{ ...sourceKey, type: "legacy" }],
      }),
    );
    const legacySource = { ...sourceKey, type: "legacy" as const };
    const get = vi.fn(() =>
      Promise.resolve([
        { ...legacySource, id: "target-legacy-key", api_key: "legacy-target" },
      ]),
    );
    const post = vi.fn();
    const handler = createApiKeyRestoreHandler({
      bundleRoot: root,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "uvwxyzabcdefghijklmn",
      rotationMapPath,
      registerSecret: vi.fn(),
      client: { get, post },
    });

    const result = await handler.apply({ action: action(), attempt: 1 });
    expect(result.fingerprint).toEqual(expect.any(String));
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("returns false when the protected rotation map is absent or no longer matches", async () => {
    const { root, rotationMapPath } = await fixture();
    const handler = createApiKeyRestoreHandler({
      bundleRoot: root,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "uvwxyzabcdefghijklmn",
      rotationMapPath,
      registerSecret: vi.fn(),
      client: { get: vi.fn(), post: vi.fn() },
    });

    await expect(
      handler.verify({ action: action(), expectedFingerprint: "0".repeat(64) }),
    ).resolves.toBe(false);
    await expect(handler.verify({ action: action() })).resolves.toBe(false);
  });

  it("rejects an unexpected artifact list before source or target access", async () => {
    const { root, rotationMapPath } = await fixture();
    const get = vi.fn();
    const handler = createApiKeyRestoreHandler({
      bundleRoot: root,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "uvwxyzabcdefghijklmn",
      rotationMapPath,
      registerSecret: vi.fn(),
      client: { get, post: vi.fn() },
    });
    const invalid = { ...action(), artifacts: ["secrets/other.json"] };

    await expect(
      handler.apply({ action: invalid, attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed when the target does not reveal a generated key for the rotation map", async () => {
    const { root, rotationMapPath } = await fixture();
    await writeFile(
      path.join(root, "secrets", "api-keys.json"),
      JSON.stringify({
        schemaVersion: 1,
        keys: [
          {
            ...sourceKey,
            description: null,
            secret_jwt_template: { role: "worker" },
          },
        ],
      }),
    );
    let requests = 0;
    const handler = createApiKeyRestoreHandler({
      bundleRoot: root,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "uvwxyzabcdefghijklmn",
      rotationMapPath,
      registerSecret: vi.fn(),
      client: {
        get: () => {
          requests += 1;
          return Promise.resolve(
            requests === 1
              ? []
              : [{ ...sourceKey, id: "target-key", api_key: null }],
          );
        },
        post: vi.fn(() =>
          Promise.resolve({ ...sourceKey, id: "target-key", api_key: null }),
        ),
      },
    });

    await expect(
      handler.apply({ action: action(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
  });
});
