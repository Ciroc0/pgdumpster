import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDirectoryArtifactSink } from "../../src/core/bundle/artifact-sink.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";
import { captureProjectState } from "../../src/supabase/management/project-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixtureFetch(): typeof fetch {
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname.endsWith("/config/disk/autoscale")) {
      return Promise.resolve(
        Response.json({
          growth_percent: null,
          min_increment_gb: null,
          max_size_gb: null,
        }),
      );
    }
    if (url.pathname.endsWith("/billing/addons")) {
      return Promise.resolve(
        Response.json({ selected_addons: [], available_addons: [] }),
      );
    }
    if (url.pathname.endsWith("/jit-access")) {
      return Promise.resolve(
        Response.json({
          state: "unavailable",
          unavailableReason: "ssl_enforcement_required",
        }),
      );
    }
    if (url.pathname.endsWith("/branches"))
      return Promise.resolve(Response.json([]));
    if (url.pathname.endsWith("/health")) {
      expect(url.searchParams.get("services")).toContain("auth,db");
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname.endsWith("/advisors/performance")) {
      return Promise.resolve(Response.json({ lints: [] }));
    }
    if (url.pathname.endsWith("/advisors/security")) {
      expect(url.searchParams.get("lint_type")).toBe("sql");
      return Promise.resolve(Response.json({ lints: [] }));
    }
    return Promise.resolve(
      Response.json({
        id: "project-id",
        ref: "abcdefghijklmnopqrst",
        organization_id: "organization-id",
        organization_slug: "organization",
        name: "Test",
        region: "eu-west-3",
        status: "ACTIVE_HEALTHY",
        database: {
          host: "db.example.invalid",
          version: "17",
          postgres_engine: "17",
          release_channel: "ga",
        },
        created_at: "2026-08-14T00:00:00.000+00:00",
      }),
    );
  });
}

describe("project-state capture", () => {
  it("captures project surfaces and classifies disabled capabilities", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-project-state-"),
    );
    temporaryDirectories.push(root);
    const redactor = new Redactor();
    const fetch = fixtureFetch();
    const result = await captureProjectState(
      new ManagementClient({
        accessToken: new SecretValue("management-token", redactor),
        fetch,
      }),
      "abcdefghijklmnopqrst",
      await createDirectoryArtifactSink(root),
    );
    expect(result.coverage.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "project.metadata", status: "backed_up" },
      { id: "project.disk_autoscale", status: "not_configured" },
      { id: "project.addons", status: "not_configured" },
      { id: "project.jit_access", status: "not_applicable" },
      { id: "project.branches", status: "backed_up" },
      { id: "diagnostics.health", status: "backed_up" },
      { id: "diagnostics.readonly", status: "backed_up" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(8);
  });
});
