import { createHash } from "node:crypto";

import type { RestoreCheckpoint } from "../checkpoint/restore.js";
import {
  createRestoreCheckpoint,
  loadRestoreCheckpoint,
  transitionRestoreAction,
  writeRestoreCheckpoint,
} from "../checkpoint/restore.js";
import { PgDumpsterError } from "../errors/error.js";
import { canonicalJson } from "../../utils/canonical-json.js";
import type { RestoreAction, RestorePlan } from "./plan.js";
import { restorePlanSchema } from "./plan.js";

export interface RestoreActionContext {
  action: RestoreAction;
  attempt: number;
  signal?: AbortSignal | undefined;
}

export interface RestoreActionResult {
  fingerprint?: string | undefined;
}

export interface RestoreActionHandler {
  apply(context: RestoreActionContext): Promise<RestoreActionResult>;
  verify(
    context: Omit<RestoreActionContext, "attempt"> & {
      expectedFingerprint?: string | undefined;
    },
  ): Promise<boolean>;
}

export interface ExecuteRestoreOptions {
  plan: RestorePlan;
  checkpointPath: string;
  handlers: Readonly<Record<string, RestoreActionHandler>>;
  resume?: boolean | undefined;
  signal?: AbortSignal | undefined;
  now?: () => string;
}

export type RestoreVerificationMethod =
  | "applied_and_verified"
  | "resume_reverified"
  | "resume_recovered";

export interface RestoreActionEvidence {
  id: string;
  component: string;
  planStatus: Extract<
    RestoreAction["status"],
    "planned" | "skipped" | "blocked_platform_limit",
  >;
  sourceStatus: RestoreAction["sourceStatus"];
  declaredFidelity: RestoreAction["fidelity"];
  outcome: "verified" | "skipped" | "platform_limit";
  verification?: RestoreVerificationMethod | undefined;
  reasonCode?: string | undefined;
}

export interface RestoreExecutionResult {
  status: "restored" | "restored_with_platform_limits";
  planId: string;
  planSha256: string;
  backupOperationId: string;
  sourceProjectRef: string;
  targetProjectRef: string;
  completedAt: string;
  completedActions: number;
  skippedActions: number;
  manualActions: RestorePlan["manualActions"];
  actionEvidence: RestoreActionEvidence[];
}

export function restorePlanSha256(plan: RestorePlan): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

function failureCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted === true) return "OPERATION_CANCELLED";
  const code = (error as Partial<PgDumpsterError> | undefined)?.code;
  return typeof code === "string" && code.length > 0
    ? code
    : "RESTORE_ACTION_FAILED";
}

export function validatePlanForExecution(
  plan: RestorePlan,
  handlers: Readonly<Record<string, RestoreActionHandler>>,
): void {
  const byId = new Map(plan.actions.map((action) => [action.id, action]));
  for (const action of plan.actions) {
    if (
      action.status === "planned" &&
      handlers[action.component] === undefined
    ) {
      throw new PgDumpsterError({
        code: "RESTORE_ADAPTER_MISSING",
        category: "restore_policy",
        message: "A planned restore component has no executor.",
        retryable: false,
        component: action.component,
      });
    }
    for (const dependency of action.dependsOn) {
      const dependencyAction = byId.get(dependency);
      if (dependencyAction === undefined) {
        throw new PgDumpsterError({
          code: "RESTORE_PLAN_INVALID",
          category: "restore_policy",
          message: "Restore plan references an unknown dependency.",
          retryable: false,
          component: action.component,
        });
      }
      if (
        action.status === "planned" &&
        dependencyAction.status !== "planned" &&
        dependencyAction.status !== "skipped"
      ) {
        throw new PgDumpsterError({
          code: "RESTORE_PLAN_INVALID",
          category: "restore_policy",
          message:
            "A planned restore action depends on an action that cannot execute automatically.",
          retryable: false,
          component: action.component,
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new PgDumpsterError({
        code: "RESTORE_PLAN_INVALID",
        category: "restore_policy",
        message: "Restore plan dependency graph contains a cycle.",
        retryable: false,
      });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const action of plan.actions) visit(action.id);
}

function validateSuccessfulActionStatuses(plan: RestorePlan): void {
  const blocked = plan.actions.find(
    ({ status }) =>
      status === "blocked_by_policy" || status === "blocked_source_failure",
  );
  if (blocked !== undefined) {
    throw new PgDumpsterError({
      code: "RESTORE_PLAN_INVALID",
      category: "restore_policy",
      message:
        "A non-blocked restore plan contains an action that cannot produce successful restore evidence.",
      retryable: false,
      component: blocked.component,
    });
  }
}

function dependenciesSatisfied(
  action: RestoreAction,
  checkpoint: RestoreCheckpoint,
): boolean {
  return action.dependsOn.every((id) => {
    const dependency = checkpoint.actions.find((entry) => entry.id === id)!;
    return dependency.status === "completed" || dependency.status === "skipped";
  });
}

function finalRestoreStatus(
  plan: RestorePlan,
): RestoreExecutionResult["status"] {
  return plan.manualActions.length > 0 ||
    plan.actions.some(({ status }) => status === "blocked_platform_limit")
    ? "restored_with_platform_limits"
    : "restored";
}

function actionEvidence(
  plan: RestorePlan,
  checkpoint: RestoreCheckpoint,
  verificationMethods: ReadonlyMap<string, RestoreVerificationMethod>,
): RestoreActionEvidence[] {
  return plan.actions.map((action) => {
    const base = {
      id: action.id,
      component: action.component,
      sourceStatus: action.sourceStatus,
      declaredFidelity: action.fidelity,
      ...(action.reasonCode === undefined
        ? {}
        : { reasonCode: action.reasonCode }),
    };
    if (action.status === "planned") {
      const saved = checkpoint.actions.find(({ id }) => id === action.id)!;
      const verification = verificationMethods.get(action.id);
      if (saved.status !== "completed" || verification === undefined) {
        throw new PgDumpsterError({
          code: "RESTORE_PARITY_EVIDENCE_INVALID",
          category: "consistency",
          message:
            "A planned restore action is missing completed verification evidence.",
          retryable: false,
          component: action.component,
        });
      }
      return {
        ...base,
        planStatus: "planned" as const,
        outcome: "verified" as const,
        verification,
      };
    }
    if (action.status === "skipped") {
      return {
        ...base,
        planStatus: "skipped" as const,
        outcome: "skipped" as const,
      };
    }
    if (action.status === "blocked_platform_limit") {
      return {
        ...base,
        planStatus: "blocked_platform_limit" as const,
        outcome: "platform_limit" as const,
      };
    }
    throw new PgDumpsterError({
      code: "RESTORE_PARITY_EVIDENCE_INVALID",
      category: "consistency",
      message:
        "A successful restore result contains an unsupported action status.",
      retryable: false,
      component: action.component,
    });
  });
}

export async function executeRestore(
  options: ExecuteRestoreOptions,
): Promise<RestoreExecutionResult> {
  const plan = restorePlanSchema.parse(options.plan);
  if (plan.status === "blocked") {
    throw new PgDumpsterError({
      code: "RESTORE_PLAN_BLOCKED",
      category: "restore_policy",
      message:
        "Restore plan contains unresolved policy or source-failure blockers.",
      retryable: false,
    });
  }
  validatePlanForExecution(plan, options.handlers);
  validateSuccessfulActionStatuses(plan);
  const immutablePlanSha256 = restorePlanSha256(plan);
  const now = options.now ?? (() => new Date().toISOString());
  const verificationMethods = new Map<string, RestoreVerificationMethod>();
  let checkpoint = options.resume
    ? await loadRestoreCheckpoint(options.checkpointPath, {
        planId: plan.planId,
        planSha256: immutablePlanSha256,
        backupOperationId: plan.source.backupOperationId,
        sourceProjectRef: plan.source.projectRef,
        targetProjectRef: plan.target.projectRef,
        actionIds: plan.actions.map(({ id }) => id),
      })
    : createRestoreCheckpoint({
        planId: plan.planId,
        planSha256: immutablePlanSha256,
        backupOperationId: plan.source.backupOperationId,
        sourceProjectRef: plan.source.projectRef,
        targetProjectRef: plan.target.projectRef,
        actions: plan.actions.map(({ id, status }) => ({
          id,
          planned: status === "planned",
        })),
        now: now(),
      });
  if (!options.resume)
    await writeRestoreCheckpoint(
      options.checkpointPath,
      checkpoint,
      options.signal,
    );

  for (const action of plan.actions) {
    options.signal?.throwIfAborted();
    if (action.status !== "planned") continue;
    const saved = checkpoint.actions.find(({ id }) => id === action.id)!;
    const handler = options.handlers[action.component]!;
    if (saved.status === "completed") {
      const verified = await handler.verify({
        action,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(saved.fingerprint === undefined
          ? {}
          : { expectedFingerprint: saved.fingerprint }),
      });
      if (!verified) {
        throw new PgDumpsterError({
          code: "RESTORE_RESUME_PARITY_FAILED",
          category: "consistency",
          message:
            "A completed restore action no longer matches its checkpoint.",
          retryable: false,
          component: action.component,
        });
      }
      verificationMethods.set(action.id, "resume_reverified");
      continue;
    }
    if (
      options.resume === true &&
      (saved.status === "in_progress" || saved.status === "failed")
    ) {
      const alreadyApplied = await handler.verify({
        action,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (alreadyApplied) {
        checkpoint = transitionRestoreAction(checkpoint, {
          id: action.id,
          status: "completed",
          now: now(),
        });
        await writeRestoreCheckpoint(
          options.checkpointPath,
          checkpoint,
          options.signal,
        );
        verificationMethods.set(action.id, "resume_recovered");
        continue;
      }
    }
    if (!dependenciesSatisfied(action, checkpoint)) {
      throw new PgDumpsterError({
        code: "RESTORE_DEPENDENCY_UNSATISFIED",
        category: "restore_policy",
        message: "Restore action dependency has not completed.",
        retryable: false,
        component: action.component,
      });
    }
    checkpoint = transitionRestoreAction(checkpoint, {
      id: action.id,
      status: "in_progress",
      now: now(),
    });
    await writeRestoreCheckpoint(
      options.checkpointPath,
      checkpoint,
      options.signal,
    );
    const attempt = checkpoint.actions.find(
      ({ id }) => id === action.id,
    )!.attempts;
    try {
      const applied = await handler.apply({
        action,
        attempt,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const verified = await handler.verify({
        action,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(applied.fingerprint === undefined
          ? {}
          : { expectedFingerprint: applied.fingerprint }),
      });
      if (!verified) {
        throw new PgDumpsterError({
          code: "RESTORE_PARITY_FAILED",
          category: "consistency",
          message: "Restore action did not pass semantic verification.",
          retryable: false,
          component: action.component,
        });
      }
      checkpoint = transitionRestoreAction(checkpoint, {
        id: action.id,
        status: "completed",
        now: now(),
        ...(applied.fingerprint === undefined
          ? {}
          : { fingerprint: applied.fingerprint }),
      });
      await writeRestoreCheckpoint(
        options.checkpointPath,
        checkpoint,
        options.signal,
      );
      verificationMethods.set(action.id, "applied_and_verified");
    } catch (error) {
      checkpoint = transitionRestoreAction(checkpoint, {
        id: action.id,
        status: "failed",
        now: now(),
        failureCode: failureCode(error, options.signal),
      });
      await writeRestoreCheckpoint(options.checkpointPath, checkpoint);
      throw error;
    }
  }

  const evidence = actionEvidence(plan, checkpoint, verificationMethods);
  return {
    status: finalRestoreStatus(plan),
    planId: plan.planId,
    planSha256: immutablePlanSha256,
    backupOperationId: plan.source.backupOperationId,
    sourceProjectRef: plan.source.projectRef,
    targetProjectRef: plan.target.projectRef,
    completedAt: now(),
    completedActions: evidence.filter(({ outcome }) => outcome === "verified")
      .length,
    skippedActions: evidence.filter(({ outcome }) => outcome === "skipped")
      .length,
    manualActions: plan.manualActions,
    actionEvidence: evidence,
  };
}
