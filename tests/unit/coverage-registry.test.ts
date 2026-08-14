import { describe, expect, it } from "vitest";

import {
  deriveBackupResult,
  validateCoverageOutcomes,
} from "../../src/core/coverage/result.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";

describe("coverage registry", () => {
  it("loads the canonical registry with unique component IDs", async () => {
    const registry = await loadCoverageRegistry();
    expect(registry.product).toBe("pgdumpster");
    expect(registry.components).toHaveLength(55);
    expect(new Set(registry.components.map(({ id }) => id))).toHaveLength(55);
  });

  it("derives result semantics without allowing a component to disappear", async () => {
    const registry = await loadCoverageRegistry();
    const outcomes = registry.components.map(({ id }) => ({
      id,
      status: "backed_up" as const,
    }));

    expect(deriveBackupResult(registry, outcomes)).toBe("complete");
    expect(
      deriveBackupResult(registry, [
        ...outcomes.slice(0, -1),
        { id: outcomes.at(-1)!.id, status: "not_exportable" },
      ]),
    ).toBe("complete_with_platform_limits");
    expect(
      deriveBackupResult(registry, [
        { id: outcomes[0]!.id, status: "failed" },
        ...outcomes.slice(1),
      ]),
    ).toBe("failed");
    expect(() => {
      validateCoverageOutcomes(registry, outcomes.slice(1));
    }).toThrow(/Missing coverage outcomes/u);
  });

  it("rejects unknown and duplicate outcomes", async () => {
    const registry = await loadCoverageRegistry();
    const outcomes = registry.components.map(({ id }) => ({
      id,
      status: "not_applicable" as const,
    }));

    expect(() => {
      validateCoverageOutcomes(registry, [
        ...outcomes,
        { id: "unknown.surface", status: "failed" },
      ]);
    }).toThrow(/Unknown coverage component/u);
    expect(() => {
      validateCoverageOutcomes(registry, [...outcomes, outcomes[0]!]);
    }).toThrow(/Duplicate coverage outcome/u);
  });
});
