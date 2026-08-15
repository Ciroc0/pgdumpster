import { z } from "zod";

import type { CoverageDocument, Manifest } from "../bundle/schemas.js";
import { loadCoverageRegistry } from "../coverage/registry.js";
import { PgDumpsterError } from "../errors/error.js";

const projectRefSchema = z.string().regex(/^[a-z0-9]{20}$/u);
const actionStatusSchema = z.enum([
  "planned",
  "skipped",
  "blocked_by_policy",
  "blocked_platform_limit",
  "blocked_source_failure",
]);

export const restoreActionSchema = z
  .object({
    id: z.string().regex(/^restore\.[a-z0-9_.-]+$/u),
    component: z.string().min(1),
    phase: z.number().int().min(1).max(21),
    operation: z.string().min(1),
    risk: z.enum(["none", "inspection", "mutation", "destructive", "manual"]),
    billable: z.boolean(),
    dependsOn: z.string().array(),
    status: actionStatusSchema,
    sourceStatus: z.enum([
      "backed_up",
      "not_configured",
      "not_applicable",
      "not_exportable",
      "failed",
    ]),
    restorePolicy: z.string().min(1),
    fidelity: z.enum([
      "exact",
      "semantic",
      "replacement",
      "manual",
      "not_applicable",
    ]),
    artifacts: z.string().array(),
    reasonCode: z.string().min(1).optional(),
  })
  .strict();

export const restorePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    source: z
      .object({
        projectRef: projectRefSchema,
        backupOperationId: z.string().uuid(),
        backupResult: z.enum(["complete", "complete_with_platform_limits"]),
      })
      .strict(),
    target: z.object({ projectRef: projectRefSchema }).strict(),
    conflictPolicy: z.enum(["fail", "replace"]),
    allowBillableResources: z.boolean(),
    status: z.enum(["ready", "ready_with_platform_limits", "blocked"]),
    actions: restoreActionSchema.array().min(1),
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

export type RestorePlan = z.infer<typeof restorePlanSchema>;
export type RestoreAction = z.infer<typeof restoreActionSchema>;

export interface BuildRestorePlanOptions {
  planId: string;
  createdAt: string;
  targetProjectRef: string;
  conflictPolicy: "fail" | "replace";
  allowBillableResources: boolean;
}

const BILLABLE = new Set([
  "database.backup_schedule",
  "domains.custom_hostname",
  "domains.vanity_subdomain",
  "network.private_link",
  "project.addons",
  "project.disk_autoscale",
  "project.read_replicas",
]);

const INSPECTION_ONLY = new Set([
  "diagnostics.health",
  "diagnostics.readonly",
  "project.branches",
  "project.metadata",
]);

const EXACT = new Set(["database.vault_root_key", "storage.file_objects"]);

function sourceRestoreIsNonIdentical(
  source: CoverageDocument["components"][number],
): boolean {
  return (
    source.sourceContract?.["restoreFidelity"] === "not_identically_restorable"
  );
}

const DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "database.vault_root_key": ["database.extensions"],
  "database.roles": ["database.extensions"],
  "database.schema": ["database.roles"],
  "database.data": ["database.schema"],
  "auth.data": ["database.data"],
  "database.vault_data": ["database.data", "database.vault_root_key"],
  "database.cron": ["database.data", "database.extensions"],
  "database.queues": ["database.data", "database.extensions"],
  "database.webhooks": ["database.schema", "database.extensions"],
  "database.extension_state": ["database.data", "database.extensions"],
  "database.migrations": ["database.data"],
  "database.auth_storage_customizations": ["database.data"],
  "database.publications": ["database.data"],
  "storage.file_buckets": ["database.data", "storage.service_config"],
  "storage.file_objects": ["storage.file_buckets"],
  "storage.file_metadata": ["storage.file_objects"],
  "storage.vector_indexes": ["storage.vector_buckets"],
  "storage.vectors": ["storage.vector_indexes"],
  "storage.analytics_data": ["storage.analytics_catalog"],
  "edge.functions": ["edge.secrets"],
  "auth.config": ["auth.data"],
  "auth.sso": ["auth.config"],
  "auth.tpa": ["auth.config"],
  "auth.signing_keys": ["auth.config"],
  "auth.legacy_signing_key": ["auth.config"],
  "realtime.config": ["database.publications"],
  "rest.postgrest_config": ["database.data"],
  "network.restrictions": ["database.data", "rest.postgrest_config"],
  "domains.custom_hostname": ["network.restrictions"],
  "domains.vanity_subdomain": ["network.restrictions"],
  "network.private_link": ["network.restrictions"],
};

function phase(component: string): number {
  if (component === "database.extensions") return 2;
  if (component === "database.vault_root_key") return 3;
  if (component === "database.roles") return 4;
  if (component === "database.schema") return 5;
  if (component === "database.data") return 6;
  if (
    component === "auth.data" ||
    [
      "database.cron",
      "database.extension_state",
      "database.queues",
      "database.vault_data",
      "database.webhooks",
    ].includes(component)
  )
    return 7;
  if (
    component === "database.migrations" ||
    component === "database.auth_storage_customizations"
  )
    return 8;
  if (component === "database.publications") return 9;
  if (
    component === "storage.service_config" ||
    component === "storage.file_buckets"
  )
    return 10;
  if (component === "storage.file_objects") return 11;
  if (
    component === "storage.file_metadata" ||
    component.startsWith("storage.vector") ||
    component.startsWith("storage.analytics")
  )
    return 12;
  if (component === "edge.secrets") return 13;
  if (component === "edge.functions") return 14;
  if (
    component === "auth.config" ||
    component === "auth.sso" ||
    component === "auth.tpa"
  )
    return 15;
  if (component.startsWith("auth.") && component.includes("signing")) return 16;
  if (component.startsWith("api.")) return 17;
  if (["realtime.config", "rest.postgrest_config"].includes(component))
    return 18;
  if (component.startsWith("network.") || component.startsWith("domains."))
    return 19;
  if (BILLABLE.has(component) || component.startsWith("project.")) return 20;
  return 1;
}

function operation(component: string): string {
  if (INSPECTION_ONLY.has(component)) return "compare_inventory";
  if (component.startsWith("external.")) return "manual_external_action";
  if (component === "database.vault_root_key") return "apply_vault_root_key";
  if (component.startsWith("database.") || component === "auth.data")
    return "apply_logical_database_state";
  if (component === "storage.file_buckets")
    return "create_or_update_file_buckets";
  if (component === "storage.file_objects") return "stream_file_objects";
  if (component === "storage.file_metadata") return "verify_file_metadata";
  if (component === "storage.vector_buckets") return "create_vector_buckets";
  if (component === "storage.vector_indexes") return "create_vector_indexes";
  if (component === "storage.vectors") return "put_vectors";
  if (component.startsWith("storage.analytics")) return "restore_iceberg_state";
  if (component === "edge.secrets") return "apply_edge_secrets";
  if (component === "edge.functions") return "deploy_edge_functions";
  if (component === "api.modern_keys") return "create_replacement_api_keys";
  if (component.startsWith("auth.")) return "apply_auth_configuration";
  return "apply_control_plane_configuration";
}

function manualMessage(component: string, reasonCode: string): string {
  if (
    component === "auth.signing_keys" ||
    component === "auth.legacy_signing_key"
  )
    return "Exact signing continuity is unavailable; existing tokens or sessions may require rotation or reauthentication.";
  if (component === "api.modern_keys")
    return "Target-generated API keys require a protected rotation mapping and consumer updates.";
  if (component === "database.vault_data")
    return "Ciphertext rows are preserved exactly, but the current logical target role cannot insert into vault.secrets; use a Supabase physical restore/clone flow or recreate secrets with an explicit ID mapping.";
  if (component.startsWith("external."))
    return "The external provider resource must be recreated or updated outside Supabase.";
  return `Manual action is required because ${reasonCode}.`;
}

function propagatePlatformLimits(
  actions: RestoreAction[],
  manualActions: RestorePlan["manualActions"],
): void {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const manualIds = new Set(manualActions.map(({ id }) => id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const action of actions) {
      if (action.status !== "planned") continue;
      const blockedDependency = action.dependsOn
        .map((id) => byId.get(id))
        .find((dependency) => dependency?.status === "blocked_platform_limit");
      if (blockedDependency === undefined) continue;
      action.status = "blocked_platform_limit";
      action.risk = "manual";
      action.fidelity = "manual";
      action.reasonCode = "dependency_platform_limit";
      const manualId = `manual.${action.component}`;
      if (!manualIds.has(manualId)) {
        manualIds.add(manualId);
        manualActions.push({
          id: manualId,
          component: action.component,
          reasonCode: "dependency_platform_limit",
          message: `Automatic restore is blocked until ${blockedDependency.component} is resolved manually.`,
        });
      }
      changed = true;
    }
  }
}

export async function buildRestorePlan(
  manifest: Manifest,
  coverage: CoverageDocument,
  options: BuildRestorePlanOptions,
): Promise<RestorePlan> {
  if (manifest.result.status === "failed") {
    throw new PgDumpsterError({
      code: "RESTORE_SOURCE_BACKUP_FAILED",
      category: "restore_policy",
      message: "A failed backup cannot be used for a standard restore.",
      retryable: false,
    });
  }
  const targetProjectRef = projectRefSchema.parse(options.targetProjectRef);
  if (manifest.source.projectRef === targetProjectRef) {
    throw new PgDumpsterError({
      code: "RESTORE_SOURCE_TARGET_SAME",
      category: "restore_policy",
      message: "Restore target must differ from the backup source project.",
      retryable: false,
    });
  }
  const registry = await loadCoverageRegistry();
  const byId = new Map(coverage.components.map((entry) => [entry.id, entry]));
  const registryIds = new Set(registry.components.map(({ id }) => id));
  const actions: RestoreAction[] = [];
  const manualActions: RestorePlan["manualActions"] = [];
  for (const component of registry.components) {
    const source = byId.get(component.id);
    if (source === undefined) {
      throw new PgDumpsterError({
        code: "RESTORE_COVERAGE_INCOMPLETE",
        category: "integrity",
        message: "Restore source coverage is incomplete.",
        retryable: false,
        component: component.id,
      });
    }
    let status: RestoreAction["status"];
    let risk: RestoreAction["risk"] = "mutation";
    let fidelity: RestoreAction["fidelity"] =
      component.exact_restore_may_be_impossible
        ? "replacement"
        : EXACT.has(component.id)
          ? "exact"
          : "semantic";
    let reasonCode = source.reasonCode;
    if (
      source.status === "not_configured" ||
      source.status === "not_applicable"
    ) {
      status = "skipped";
      risk = "none";
      fidelity = "not_applicable";
    } else if (source.status === "not_exportable") {
      status = "blocked_platform_limit";
      risk = "manual";
      fidelity = "manual";
      reasonCode ??= "source_platform_limit";
    } else if (source.status === "failed") {
      status = "blocked_source_failure";
      risk = "none";
      reasonCode ??= "source_component_failed";
    } else if (sourceRestoreIsNonIdentical(source)) {
      status = "blocked_platform_limit";
      risk = "manual";
      fidelity = "manual";
      reasonCode ??= "source_not_identically_restorable";
    } else if (INSPECTION_ONLY.has(component.id)) {
      status = "skipped";
      risk = "inspection";
    } else if (component.id.startsWith("external.")) {
      status = "blocked_platform_limit";
      risk = "manual";
      fidelity = "manual";
      reasonCode ??= "external_resource_manual";
    } else if (BILLABLE.has(component.id) && !options.allowBillableResources) {
      status = "blocked_by_policy";
      reasonCode = "billable_resource_opt_in_required";
    } else {
      status = "planned";
      risk =
        component.id === "storage.file_metadata"
          ? "inspection"
          : options.conflictPolicy === "replace"
            ? "destructive"
            : "mutation";
    }
    const dependencies = (DEPENDENCIES[component.id] ?? [])
      .filter((id) => registryIds.has(id))
      .map((id) => `restore.${id}`)
      .sort();
    actions.push(
      restoreActionSchema.parse({
        id: `restore.${component.id}`,
        component: component.id,
        phase: phase(component.id),
        operation: operation(component.id),
        risk,
        billable: BILLABLE.has(component.id),
        dependsOn: dependencies,
        status,
        sourceStatus: source.status,
        restorePolicy: component.restore_policy,
        fidelity,
        artifacts: source.artifacts,
        ...(reasonCode === undefined ? {} : { reasonCode }),
      }),
    );
    if (status === "blocked_platform_limit") {
      manualActions.push({
        id: `manual.${component.id}`,
        component: component.id,
        reasonCode: reasonCode!,
        message: manualMessage(component.id, reasonCode!),
      });
    }
  }
  actions.sort(
    (left, right) =>
      left.phase - right.phase ||
      left.component.localeCompare(right.component, "en"),
  );
  propagatePlatformLimits(actions, manualActions);
  const blocked = actions.some(({ status }) =>
    ["blocked_by_policy", "blocked_source_failure"].includes(status),
  );
  return restorePlanSchema.parse({
    schemaVersion: 1,
    planId: options.planId,
    createdAt: options.createdAt,
    source: {
      projectRef: manifest.source.projectRef,
      backupOperationId: manifest.operation.id,
      backupResult: manifest.result.status,
    },
    target: { projectRef: targetProjectRef },
    conflictPolicy: options.conflictPolicy,
    allowBillableResources: options.allowBillableResources,
    status: blocked
      ? "blocked"
      : manualActions.length > 0
        ? "ready_with_platform_limits"
        : "ready",
    actions,
    manualActions,
  });
}
