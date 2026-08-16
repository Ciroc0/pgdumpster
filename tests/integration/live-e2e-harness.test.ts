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
});
