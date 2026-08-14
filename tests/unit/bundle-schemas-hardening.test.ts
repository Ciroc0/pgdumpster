import { describe, expect, it } from "vitest";

import {
  coverageDocumentSchema,
  coverageEntrySchema,
} from "../../src/core/bundle/schemas.js";

function entry(
  status:
    | "backed_up"
    | "not_configured"
    | "not_applicable"
    | "not_exportable"
    | "failed",
  reasonCode?: string,
) {
  return {
    id: "database.schema",
    status,
    sensitivity: "internal",
    artifacts: [],
    ...(reasonCode === undefined
      ? {}
      : {
          reasonCode,
        }),
  };
}

describe("bundle coverage schema hardening", () => {
  it("requires reason codes for not_exportable and failed outcomes", () => {
    expect(coverageEntrySchema.safeParse(entry("not_exportable")).success).toBe(
      false,
    );

    expect(coverageEntrySchema.safeParse(entry("failed")).success).toBe(false);
  });

  it("accepts reason-coded exceptional outcomes", () => {
    expect(
      coverageEntrySchema.safeParse(entry("not_exportable", "PLATFORM_LIMIT"))
        .success,
    ).toBe(true);

    expect(
      coverageEntrySchema.safeParse(entry("failed", "BACKUP_FAILED")).success,
    ).toBe(true);
  });

  it("does not require reasons for ordinary outcomes", () => {
    for (const status of [
      "backed_up",
      "not_configured",
      "not_applicable",
    ] as const) {
      expect(coverageEntrySchema.safeParse(entry(status)).success).toBe(true);
    }
  });

  it("requires at least one coverage component", () => {
    expect(
      coverageDocumentSchema.safeParse({
        formatVersion: "1.0.0",
        components: [],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown coverage fields", () => {
    expect(
      coverageEntrySchema.safeParse({
        ...entry("backed_up"),
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
