import { PgDumpsterError } from "../core/errors/error.js";

function normalizedEtag(value: string): string {
  let normalized = value.trim();
  if (/^W\//iu.test(normalized)) normalized = normalized.slice(2).trim();
  if (
    normalized.length >= 2 &&
    normalized.startsWith('"') &&
    normalized.endsWith('"')
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

export function assertStorageObjectResponseEvidence(
  expectedEtag: string | null | undefined,
  response: Response,
): void {
  if (expectedEtag === undefined || expectedEtag === null) return;
  const observedEtag = response.headers.get("etag");
  if (observedEtag === null) return;

  const expected = normalizedEtag(expectedEtag);
  const observed = normalizedEtag(observedEtag);
  if (expected.length === 0 || observed.length === 0 || expected === observed) {
    return;
  }

  throw new PgDumpsterError({
    code: "STORAGE_OBJECT_CHANGED_DURING_COPY",
    category: "consistency",
    message: "Storage object ETag changed before or during copy.",
    retryable: false,
    component: "storage.file_objects",
    details: {
      evidence: "etag",
      expectedEtag: expected,
      observedEtag: observed,
    },
  });
}
