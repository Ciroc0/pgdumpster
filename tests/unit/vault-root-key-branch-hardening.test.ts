import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createVaultRootKeyRestoreHandler } from "../../src/core/restore/vault-root-key-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";
import { VAULT_ROOT_KEY_ARTIFACT } from "../../src/supabase/management/vault-root-key.js";

const temporaryDirectories: string[] = [];

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

async function bundle(rootKey: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-vault-branch-"));

  temporaryDirectories.push(root);

  const filename = path.join(root, ...VAULT_ROOT_KEY_ARTIFACT.split("/"));

  await mkdir(path.dirname(filename), {
    recursive: true,
  });

  await writeFile(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      algorithm: "pgsodium-root-key-32-byte-hex",
      rootKey,
    }),
  );

  return root;
}

async function rawBundle(contents: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-vault-branch-"));

  temporaryDirectories.push(root);

  const filename = path.join(root, ...VAULT_ROOT_KEY_ARTIFACT.split("/"));

  await mkdir(path.dirname(filename), {
    recursive: true,
  });

  await writeFile(filename, contents);

  return root;
}

function action(): RestoreAction {
  return {
    id: "restore.database.vault_root_key",
    component: "database.vault_root_key",
    phase: 3,
    operation: "apply_vault_root_key",
    risk: "mutation",
    billable: false,
    dependsOn: ["restore.database.extensions"],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "restore",
    fidelity: "exact",
    artifacts: [VAULT_ROOT_KEY_ARTIFACT],
  };
}

function targetDatabaseUrl(): SecretValue {
  return new SecretValue(
    "postgresql://postgres:secret@db.example.invalid/postgres",
    new Redactor(),
  );
}

function management(getKeys: string[], putResult?: string) {
  const puts: unknown[] = [];
  let getCalls = 0;

  const client = {
    get() {
      getCalls += 1;

      const key = getKeys.shift();

      if (key === undefined) {
        throw new Error("Unexpected management GET");
      }

      return Promise.resolve({
        root_key: key,
      });
    },

    put(_pathname: unknown, body: unknown) {
      puts.push(body);

      let requested: string | undefined;

      if (body !== null && typeof body === "object") {
        const candidate: unknown = Reflect.get(body, "root_key");

        if (typeof candidate === "string") {
          requested = candidate;
        }
      }

      return Promise.resolve({
        root_key: putResult ?? requested ?? "",
      });
    },
  } as unknown as Pick<ManagementClient, "get" | "put">;

  return {
    client,
    puts,
    getCalls: () => getCalls,
  };
}

describe("Vault root-key branch hardening", () => {
  it("rejects a root-key artifact that is a directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-vault-dir-"));

    temporaryDirectories.push(root);

    await mkdir(path.join(root, ...VAULT_ROOT_KEY_ARTIFACT.split("/")), {
      recursive: true,
    });

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management([]).client,
      redactor: new Redactor(),
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
    });
  });

  it("rejects malformed root-key JSON", async () => {
    const root = await rawBundle("{broken");

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management([]).client,
      redactor: new Redactor(),
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "RESTORE_ARTIFACT_INVALID",
    });
  });

  it("compares root keys case-insensitively at the byte level", async () => {
    const root = await bundle("A".repeat(64));

    const createDatabaseClient = vi.fn();

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management(["a".repeat(64)]).client,
      redactor: new Redactor(),
      createDatabaseClient,
    });

    const applied = await handler.apply({
      action: action(),
      attempt: 1,
    });

    expect(applied.fingerprint).toBeDefined();
    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    expect(createDatabaseClient).not.toHaveBeenCalled();
  });

  it("wraps an invalid Vault safety query result and closes the client", async () => {
    const root = await bundle("a".repeat(64));

    const end = vi.fn(() => Promise.resolve());

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management(["b".repeat(64)]).client,
      redactor: new Redactor(),
      createDatabaseClient: () => ({
        connect: () => Promise.resolve(),
        query: () =>
          Promise.resolve({
            rows: [{}],
          }),
        end,
      }),
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "VAULT_ROOT_KEY_SAFETY_CHECK_FAILED",
    });

    expect(end).toHaveBeenCalledOnce();
  });

  it("wraps a Vault database connection failure and closes the client", async () => {
    const root = await bundle("a".repeat(64));

    const end = vi.fn(() => Promise.resolve());

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management(["b".repeat(64)]).client,
      redactor: new Redactor(),
      createDatabaseClient: () => ({
        connect: () => Promise.reject(new Error("database unavailable")),
        query: () =>
          Promise.resolve({
            rows: [],
          }),
        end,
      }),
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "VAULT_ROOT_KEY_SAFETY_CHECK_FAILED",
    });

    expect(end).toHaveBeenCalledOnce();
  });

  it("preserves cancellation during the Vault emptiness check", async () => {
    const root = await bundle("a".repeat(64));

    const controller = new AbortController();

    const reason = new Error("cancel Vault safety check");

    controller.abort(reason);

    const connect = vi.fn(() => Promise.resolve());

    const end = vi.fn(() => Promise.resolve());

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management(["b".repeat(64)]).client,
      redactor: new Redactor(),
      createDatabaseClient: () => ({
        connect,
        query: () =>
          Promise.resolve({
            rows: [
              {
                empty: true,
              },
            ],
          }),
        end,
      }),
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(connect).not.toHaveBeenCalled();

    expect(end).toHaveBeenCalledOnce();
  });

  it("fails when the Management API confirms a different replacement key", async () => {
    const root = await bundle("a".repeat(64));

    const managementFixture = management(["b".repeat(64)], "c".repeat(64));

    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: managementFixture.client,
      redactor: new Redactor(),
      createDatabaseClient: () => ({
        connect: () => Promise.resolve(),
        query: () =>
          Promise.resolve({
            rows: [
              {
                empty: true,
              },
            ],
          }),
        end: () => Promise.resolve(),
      }),
    });

    await expect(
      handler.apply({
        action: action(),
        attempt: 1,
      }),
    ).rejects.toMatchObject({
      code: "VAULT_ROOT_KEY_RESTORE_FAILED",
    });

    expect(managementFixture.puts).toHaveLength(1);
  });

  it("short-circuits verification on fingerprint mismatch and reports key mismatch", async () => {
    const root = await bundle("a".repeat(64));

    const noGet = management([]);

    const first = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: noGet.client,
      redactor: new Redactor(),
    });

    await expect(
      first.verify({
        action: action(),
        expectedFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);

    expect(noGet.getCalls()).toBe(0);

    const mismatching = management(["b".repeat(64)]);

    const second = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: mismatching.client,
      redactor: new Redactor(),
    });

    await expect(
      second.verify({
        action: action(),
      }),
    ).resolves.toBe(false);
  });
});
