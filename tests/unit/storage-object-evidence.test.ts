import { describe, expect, it } from "vitest";

import { assertStorageObjectResponseEvidence } from "../../src/storage/object-evidence.js";

describe("Storage object response evidence", () => {
  it("accepts exact, quoted and weak ETag representations", () => {
    expect(() =>
      assertStorageObjectResponseEvidence(
        '"abc123"',
        new Response("body", { headers: { etag: "abc123" } }),
      ),
    ).not.toThrow();
    expect(() =>
      assertStorageObjectResponseEvidence(
        "abc123",
        new Response("body", { headers: { etag: 'W/"abc123"' } }),
      ),
    ).not.toThrow();
  });

  it("fails closed when catalog and response ETags differ", () => {
    expect(() =>
      assertStorageObjectResponseEvidence(
        '"before"',
        new Response("body", { headers: { etag: '"after"' } }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_OBJECT_CHANGED_DURING_COPY",
        category: "consistency",
        component: "storage.file_objects",
        details: {
          evidence: "etag",
          expectedEtag: "before",
          observedEtag: "after",
        },
      }),
    );
  });

  it("does not invent ETag evidence when either side is unavailable", () => {
    expect(() =>
      assertStorageObjectResponseEvidence(
        undefined,
        new Response("body", { headers: { etag: '"observed"' } }),
      ),
    ).not.toThrow();
    expect(() =>
      assertStorageObjectResponseEvidence('"expected"', new Response("body")),
    ).not.toThrow();
  });
});
