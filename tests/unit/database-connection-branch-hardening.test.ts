import { describe, expect, it } from "vitest";

import { postgresConnectionWithoutPassword } from "../../src/database/connection.js";

describe("database connection hardening", () => {
  it("rejects a syntactically invalid URL", () => {
    expect(() => postgresConnectionWithoutPassword("not a URL")).toThrow();

    try {
      postgresConnectionWithoutPassword("not a URL");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CONFIG_INVALID",
      });
    }
  });

  it("rejects non-PostgreSQL protocols", () => {
    expect(() =>
      postgresConnectionWithoutPassword(
        "https://user:pass@example.invalid/database",
      ),
    ).toThrow("must include PostgreSQL protocol");
  });

  it("rejects missing username or password", () => {
    for (const value of [
      "postgresql://example.invalid/postgres",
      "postgresql://postgres@example.invalid/postgres",
    ]) {
      expect(() => postgresConnectionWithoutPassword(value)).toThrow(
        "must include PostgreSQL protocol",
      );
    }
  });

  it("rejects malformed percent-encoding in the password", () => {
    expect(() =>
      postgresConnectionWithoutPassword(
        "postgresql://postgres:%E0%A4%A@example.invalid/postgres",
      ),
    ).toThrow("invalid encoded password");
  });

  it("accepts postgres: and decodes the password without retaining it in the safe URL", () => {
    const result = postgresConnectionWithoutPassword(
      "postgres://postgres:p%40ss%20word@example.invalid/postgres?sslmode=require",
    );

    expect(result.password).toBe("p@ss word");

    expect(result.safeUrl).not.toContain("p%40ss");

    expect(result.safeUrl).toContain(
      "postgres://postgres@example.invalid/postgres",
    );
  });
});
