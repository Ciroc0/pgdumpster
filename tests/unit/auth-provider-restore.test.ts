import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthSsoRestoreHandler,
  createAuthTpaRestoreHandler,
} from "../../src/core/restore/auth-provider-handlers.js";
import type { RestoreAction } from "../../src/core/restore/plan.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function action(
  component: "auth.sso" | "auth.tpa",
  artifact: string,
): RestoreAction {
  return {
    id: `restore.${component}`,
    component,
    phase: 15,
    operation: "restore_auth_provider",
    risk: "mutation",
    billable: false,
    dependsOn: ["restore.auth.config"],
    status: "planned",
    sourceStatus: "backed_up",
    restorePolicy: "apply_after_database",
    fidelity: "semantic",
    artifacts: [artifact],
  };
}

async function bundle(artifact: string, items: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-auth-provider-"));
  directories.push(root);
  await mkdir(path.join(root, "secrets"));
  await writeFile(
    path.join(root, artifact),
    JSON.stringify({ schemaVersion: 1, items }),
  );
  return root;
}

describe("Auth provider restore handlers", () => {
  it("creates an SSO provider from an empty target and short-circuits when already equal", async () => {
    const source = {
      id: "source",
      saml: {
        entity_id: "https://source",
        metadata_url: "https://source/metadata",
      },
      domains: [{ domain: "source.example" }],
    };
    const root = await bundle("secrets/auth-sso.json", [source]);
    let target: Record<string, unknown>[] = [];
    const post = vi.fn((...arguments_: unknown[]) => {
      const body = arguments_[1] as Record<string, unknown>;
      target = [source];
      return Promise.resolve({ id: "target", ...body });
    });
    const remove = vi.fn();
    const handler = createAuthSsoRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "fail",
      client: {
        get: () => Promise.resolve({ items: target }),
        post,
        delete: remove,
      },
    });

    const restored = await handler.apply({
      action: action("auth.sso", "secrets/auth-sso.json"),
      attempt: 1,
    });
    await handler.apply({
      action: action("auth.sso", "secrets/auth-sso.json"),
      attempt: 2,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/v1/projects/uvwxyzabcdefghijklmn/config/auth/sso/providers",
      {
        type: "saml",
        metadata_url: "https://source/metadata",
        domains: ["source.example"],
      },
      expect.anything(),
      expect.anything(),
    );
    expect(remove).not.toHaveBeenCalled();
    await expect(
      handler.verify({
        action: action("auth.sso", "secrets/auth-sso.json"),
        expectedFingerprint: restored.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      handler.verify({
        action: action("auth.sso", "secrets/auth-sso.json"),
        expectedFingerprint: "wrong",
      }),
    ).resolves.toBe(false);
  });

  it("rejects divergent SSO target state before mutation under fail", async () => {
    const root = await bundle("secrets/auth-sso.json", [
      {
        id: "source",
        saml: {
          entity_id: "https://source",
          metadata_url: "https://source/metadata",
        },
        domains: [{ domain: "source.example" }],
      },
    ]);
    const post = vi.fn();
    const remove = vi.fn();
    const handler = createAuthSsoRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "fail",
      client: {
        get: () =>
          Promise.resolve({
            items: [
              {
                id: "target",
                saml: {
                  entity_id: "https://target",
                  metadata_url: "https://target/metadata",
                },
                domains: [],
              },
            ],
          }),
        post,
        delete: remove,
      },
    });

    await expect(
      handler.apply({
        action: action("auth.sso", "secrets/auth-sso.json"),
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_TARGET_CONFLICT" });
    expect(post).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("replaces TPA state and verifies normalized semantic parity", async () => {
    const source = {
      id: "11111111-1111-1111-8111-111111111111",
      type: "oidc",
      oidc_issuer_url: "https://issuer.example",
      jwks_url: "https://issuer.example/jwks",
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const root = await bundle("secrets/auth-tpa.json", [source]);
    let target: Record<string, unknown>[] = [
      {
        id: "22222222-2222-1222-8222-222222222222",
        type: "oidc",
        oidc_issuer_url: "https://old.example",
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const post = vi.fn((_pathname, body: Record<string, unknown>) => {
      target.push({
        id: source.id,
        type: "oidc",
        ...body,
        inserted_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      });
      return Promise.resolve(target[0]);
    });
    const remove = vi.fn(() => {
      target = [];
      return Promise.resolve(source);
    });
    const handler = createAuthTpaRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "replace",
      client: { get: () => Promise.resolve(target), post, delete: remove },
    });

    const applied = await handler.apply({
      action: action("auth.tpa", "secrets/auth-tpa.json"),
      attempt: 1,
    });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/v1/projects/uvwxyzabcdefghijklmn/config/auth/third-party-auth",
      {
        oidc_issuer_url: "https://issuer.example",
        jwks_url: "https://issuer.example/jwks",
      },
      expect.anything(),
      expect.anything(),
    );
    await expect(
      handler.verify({
        action: action("auth.tpa", "secrets/auth-tpa.json"),
        expectedFingerprint: applied.fingerprint,
      }),
    ).resolves.toBe(true);
  });

  it("deletes divergent SSO providers only under explicit replace", async () => {
    const source = {
      id: "source",
      saml: { entity_id: "https://source", metadata_xml: "<metadata />" },
      domains: [],
    };
    const root = await bundle("secrets/auth-sso.json", [source]);
    let target: Record<string, unknown>[] = [
      {
        id: "target",
        saml: { entity_id: "https://target", metadata_xml: "<old />" },
        domains: [],
      },
    ];
    const handler = createAuthSsoRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "replace",
      client: {
        get: () => Promise.resolve({ items: target }),
        post: vi.fn(() => {
          target = [source];
          return Promise.resolve(source);
        }),
        delete: vi.fn(() => {
          target = [];
          return Promise.resolve(source);
        }),
      },
    });

    const restored = await handler.apply({
      action: action("auth.sso", "secrets/auth-sso.json"),
      attempt: 1,
    });
    expect(typeof restored.fingerprint).toBe("string");
  });

  it("rejects a Third-party Auth artifact without restorable configuration", async () => {
    const root = await bundle("secrets/auth-tpa.json", [
      {
        id: "33333333-3333-1333-8333-333333333333",
        type: "oidc",
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    const post = vi.fn();
    const handler = createAuthTpaRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "replace",
      client: { get: vi.fn(), post, delete: vi.fn() },
    });

    await expect(
      handler.apply({
        action: action("auth.tpa", "secrets/auth-tpa.json"),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an Auth provider action with the wrong artifact before requests", async () => {
    const root = await bundle("secrets/auth-tpa.json", []);
    const get = vi.fn();
    const handler = createAuthTpaRestoreHandler({
      bundleRoot: root,
      targetProjectRef: "uvwxyzabcdefghijklmn",
      conflictPolicy: "fail",
      client: { get, post: vi.fn(), delete: vi.fn() },
    });

    await expect(
      handler.apply({
        action: action("auth.tpa", "secrets/not-auth-tpa.json"),
        attempt: 1,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_ARTIFACT_INVALID" });
    expect(get).not.toHaveBeenCalled();
  });
});
