import { z } from "zod";

import { writeFileAtomic } from "../../utils/atomic-file.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import { PgDumpsterError } from "../errors/error.js";
import {
  restorePlanSha256,
  type RestoreActionEvidence,
  type RestoreExecutionResult,
} from "./executor.js";
import {
  restorePlanSchema,
  type RestoreAction,
  type RestorePlan,
} from "./plan.js";

const verificationSchema = z.enum([
  "applied_and_verified",
  "resume_reverified",
  "resume_recovered",
]);

const parityActionSchema = z
  .object({
    id: z.string().regex(/^restore\.[a-z0-9_.-]+$/u),
    component: z.string().min(1),
    planStatus: z.enum(["planned", "skipped", "blocked_platform_limit"]),
    sourceStatus: z.enum([
      "backed_up",
      "not_configured",
      "not_applicable",
      "not_exportable",
      "failed",
    ]),
    declaredFidelity: z.enum([
      "exact",
      "semantic",
      "replacement",
      "manual",
      "not_applicable",
    ]),
    outcome: z.enum(["verified", "skipped", "platform_limit"]),
    verification: verificationSchema.optional(),
    reasonCode: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.planStatus === "planned") {
      if (action.outcome !== "verified" || action.verification === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Planned parity actions require verified execution evidence.",
        });
      }
      if (
        action.declaredFidelity === "manual" ||
        action.declaredFidelity === "not_applicable"
      ) {
        context.addIssue({
          code: "custom",
          message: "Planned parity actions cannot claim manual fidelity.",
        });
      }
      return;
    }
    if (action.verification !== undefined) {
      context.addIssue({
        code: "custom",
        message:
          "Non-executed parity actions cannot carry verification evidence.",
      });
    }
    if (action.planStatus === "skipped" && action.outcome !== "skipped") {
      context.addIssue({
        code: "custom",
        message: "Skipped plan actions must remain skipped in parity evidence.",
      });
    }
    if (
      action.planStatus === "blocked_platform_limit" &&
      (action.outcome !== "platform_limit" ||
        action.declaredFidelity !== "manual")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Platform-limited actions must remain explicit manual-fidelity limits.",
      });
    }
  });

const manualActionSchema = z
  .object({
    id: z.string().min(1),
    component: z.string().min(1),
    reasonCode: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const restoreParityReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    planCreatedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    backupOperationId: z.string().uuid(),
    sourceProjectRef: z.string().regex(/^[a-z]{20}$/u),
    sourceBackupResult: z.enum(["complete", "complete_with_platform_limits"]),
    targetProjectRef: z.string().regex(/^[a-z]{20}$/u),
    status: z.enum(["restored", "restored_with_platform_limits"]),
    actions: z.array(parityActionSchema).min(1),
    manualActions: z.array(manualActionSchema),
  })
  .strict();

export type RestoreParityReport = z.infer<typeof restoreParityReportSchema>;

function evidenceError(component?: string): never {
  throw new PgDumpsterError({
    code: "RESTORE_PARITY_EVIDENCE_INVALID",
    category: "consistency",
    message:
      "Restore parity evidence does not match the immutable restore plan.",
    retryable: false,
    ...(component === undefined ? {} : { component }),
  });
}

function successfulOutcome(
  action: RestoreAction,
): RestoreActionEvidence["outcome"] {
  if (action.status === "planned") return "verified";
  if (action.status === "skipped") return "skipped";
  if (action.status === "blocked_platform_limit") return "platform_limit";
  return evidenceError(action.component);
}

function expectedStatus(plan: RestorePlan): RestoreExecutionResult["status"] {
  return plan.manualActions.length > 0 ||
    plan.actions.some(({ status }) => status === "blocked_platform_limit")
    ? "restored_with_platform_limits"
    : "restored";
}

function assertResultMatchesPlan(
  plan: RestorePlan,
  result: RestoreExecutionResult,
): void {
  const immutablePlanSha256 = restorePlanSha256(plan);
  if (
    result.planId !== plan.planId ||
    result.planSha256 !== immutablePlanSha256 ||
    result.backupOperationId !== plan.source.backupOperationId ||
    result.sourceProjectRef !== plan.source.projectRef ||
    result.targetProjectRef !== plan.target.projectRef ||
    result.status !== expectedStatus(plan) ||
    canonicalJson(result.manualActions) !== canonicalJson(plan.manualActions) ||
    result.actionEvidence.length !== plan.actions.length
  ) {
    evidenceError();
  }

  let completedActions = 0;
  let skippedActions = 0;
  for (const [index, action] of plan.actions.entries()) {
    const evidence = result.actionEvidence[index];
    const outcome = successfulOutcome(action);
    if (
      evidence === undefined ||
      evidence.id !== action.id ||
      evidence.component !== action.component ||
      evidence.planStatus !== action.status ||
      evidence.sourceStatus !== action.sourceStatus ||
      evidence.declaredFidelity !== action.fidelity ||
      evidence.outcome !== outcome ||
      evidence.reasonCode !== action.reasonCode ||
      (outcome === "verified") !== (evidence.verification !== undefined)
    ) {
      evidenceError(action.component);
    }
    if (outcome === "verified") completedActions += 1;
    if (outcome === "skipped") skippedActions += 1;
  }
  if (
    result.completedActions !== completedActions ||
    result.skippedActions !== skippedActions
  ) {
    evidenceError();
  }
}

export function createRestoreParityReport(
  inputPlan: RestorePlan,
  result: RestoreExecutionResult,
): RestoreParityReport {
  const plan = restorePlanSchema.parse(inputPlan);
  assertResultMatchesPlan(plan, result);
  return restoreParityReportSchema.parse({
    schemaVersion: 1,
    planId: plan.planId,
    planSha256: result.planSha256,
    planCreatedAt: plan.createdAt,
    completedAt: result.completedAt,
    backupOperationId: plan.source.backupOperationId,
    sourceProjectRef: plan.source.projectRef,
    sourceBackupResult: plan.source.backupResult,
    targetProjectRef: plan.target.projectRef,
    status: result.status,
    actions: result.actionEvidence,
    manualActions: result.manualActions,
  });
}

export async function writeRestoreParityReport(
  filename: string,
  report: unknown,
  signal?: AbortSignal,
): Promise<void> {
  await writeFileAtomic(
    filename,
    canonicalJson(restoreParityReportSchema.parse(report)),
    {
      mode: 0o600,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}
