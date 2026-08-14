import { describe, expect, it } from "vitest";

import { PgDumpsterError } from "../../src/core/errors/error.js";
import { serializeError } from "../../src/core/errors/serialize.js";
import { Redactor } from "../../src/security/redactor.js";

const CANARY = "CANARY_PGDUMPSTER_SECRET_9b92";

describe("Redactor", () => {
  it("redacts registered values recursively before error serialization", () => {
    const redactor = new Redactor();
    redactor.register(CANARY);
    const error = new PgDumpsterError({
      code: "AUTH_MANAGEMENT_API_FAILED",
      category: "auth",
      message: `Request rejected for ${CANARY}`,
      retryable: false,
      details: { nested: [CANARY, { value: CANARY }] },
    });

    const serialized = serializeError(error, redactor);
    const text = JSON.stringify(serialized);
    expect(text).not.toContain(CANARY);
    expect(text).toContain("[REDACTED]");
  });

  it.each([
    "Authorization: Bearer sbp_example_token",
    "token=sb_secret_example",
    "postgresql://postgres:password@example.invalid/postgres",
    "PGDUMPSTER_ACCESS_TOKEN=top-secret-value",
  ])("redacts known secret syntax: %s", (input) => {
    expect(new Redactor().redact(input)).not.toBe(input);
  });

  it("refuses dangerously short registered values", () => {
    expect(() => {
      new Redactor().register("abc");
    }).toThrow(/shorter than 4/u);
  });

  it("maps unknown exceptions to a stable sanitized internal error", () => {
    const serialized = serializeError(new Error("failure"), new Redactor());
    expect(serialized).toMatchObject({
      schemaVersion: 1,
      code: "INTERNAL_INVARIANT_VIOLATION",
      category: "internal",
      retryable: false,
    });
  });
});
