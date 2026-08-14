import { describe, expect, it, vi } from "vitest";

import type { ProtectedArtifactSink } from "../../src/security/protected-artifact.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import {
  captureVaultRootKey,
  VAULT_ROOT_KEY_ARTIFACT,
} from "../../src/supabase/management/vault-root-key.js";

describe("Vault/pgsodium root-key capture", () => {
  it("captures the exact key through a protected sink and redacts it", async () => {
    const key = "0123456789abcdef".repeat(4);
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ root_key: key, future_field: true }), {
        status: 200,
      }),
    );
    const redactor = new Redactor();
    const writes: {
      path: string;
      value: Readonly<Record<string, unknown>>;
    }[] = [];
    const sink: ProtectedArtifactSink = {
      writeJson: (artifactPath, value) => {
        writes.push({ path: artifactPath, value });
        return Promise.resolve();
      },
    };
    const captured = await captureVaultRootKey(
      new ManagementClient({
        accessToken: new SecretValue("management-token", redactor),
        fetch: request,
      }),
      "abcdefghijklmnopqrst",
      redactor,
      sink,
    );
    expect(captured.rootKey.expose()).toBe(key);
    expect(captured.coverage).toEqual({
      id: "database.vault_root_key",
      status: "backed_up",
      sensitivity: "secret",
      artifacts: [VAULT_ROOT_KEY_ARTIFACT],
      sourceContract: {
        adapter: "management-api-pgsodium-v1",
        endpoint: "/v1/projects/{ref}/pgsodium",
        fidelity: "exact",
        restoreOrder: "before-database.vault_data",
      },
    });
    expect(writes).toEqual([
      {
        path: VAULT_ROOT_KEY_ARTIFACT,
        value: {
          schemaVersion: 1,
          algorithm: "pgsodium-root-key-32-byte-hex",
          rootKey: key,
        },
      },
    ]);
    expect(redactor.redact(`root=${key}`)).toBe("root=[REDACTED]");
    expect(JSON.stringify(captured.coverage)).not.toContain(key);
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/pgsodium",
    );
  });

  it("fails closed when the current response contract is malformed", async () => {
    const key = "root-key-contract-canary";
    const redactor = new Redactor();
    const writeJson = vi.fn(() => Promise.resolve());
    const sink: ProtectedArtifactSink = {
      writeJson,
    };
    await expect(
      captureVaultRootKey(
        new ManagementClient({
          accessToken: new SecretValue("management-token", redactor),
          fetch: () =>
            Promise.resolve(
              new Response(JSON.stringify({ root_key: key }), { status: 200 }),
            ),
        }),
        "abcdefghijklmnopqrst",
        redactor,
        sink,
      ),
    ).rejects.toMatchObject({
      code: "PLATFORM_API_CONTRACT_CHANGED",
      message:
        "Supabase Management API response no longer matches the validated contract.",
    });
    expect(writeJson).not.toHaveBeenCalled();
  });
});
