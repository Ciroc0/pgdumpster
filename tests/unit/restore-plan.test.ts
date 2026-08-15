import { describe, expect, it } from "vitest";

import {
  coverageDocumentSchema,
  manifestSchema,
} from "../../src/core/bundle/schemas.js";
import { loadCoverageRegistry } from "../../src/core/coverage/registry.js";
import {
  buildRestorePlan,
  restorePlanSchema,
} from "../../src/core/restore/plan.js";

async function source() {
  const registry = await loadCoverageRegistry();
  const coverage = coverageDocumentSchema.parse({
    formatVersion: "1.0.0",
    components: registry.components.map((component) => {
      if (component.id === "auth.signing_keys") {
        return {
          id: component.id,
          status: "not_exportable",
          reasonCode: "private_signing_material_not_exposed",
          sensitivity: component.sensitivity,
          artifacts: ["secrets/auth-signing-keys.json"],
        };
      }
      const backedUp = [
        "database.extensions",
        "database.roles",
        "database.schema",
        "database.data",
        "storage.file_buckets",
        "storage.file_metadata",
        "storage.file_objects",
        "project.addons",
      ].includes(component.id);
      return {
        id: component.id,
        status: backedUp ? "backed_up" : "not_configured",
        sensitivity: component.sensitivity,
        artifacts: backedUp ? [`payload/${component.id}.json`] : [],
      };
    }),
  });
  const manifest = manifestSchema.parse({
    formatVersion: "1.0.0",
    tool: { name: "pgdumpster", version: "1.0.0" },
    operation: {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
    },
    source: { projectRef: "abcdefghijklmnopqrst" },
    result: {
      status: "complete_with_platform_limits",
      consistency: "best_effort",
    },
    coverageFile: "coverage.json",
    checksumFile: "checksums.sha256",
    checksumFileSha256: "0".repeat(64),
    components: coverage.components.map(({ id, status }) => ({ id, status })),
    statistics: { files: 10, bytes: 100 },
  });
  return { manifest, coverage };
}

describe("restore planning", () => {
  it("builds a deterministic dependency plan and preserves platform limits", async () => {
    const { manifest, coverage } = await source();
    const plan = await buildRestorePlan(manifest, coverage, {
      planId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-14T02:00:00.000Z",
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      conflictPolicy: "fail",
      allowBillableResources: true,
    });

    expect(restorePlanSchema.parse(plan)).toEqual(plan);
    expect(plan.actions).toHaveLength(55);
    expect(plan.status).toBe("ready_with_platform_limits");
    expect(
      plan.actions.find(({ component }) => component === "database.schema"),
    ).toMatchObject({
      status: "planned",
      dependsOn: ["restore.database.roles"],
    });
    expect(
      plan.actions.find(({ component }) => component === "auth.signing_keys"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      fidelity: "manual",
    });
    expect(plan.manualActions[0]?.message).toContain("tokens or sessions");

    const fileObjectsIndex = plan.actions.findIndex(
      ({ component }) => component === "storage.file_objects",
    );
    const fileMetadataIndex = plan.actions.findIndex(
      ({ component }) => component === "storage.file_metadata",
    );
    expect(plan.actions[fileObjectsIndex]).toMatchObject({
      phase: 11,
      operation: "stream_file_objects",
      risk: "mutation",
      dependsOn: ["restore.storage.file_buckets"],
    });
    expect(plan.actions[fileMetadataIndex]).toMatchObject({
      phase: 12,
      operation: "verify_file_metadata",
      risk: "inspection",
      dependsOn: ["restore.storage.file_objects"],
    });
    expect(fileObjectsIndex).toBeLessThan(fileMetadataIndex);
  });

  it("blocks billable actions without opt-in", async () => {
    const { manifest, coverage } = await source();
    const plan = await buildRestorePlan(manifest, coverage, {
      planId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-14T02:00:00.000Z",
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      conflictPolicy: "fail",
      allowBillableResources: false,
    });

    expect(plan.status).toBe("blocked");
    expect(
      plan.actions.find(({ component }) => component === "project.addons"),
    ).toMatchObject({
      billable: true,
      status: "blocked_by_policy",
      reasonCode: "billable_resource_opt_in_required",
    });
  });

  it("marks mutating replace actions destructive while metadata parity remains inspection-only", async () => {
    const { manifest, coverage } = await source();
    const plan = await buildRestorePlan(manifest, coverage, {
      planId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-14T02:00:00.000Z",
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      conflictPolicy: "replace",
      allowBillableResources: true,
    });

    expect(
      plan.actions.find(({ component }) => component === "storage.file_objects"),
    ).toMatchObject({ risk: "destructive" });
    expect(
      plan.actions.find(({ component }) => component === "storage.file_metadata"),
    ).toMatchObject({ risk: "inspection" });
  });

  it("propagates non-exportable prerequisites so dependent work is manual instead of executor-invalid", async () => {
    const { manifest, coverage } = await source();
    const edgeSecrets = coverage.components.find(
      ({ id }) => id === "edge.secrets",
    )!;
    edgeSecrets.status = "not_exportable";
    edgeSecrets.reasonCode = "edge_secret_digest_only";
    edgeSecrets.artifacts = ["secrets/edge-secret-digests.json"];
    const edgeFunctions = coverage.components.find(
      ({ id }) => id === "edge.functions",
    )!;
    edgeFunctions.status = "backed_up";
    edgeFunctions.artifacts = [
      "functions/index.json",
      "functions/example/source.multipart",
    ];

    const plan = await buildRestorePlan(manifest, coverage, {
      planId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-14T02:00:00.000Z",
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      conflictPolicy: "fail",
      allowBillableResources: true,
    });

    expect(plan.status).toBe("ready_with_platform_limits");
    expect(
      plan.actions.find(({ component }) => component === "edge.secrets"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      reasonCode: "edge_secret_digest_only",
    });
    expect(
      plan.actions.find(({ component }) => component === "edge.functions"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      risk: "manual",
      fidelity: "manual",
      reasonCode: "dependency_platform_limit",
    });
    expect(
      plan.manualActions.find(({ component }) => component === "edge.functions")
        ?.message,
    ).toContain("edge.secrets");
  });

  it("refuses an in-place target", async () => {
    const { manifest, coverage } = await source();
    await expect(
      buildRestorePlan(manifest, coverage, {
        planId: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-08-14T02:00:00.000Z",
        targetProjectRef: "abcdefghijklmnopqrst",
        conflictPolicy: "fail",
        allowBillableResources: false,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_SOURCE_TARGET_SAME" });
  });

  it("turns an exactly captured but non-identically-restorable source into a manual limit", async () => {
    const { manifest, coverage } = await source();
    const vault = coverage.components.find(
      ({ id }) => id === "database.vault_data",
    )!;
    vault.status = "backed_up";
    vault.artifacts = ["database/vault-data.sql"];
    vault.sourceContract = {
      captureFidelity: "exact_ciphertext_rows",
      restoreFidelity: "not_identically_restorable",
    };
    const plan = await buildRestorePlan(manifest, coverage, {
      planId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-08-14T02:00:00.000Z",
      targetProjectRef: "zyxwvutsrqponmlkjihg",
      conflictPolicy: "fail",
      allowBillableResources: true,
    });

    expect(
      plan.actions.find(({ component }) => component === "database.vault_data"),
    ).toMatchObject({
      status: "blocked_platform_limit",
      fidelity: "manual",
      reasonCode: "source_not_identically_restorable",
    });
    expect(
      plan.manualActions.find(
        ({ component }) => component === "database.vault_data",
      )?.message,
    ).toContain("vault.secrets");
  });
});
