import { describe, expect, it } from "vitest";

import { loadSourceEnvironment } from "../../src/config/environment.js";
import { serializeError } from "../../src/core/errors/serialize.js";
import { Redactor } from "../../src/security/redactor.js";

describe("source environment", () => {
  it("loads only explicit environment values and protects secrets", () => {
    const redactor = new Redactor();
    const loaded = loadSourceEnvironment(
      {
        PGDUMPSTER_PROJECT_REF: "abcdefghijklmnopqrst",
        PGDUMPSTER_ACCESS_TOKEN: "sbp_environment_canary_secret",
        PGDUMPSTER_DB_URL:
          "postgresql://postgres:environment_canary@db.example.invalid/postgres",
      },
      redactor,
    );
    expect(loaded.projectRef).toBe("abcdefghijklmnopqrst");
    expect(JSON.stringify(loaded)).not.toContain("environment_canary");
    expect(redactor.redact(loaded.accessToken.expose())).toBe("[REDACTED]");
  });

  it("returns stable config errors for missing or invalid input", () => {
    const redactor = new Redactor();
    for (const environment of [
      {},
      {
        PGDUMPSTER_PROJECT_REF: "invalid",
        PGDUMPSTER_ACCESS_TOKEN: "sbp_environment_canary_secret",
      },
    ]) {
      let captured: unknown;
      try {
        loadSourceEnvironment(environment, redactor);
      } catch (error) {
        captured = error;
      }
      expect(["CONFIG_MISSING_REQUIRED", "PROJECT_REF_INVALID"]).toContain(
        serializeError(captured, redactor).code,
      );
    }
  });
});
