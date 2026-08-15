import { describe, expect, it } from "vitest";

import {
  coverageDocumentSchema,
  manifestSchema,
} from "../../src/core/bundle/schemas.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import { buildRestorePlan } from "../../src/core/restore/plan.js";

const options = {
  planId: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-08-15T04:00:00.000Z",
  targetProjectRef: "zyxwvutsrqponmlkjihg",
  conflictPolicy: "fail" as const,
  allowBillableResources: true,
};

async function source() {
  const registry = await loadCoverageRegistry();
  const coverage = coverageDocumentSchema.parse({
    formatVersion: "1.0.0",
    components: registry.components.map((component) => ({
      id: component.id,
      status: "not_configured",
      sensitivity: component.sensitivity,
      artifacts: [],
    })),
  });
  const manifest = manifestSchema.parse({
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: "1.0.0" },
    operation: {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-15T03:00:00.000Z",
      completedAt: "2026-08-15T03:01:00.000Z",
    },
    source: { projectRef: "abcdefghijklmnopqrst" },
    result: { status: "complete", consistency: "verified" },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    checksumFileSha256: "0".repeat(64),
    components: coverage.components.map(({ id, status }) => ({ id, status })),
    statistics: { files: 1, bytes: 1 },
  });
  return { manifest, coverage };
}

function component(
  coverage: Awaited<ReturnType<typeof source>>["coverage"],
  id: string,
) {
  return coverage.components.find((entry) => entry.id === id)!;
}

describe("restore plan branch margin", () => {
  it("refuses a failed source backup before planning", async () => {
    const { manifest, coverage } = await source();
    manifest.result.status = "failed";
    await expect(
      buildRestorePlan(manifest, coverage, options),
    ).rejects.toMatchObject({
      code: "RESTORE_SOURCE_BACKUP_FAILED",
    });
  });

  it("fails closed when the source coverage omits a registry component", async () => {
    const { manifest, coverage } = await source();
    coverage.components.pop();
    await expect(
      buildRestorePlan(manifest, coverage, options),
    ).rejects.toMatchObject({
      code: "RESTORE_COVERAGE_INCOMPLETE",
    });
  });

  it("distinguishes not-applicable from not-configured source state", async () => {
    const { manifest, coverage } = await source();
    component(coverage, "database.extensions").status = "not_applicable";
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(
      plan.actions.find(({ component: id }) => id === "database.extensions"),
    ).toMatchObject({
      status: "skipped",
      risk: "none",
      fidelity: "not_applicable",
      sourceStatus: "not_applicable",
    });
  });

  it("blocks the plan when a source component failed", async () => {
    const { manifest, coverage } = await source();
    component(coverage, "database.extensions").status = "failed";
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(plan.status).toBe("blocked");
    expect(
      plan.actions.find(({ component: id }) => id === "database.extensions"),
    ).toMatchObject({
      status: "blocked_source_failure",
      reasonCode: "source_component_failed",
    });
  });

  it("keeps backed-up diagnostics inspection-only", async () => {
    const { manifest, coverage } = await source();
    const diagnostics = component(coverage, "diagnostics.health");
    diagnostics.status = "backed_up";
    diagnostics.artifacts = ["diagnostics/health.json"];
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(
      plan.actions.find(({ component: id }) => id === "diagnostics.health"),
    ).toMatchObject({
      status: "skipped",
      risk: "inspection",
      operation: "compare_inventory",
    });
  });

  it("turns configured external resources into explicit manual actions", async () => {
    const { manifest, coverage } = await source();
    const external = component(coverage, "external.dns");
    external.status = "backed_up";
    external.artifacts = ["project/external-dns.json"];
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(plan.status).toBe("ready_with_platform_limits");
    expect(
      plan.actions.find(({ component: id }) => id === "external.dns"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      operation: "manual_external_action",
      reasonCode: "external_resource_manual",
    });
    expect(
      plan.manualActions.find(({ component: id }) => id === "external.dns")
        ?.message,
    ).toContain("outside Supabase");
  });

  it("uses the protected rotation message for modern API keys", async () => {
    const { manifest, coverage } = await source();
    const keys = component(coverage, "api.modern_keys");
    keys.status = "not_exportable";
    keys.reasonCode = "private_key_material_not_exportable";
    keys.artifacts = ["secrets/api-keys.json"];
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(
      plan.manualActions.find(({ component: id }) => id === "api.modern_keys")
        ?.message,
    ).toContain("protected rotation mapping");
  });

  it("uses the generic manual explanation for other platform limits", async () => {
    const { manifest, coverage } = await source();
    const analytics = component(coverage, "storage.analytics_data");
    analytics.status = "not_exportable";
    analytics.reasonCode = "analytics_export_unavailable";
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(
      plan.manualActions.find(
        ({ component: id }) => id === "storage.analytics_data",
      )?.message,
    ).toContain("analytics_export_unavailable");
  });

  it("turns metadata-only Analytics capture into an explicit manual limit", async () => {
    const { manifest, coverage } = await source();
    const catalog = component(coverage, "storage.analytics_catalog");
    catalog.status = "backed_up";
    catalog.artifacts = ["storage/analytics-buckets.json"];
    catalog.reasonCode = "analytics_s3_data_export_required";
    catalog.sourceContract = {
      restoreFidelity: "not_identically_restorable",
    };
    const data = component(coverage, "storage.analytics_data");
    data.status = "not_exportable";
    data.reasonCode = "analytics_s3_data_export_required";

    const plan = await buildRestorePlan(manifest, coverage, options);

    expect(
      plan.actions.find(
        ({ component: id }) => id === "storage.analytics_catalog",
      ),
    ).toMatchObject({
      status: "blocked_platform_limit",
      reasonCode: "analytics_s3_data_export_required",
    });
    expect(
      plan.actions.find(({ component: id }) => id === "storage.analytics_data"),
    ).toMatchObject({ status: "blocked_platform_limit" });
  });

  it("returns ready when all source state is either planned or safely skipped", async () => {
    const { manifest, coverage } = await source();
    const extensions = component(coverage, "database.extensions");
    extensions.status = "backed_up";
    extensions.artifacts = ["database/extensions.json"];
    const plan = await buildRestorePlan(manifest, coverage, options);
    expect(plan.status).toBe("ready");
    expect(plan.manualActions).toEqual([]);
    expect(
      plan.actions.find(({ component: id }) => id === "database.extensions"),
    ).toMatchObject({
      status: "planned",
      risk: "mutation",
      operation: "apply_logical_database_state",
    });
  });
});
