import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

describe("live E2E harness", () => {
  it("fails before invoking external commands when protected configuration is absent", async () => {
    await expect(
      executeFile(process.execPath, ["scripts/live-e2e.mjs"], {
        cwd: process.cwd(),
        env: {},
      }),
    ).rejects.toThrow(
      "Missing required live-E2E environment variable: PGDUMPSTER_E2E_SOURCE_PROJECT_REF",
    );
  });

  it("requires the scoped source Storage key before creating E2E state", async () => {
    await expect(
      executeFile(process.execPath, ["scripts/live-e2e.mjs"], {
        cwd: process.cwd(),
        env: {
          PGDUMPSTER_E2E_SOURCE_PROJECT_REF: "abcdefghijklmnopqrst",
          PGDUMPSTER_E2E_TARGET_PROJECT_REF: "zyxwvutsrqponmlkjihg",
          PGDUMPSTER_E2E_SOURCE_DB_URL:
            "postgresql://postgres.abcdefghijklmnopqrst:password@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
          PGDUMPSTER_E2E_TARGET_DB_URL:
            "postgresql://postgres.zyxwvutsrqponmlkjihg:password@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
          PGDUMPSTER_E2E_AGE_RECIPIENT: "age1example",
          PGDUMPSTER_E2E_AGE_IDENTITY_FILE: "identity.txt",
          PGDUMPSTER_ACCESS_TOKEN: "token",
        },
      }),
    ).rejects.toThrow(
      "Missing required live-E2E environment variable: PGDUMPSTER_E2E_SOURCE_STORAGE_KEY",
    );
  });

  it("requires the scoped target Storage key before creating E2E state", async () => {
    await expect(
      executeFile(process.execPath, ["scripts/live-e2e.mjs"], {
        cwd: process.cwd(),
        env: {
          PGDUMPSTER_E2E_SOURCE_PROJECT_REF: "abcdefghijklmnopqrst",
          PGDUMPSTER_E2E_TARGET_PROJECT_REF: "zyxwvutsrqponmlkjihg",
          PGDUMPSTER_E2E_SOURCE_DB_URL:
            "postgresql://postgres.abcdefghijklmnopqrst:password@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
          PGDUMPSTER_E2E_TARGET_DB_URL:
            "postgresql://postgres.zyxwvutsrqponmlkjihg:password@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
          PGDUMPSTER_E2E_AGE_RECIPIENT: "age1example",
          PGDUMPSTER_E2E_AGE_IDENTITY_FILE: "identity.txt",
          PGDUMPSTER_ACCESS_TOKEN: "token",
          PGDUMPSTER_E2E_SOURCE_STORAGE_KEY: "source-storage-key",
        },
      }),
    ).rejects.toThrow(
      "Missing required live-E2E environment variable: PGDUMPSTER_E2E_TARGET_STORAGE_KEY",
    );
  });

  it("reports a sanitized stage for non-secret configuration failures", async () => {
    await expect(
      executeFile(process.execPath, ["scripts/live-e2e.mjs"], {
        cwd: process.cwd(),
        env: {
          PGDUMPSTER_E2E_SOURCE_PROJECT_REF: "not-a-project-ref",
          PGDUMPSTER_E2E_TARGET_PROJECT_REF: "zyxwvutsrqponmlkjihg",
          PGDUMPSTER_E2E_SOURCE_DB_URL:
            "postgresql://postgres.not-a-project-ref:password@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
          PGDUMPSTER_E2E_TARGET_DB_URL:
            "postgresql://postgres.zyxwvutsrqponmlkjihg:password@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
          PGDUMPSTER_E2E_AGE_RECIPIENT: "age1example",
          PGDUMPSTER_E2E_AGE_IDENTITY_FILE: "identity.txt",
          PGDUMPSTER_ACCESS_TOKEN: "token",
          PGDUMPSTER_E2E_SOURCE_STORAGE_KEY: "source-storage-key",
          PGDUMPSTER_E2E_TARGET_STORAGE_KEY: "target-storage-key",
        },
      }),
    ).rejects.toThrow("Live E2E failed during configuration.");
  });
});
