import { describe, expect, it } from "vitest";

import {
  restorePlanSha256,
  type RestoreExecutionResult,
} from "../../src/core/restore/executor.js";
import {
  createRestoreParityReport,
  restoreParityReportSchema,
} from "../../src/core/restore/parity-report.js";
import {
  restorePlanSchema,
  type RestorePlan,
} from "../../src/core/restore/plan.js";

const sourceProjectRef = "abcdefghijklmnopqrst";
const targetProjectRef = "zyxwvutsrqponmlkjihg";
const backupOperationId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const completedAt = "2026-08-16T00:00:00.000Z";

function plan(): RestorePlan {
  return restorePlanSchema.parse({
    schemaVersion: 1,
    planId,
    createdAt: "2026-08-15T23:00:00.000Z",
    source: {
      projectRef: sourceProjectRef,
      backupOperationId,
      backupResult: "complete_with_platform_limits",
    },
    target: { projectRef: targetProjectRef },
    conflictPolicy: "replace",
    allowBillableResources: false,
    status: "ready_with_platform_limits",
    actions: [
      {
        id: "restore.database.extensions",
        component: "database.extensions",
        phase: 2,
        operation: "apply_logical_database_state",
        risk: "mutation",
        billable: false,
        dependsOn: [],
        status: "planned",
        sourceStatus: "backed_up",
        restorePolicy: "restore",
        fidelity: "semantic",
        artifacts: ["database/extensions.sql"],
      },
      {
        id: "restore.diagnostics.logs",
        component: "diagnostics.logs",
        phase: 21,
        operation: "skip_diagnostic_state",
        risk: "inspection",
        billable: false,
        dependsOn: [],
        status: "skipped",
        sourceStatus: "not_applicable",
        restorePolicy: "diagnostics_only",
        fidelity: "not_applicable",
        artifacts: [],
      },
      {
        id: "restore.external.smtp_provider",
        component: "external.smtp_provider",
        phase: 21,
        operation: "manual_external_restore",
        risk: "manual",
        billable: false,
        dependsOn: [],
        status: "blocked_platform_limit",
        sourceStatus: "not_exportable",
        restorePolicy: "external",
        fidelity: "manual",
        artifacts: [],
        reasonCode: "manual_external_restore",
      },
    ],
    manualActions: [
      {
        id: "manual.external.smtp_provider",
        component: "external.smtp_provider",
        reasonCode: "manual_external_restore",
        message: "Restore the external SMTP provider outside pgDumpster.",
      },
    ],
  });
}

function resultFor(value: RestorePlan): RestoreExecutionResult {
  return {
    status: "restored_with_platform_limits",
    planId: value.planId,
    planSha256: restorePlanSha256(value),
    backupOperationId: value.source.backupOperationId,
    sourceProjectRef: value.source.projectRef,
    targetProjectRef: value.target.projectRef,
    completedAt,
    completedActions: 1,
    skippedActions: 1,
    manualActions: value.manualActions,
    actionEvidence: [
      {
        id: "restore.database.extensions",
        component: "database.extensions",
        planStatus: "planned",
        sourceStatus: "backed_up",
        declaredFidelity: "semantic",
        outcome: "verified",
        verification: "applied_and_verified",
      },
      {
        id: "restore.diagnostics.logs",
        component: "diagnostics.logs",
        planStatus: "skipped",
        sourceStatus: "not_applicable",
        declaredFidelity: "not_applicable",
        outcome: "skipped",
      },
      {
        id: "restore.external.smtp_provider",
        component: "external.smtp_provider",
        planStatus: "blocked_platform_limit",
        sourceStatus: "not_exportable",
        declaredFidelity: "manual",
        outcome: "platform_limit",
        reasonCode: "manual_external_restore",
      },
    ],
  };
}

function expectParityEvidenceError(run: () => unknown): void {
  expect(run).toThrowError(
    expect.objectContaining({ code: "RESTORE_PARITY_EVIDENCE_INVALID" }),
  );
}

describe("restore parity report branch hardening", () => {
  it("rejects invalid status, fidelity, outcome, and verification combinations", () => {
    const value = plan();
    const report = createRestoreParityReport(value, resultFor(value));
    const invalidActionSets = [
      report.actions.map((action, index) =>
        index === 0 ? { ...action, declaredFidelity: "manual" } : action,
      ),
      report.actions.map((action, index) =>
        index === 1 ? { ...action, verification: "resume_reverified" } : action,
      ),
      report.actions.map((action, index) =>
        index === 1 ? { ...action, outcome: "verified" } : action,
      ),
      report.actions.map((action, index) =>
        index === 2 ? { ...action, outcome: "skipped" } : action,
      ),
      report.actions.map((action, index) =>
        index === 2 ? { ...action, declaredFidelity: "semantic" } : action,
      ),
    ];

    for (const actions of invalidActionSets) {
      expect(
        restoreParityReportSchema.safeParse({ ...report, actions }).success,
      ).toBe(false);
    }
  });

  it("rejects every immutable execution-result identity mismatch", () => {
    const value = plan();
    const result = resultFor(value);
    const mismatches: RestoreExecutionResult[] = [
      { ...result, planId: "33333333-3333-4333-8333-333333333333" },
      { ...result, planSha256: "0".repeat(64) },
      {
        ...result,
        backupOperationId: "44444444-4444-4444-8444-444444444444",
      },
      { ...result, sourceProjectRef: "bbbbbbbbbbbbbbbbbbbb" },
      { ...result, targetProjectRef: "cccccccccccccccccccc" },
      { ...result, status: "restored" },
      { ...result, manualActions: [] },
      { ...result, actionEvidence: result.actionEvidence.slice(0, -1) },
    ];

    for (const mismatch of mismatches) {
      expectParityEvidenceError(() =>
        createRestoreParityReport(value, mismatch),
      );
    }
  });

  it("rejects every action-evidence field mismatch and inconsistent counters", () => {
    const value = plan();
    const result = resultFor(value);
    const patchFirst = (
      patch: Partial<RestoreExecutionResult["actionEvidence"][number]>,
    ): RestoreExecutionResult => ({
      ...result,
      actionEvidence: result.actionEvidence.map((evidence, index) =>
        index === 0 ? { ...evidence, ...patch } : evidence,
      ),
    });
    const mismatches: RestoreExecutionResult[] = [
      patchFirst({ id: "restore.database.roles" }),
      patchFirst({ component: "database.roles" }),
      patchFirst({ planStatus: "skipped" }),
      patchFirst({ sourceStatus: "not_configured" }),
      patchFirst({ declaredFidelity: "exact" }),
      patchFirst({ outcome: "skipped" }),
      patchFirst({ reasonCode: "unexpected_reason" }),
      patchFirst({ verification: undefined }),
      { ...result, completedActions: 0 },
      { ...result, skippedActions: 0 },
    ];

    for (const mismatch of mismatches) {
      expectParityEvidenceError(() =>
        createRestoreParityReport(value, mismatch),
      );
    }
  });

  it("fails closed if a blocked action is presented as successful parity evidence", () => {
    const value = plan();
    const blockedPlan = restorePlanSchema.parse({
      ...value,
      source: { ...value.source, backupResult: "complete" },
      status: "blocked",
      actions: [
        {
          ...value.actions[0]!,
          status: "blocked_source_failure",
          sourceStatus: "failed",
          fidelity: "not_applicable",
          reasonCode: "source_capture_failed",
        },
      ],
      manualActions: [],
    });
    const impossibleResult: RestoreExecutionResult = {
      status: "restored",
      planId: blockedPlan.planId,
      planSha256: restorePlanSha256(blockedPlan),
      backupOperationId: blockedPlan.source.backupOperationId,
      sourceProjectRef: blockedPlan.source.projectRef,
      targetProjectRef: blockedPlan.target.projectRef,
      completedAt,
      completedActions: 0,
      skippedActions: 0,
      manualActions: [],
      actionEvidence: [
        {
          id: blockedPlan.actions[0]!.id,
          component: blockedPlan.actions[0]!.component,
          planStatus: "planned",
          sourceStatus: "failed",
          declaredFidelity: "not_applicable",
          outcome: "verified",
          verification: "applied_and_verified",
          reasonCode: "source_capture_failed",
        },
      ],
    };

    expectParityEvidenceError(() =>
      createRestoreParityReport(blockedPlan, impossibleResult),
    );
  });
});
