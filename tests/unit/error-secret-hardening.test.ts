import { describe, expect, it } from "vitest";

import { PgDumpsterError } from "../../src/core/errors/error.js";
import { serializeError } from "../../src/core/errors/serialize.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";

describe("error and secret hardening", () => {
  it("maps unknown non-Error failures to the stable internal error", () => {
    const serialized = serializeError(
      {
        unexpected: true,
      },
      new Redactor(),
    );

    expect(serialized).toMatchObject({
      schemaVersion: 1,
      code: "INTERNAL_INVARIANT_VIOLATION",
      category: "internal",
      message: "Unexpected internal error.",
      retryable: false,
    });
  });

  it("preserves Error messages while redacting registered secrets", () => {
    const redactor = new Redactor();

    redactor.register("secret-canary-value");

    const serialized = serializeError(
      new Error("failure containing secret-canary-value"),
      redactor,
    );

    expect(serialized.code).toBe("INTERNAL_INVARIANT_VIOLATION");

    expect(serialized.message).not.toContain("secret-canary-value");
  });

  it("serializes every optional PgDumpsterError field", () => {
    const redactor = new Redactor();

    redactor.register("detail-secret");

    const serialized = serializeError(
      new PgDumpsterError({
        code: "DATABASE_DUMP_FAILED",
        category: "database",
        message: "database failure detail-secret",
        retryable: true,
        component: "database.schema",
        runId: "019ffcf4-d0b6-7b40-847b-668eb570a987",
        details: {
          nested: {
            secret: "detail-secret",
          },
        },
      }),
      redactor,
    );

    expect(serialized).toMatchObject({
      code: "DATABASE_DUMP_FAILED",
      category: "database",
      retryable: true,
      component: "database.schema",
      runId: "019ffcf4-d0b6-7b40-847b-668eb570a987",
    });

    expect(JSON.stringify(serialized)).not.toContain("detail-secret");
  });

  it("rejects empty secret values", () => {
    expect(() => new SecretValue("", new Redactor())).toThrow(
      "Secret value cannot be empty",
    );
  });

  it("exposes secrets only explicitly and redacts coercion", () => {
    const secret = new SecretValue("private-value", new Redactor());

    expect(secret.expose()).toBe("private-value");

    expect(secret.toString()).toBe("[REDACTED]");

    expect(
      JSON.stringify({
        secret,
      }),
    ).not.toContain("private-value");
  });
});
