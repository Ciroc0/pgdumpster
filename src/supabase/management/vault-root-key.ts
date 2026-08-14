import { z } from "zod";

import type { CoverageDocument } from "../../core/bundle/schemas.js";
import type { Redactor } from "../../security/redactor.js";
import type { ProtectedArtifactSink } from "../../security/protected-artifact.js";
import { SecretValue } from "../../security/secret-value.js";
import type { ManagementClient } from "./client.js";

const rootKeySchema = z
  .object({
    root_key: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  })
  .passthrough();

export const VAULT_ROOT_KEY_ARTIFACT =
  "secrets/database-vault-root-key.json" as const;

export interface CapturedVaultRootKey {
  coverage: CoverageDocument["components"][number];
  rootKey: SecretValue;
}

export async function captureVaultRootKey(
  client: ManagementClient,
  projectRef: string,
  redactor: Redactor,
  sink: ProtectedArtifactSink,
  signal?: AbortSignal,
): Promise<CapturedVaultRootKey> {
  const encodedRef = encodeURIComponent(projectRef);
  const response = await client.get(
    `/v1/projects/${encodedRef}/pgsodium`,
    rootKeySchema,
    signal === undefined ? {} : { signal },
  );
  const rootKey = new SecretValue(response.root_key, redactor);
  await sink.writeJson(
    VAULT_ROOT_KEY_ARTIFACT,
    {
      schemaVersion: 1,
      algorithm: "pgsodium-root-key-32-byte-hex",
      rootKey: rootKey.expose(),
    },
    signal,
  );
  return {
    rootKey,
    coverage: {
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
    },
  };
}
