import type { CoverageRegistry, CoverageStatus } from "./registry.js";

export type BackupResultStatus =
  "complete" | "complete_with_platform_limits" | "failed";

export interface CoverageOutcome {
  id: string;
  status: CoverageStatus;
}

export function validateCoverageOutcomes(
  registry: CoverageRegistry,
  outcomes: readonly CoverageOutcome[],
): void {
  const expected = new Set(registry.components.map(({ id }) => id));
  const actual = new Set<string>();

  for (const outcome of outcomes) {
    if (!expected.has(outcome.id)) {
      throw new Error(`Unknown coverage component: ${outcome.id}`);
    }
    if (actual.has(outcome.id)) {
      throw new Error(`Duplicate coverage outcome: ${outcome.id}`);
    }
    actual.add(outcome.id);
  }

  const missing = [...expected].filter((id) => !actual.has(id));
  if (missing.length > 0) {
    throw new Error(`Missing coverage outcomes: ${missing.join(", ")}`);
  }
}

export function deriveBackupResult(
  registry: CoverageRegistry,
  outcomes: readonly CoverageOutcome[],
): BackupResultStatus {
  validateCoverageOutcomes(registry, outcomes);

  if (outcomes.some(({ status }) => status === "failed")) return "failed";
  if (outcomes.some(({ status }) => status === "not_exportable")) {
    return "complete_with_platform_limits";
  }
  return "complete";
}
