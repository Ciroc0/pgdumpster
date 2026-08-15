import { z } from "zod";

import { writeFileAtomic } from "../../utils/atomic-file.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import type { RestoreExecutionResult } from "./executor.js";
import type { RestorePlan } from "./plan.js";

export const restoreParityReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    sourceProjectRef: z.string().regex(/^[a-z0-9]{20}$/u),
    targetProjectRef: z.string().regex(/^[a-z0-9]{20}$/u),
    status: z.enum(["restored", "restored_with_platform_limits"]),
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            component: z.string().min(1),
            fidelity: z.enum([
              "exact",
              "semantic",
              "replacement",
              "manual",
              "not_applicable",
            ]),
            status: z.enum(["verified", "skipped"]),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
          })
          .strict(),
      )
      .min(1),
    manualActions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            component: z.string().min(1),
            reasonCode: z.string().min(1),
            message: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type RestoreParityReport = z.infer<typeof restoreParityReportSchema>;

export function createRestoreParityReport(
  plan: RestorePlan,
  result: RestoreExecutionResult,
): RestoreParityReport {
  return restoreParityReportSchema.parse({
    schemaVersion: 1,
    planId: plan.planId,
    sourceProjectRef: plan.source.projectRef,
    targetProjectRef: plan.target.projectRef,
    status: result.status,
    actions: result.actionEvidence,
    manualActions: result.manualActions,
  });
}

export async function writeRestoreParityReport(
  filename: string,
  report: RestoreParityReport,
): Promise<void> {
  await writeFileAtomic(filename, canonicalJson(restoreParityReportSchema.parse(report)), {
    mode: 0o600,
  });
}
