import type { VerifiedBundle } from "./verify.js";

export interface BundleInspection {
  formatVersion: string;
  backupId: string;
  sourceProjectRef: string;
  startedAt: string;
  completedAt: string;
  status: string;
  consistency: string;
  files: number;
  bytes: number;
  platformLimitCount: number;
  failedComponentCount: number;
}

export function inspectVerifiedBundle(
  bundle: VerifiedBundle,
): BundleInspection {
  return {
    formatVersion: bundle.manifest.formatVersion,
    backupId: bundle.manifest.operation.id,
    sourceProjectRef: bundle.manifest.source.projectRef,
    startedAt: bundle.manifest.operation.startedAt,
    completedAt: bundle.manifest.operation.completedAt,
    status: bundle.manifest.result.status,
    consistency: bundle.manifest.result.consistency,
    files: bundle.manifest.statistics.files,
    bytes: bundle.manifest.statistics.bytes,
    platformLimitCount: bundle.coverage.components.filter(
      ({ status }) => status === "not_exportable",
    ).length,
    failedComponentCount: bundle.coverage.components.filter(
      ({ status }) => status === "failed",
    ).length,
  };
}
