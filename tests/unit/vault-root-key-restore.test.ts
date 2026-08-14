import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagementClient } from "../../src/supabase/management/client.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { createVaultRootKeyRestoreHandler } from "../../src/core/restore/vault-root-key-handler.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function bundle(rootKey: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-vault-restore-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "secrets"));
  await writeFile(
    path.join(root, "secrets", "database-vault-root-key.json"),
    JSON.stringify({
      schemaVersion: 1,
      algorithm: "pgsodium-root-key-32-byte-hex",
      rootKey,
    }),
  );
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
    artifacts: ["secrets/database-vault-root-key.json"],
  };
}

function managementClient(keys: string[]) {
  const putBodies: unknown[] = [];
  const client: Pick<ManagementClient, "get" | "put"> = {
    get(_pathname, schema) {
      const key = keys.shift();
      if (key === undefined) throw new Error("Missing GET fixture");
      return Promise.resolve(schema.parse({ root_key: key }));
    },
    put(_pathname, body, _bodySchema, responseSchema) {
      putBodies.push(body);
      return Promise.resolve(responseSchema.parse(body));
    },
  };
  return { client, putBodies };
}

const targetDatabaseUrl = () =>
  new SecretValue(
    "postgresql://postgres:secret@db.example.invalid/postgres",
    new Redactor(),
  );

describe("Vault root-key restore", () => {
  it("replaces a different key only after proving target Vault is empty", async () => {
    const sourceKey = "a".repeat(64);
    const root = await bundle(sourceKey);
    const management = managementClient(["b".repeat(64), sourceKey]);
    const query = vi.fn(() => Promise.resolve({ rows: [{ empty: true }] }));
    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management.client,
      redactor: new Redactor(),
      createDatabaseClient: () => ({
        connect: () => Promise.resolve(),
        query,
        end: () => Promise.resolve(),
      }),
    });

    const applied = await handler.apply({ action: action(), attempt: 1 });
    expect(query).toHaveBeenCalledWith(
      "select not exists (select 1 from vault.secrets) as empty",
    );
    expect(management.putBodies).toEqual([{ root_key: sourceKey }]);
    await expect(
      handler.verify({
        action: action(),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("refuses replacement when target Vault contains encrypted data", async () => {
    const sourceKey = "a".repeat(64);
    const root = await bundle(sourceKey);
    const management = managementClient(["b".repeat(64)]);
    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management.client,
      redactor: new Redactor(),
      createDatabaseClient: () => ({
        connect: () => Promise.resolve(),
        query: () => Promise.resolve({ rows: [{ empty: false }] }),
        end: () => Promise.resolve(),
      }),
    });

    await expect(
      handler.apply({ action: action(), attempt: 1 }),
    ).rejects.toMatchObject({ code: "VAULT_ROOT_KEY_TARGET_NOT_EMPTY" });
    expect(management.putBodies).toEqual([]);
  });

  it("does not query or mutate when target already has the exact key", async () => {
    const sourceKey = "c".repeat(64);
    const root = await bundle(sourceKey);
    const management = managementClient([sourceKey]);
    const createDatabaseClient = vi.fn();
    const handler = createVaultRootKeyRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      targetDatabaseUrl: targetDatabaseUrl(),
      client: management.client,
      redactor: new Redactor(),
      createDatabaseClient,
    });

    const applied = await handler.apply({ action: action(), attempt: 1 });
    expect(applied.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(createDatabaseClient).not.toHaveBeenCalled();
    expect(management.putBodies).toEqual([]);
  });
});
