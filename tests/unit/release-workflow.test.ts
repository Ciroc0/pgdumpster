import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("fails before publication when public provenance eligibility is absent", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain(
      "REPOSITORY_PRIVATE: ${{ github.event.repository.private }}",
    );
    expect(workflow).toContain('test "$REPOSITORY_PRIVATE" = "false"');
    expect(
      workflow.indexOf('test "$REPOSITORY_PRIVATE" = "false"'),
    ).toBeLessThan(
      workflow.indexOf("npm publish --provenance --access public"),
    );
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain('npm install --omit=dev "../$PACKAGE"');
    expect(workflow).toContain(
      "npm sbom --omit=dev --sbom-format cyclonedx --package-lock-only",
    );
  });
});
