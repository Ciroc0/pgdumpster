import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);

describe("live E2E harness", () => {
  it("checks target Edge Function inventory before source fixture creation", async () => {
    const harness = await readFile("scripts/live-e2e.mjs", "utf8");

    expect(harness).toContain("assertTargetEdgeFunctionsEmpty");
    expect(harness).toContain(
      "const edgeFunctionInventorySchema = edgeFunctionListSchema.max(0)",
    );
    expect(harness.indexOf("await assertCleanTarget(")).toBeLessThan(
      harness.indexOf('currentStage = "source fixture seeding"'),
    );
  });

  it("requires an explicit opt-in before destructively resetting the target", async () => {
    const harness = await readFile("scripts/live-e2e.mjs", "utf8");
    const workflow = await readFile(".github/workflows/live-e2e.yml", "utf8");

    expect(harness).toContain("function resetTargetRequested(value)");
    expect(harness).toContain('value === "true"');
    expect(harness.indexOf("await resetTarget(")).toBeLessThan(
      harness.indexOf("await assertCleanTarget("),
    );
    expect(harness).toContain('currentStage = "target Storage reset"');
    expect(harness).toContain(
      'currentStage = "target database and E2E Auth reset"',
    );
    expect(harness).toContain('currentStage = "target Edge Function reset"');
    expect(harness).toContain(
      'currentStage = "target fixture database freshness preflight"',
    );
    expect(harness).toContain(
      'currentStage = "target Storage freshness preflight"',
    );
    expect(harness).toContain(
      'currentStage = "target E2E Auth freshness preflight"',
    );
    expect(workflow).toContain("reset_target:");
    expect(workflow).toContain("PGDUMPSTER_E2E_RESET_TARGET");
  });

  it("uses the direct PostgreSQL client for E2E preflight and smoke queries", async () => {
    const harness = await readFile("scripts/live-e2e.mjs", "utf8");

    expect(harness).toContain("async function postgresQuery(database, query)");
    expect(harness).not.toContain("async function supabaseQuery(");
  });

  it("maps the protected access token to the non-interactive Supabase CLI contract", async () => {
    const harness = await readFile("scripts/live-e2e.mjs", "utf8");

    expect(harness).toContain("SUPABASE_ACCESS_TOKEN: accessToken");
  });

  it("emits a PostgreSQL SQLSTATE without logging database credentials", async () => {
    const harness = await readFile("scripts/live-e2e.mjs", "utf8");

    expect(harness).toContain("PostgreSQL SQLSTATE ${databaseErrorCode}");
    expect(harness).not.toContain("error.message}`;");
  });

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
