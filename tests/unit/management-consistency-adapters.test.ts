import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/supabase/management/project-state.js", () => ({
  captureProjectState: vi.fn(),
}));
vi.mock("../../src/supabase/management/control-plane.js", () => ({
  captureControlPlaneState: vi.fn(),
}));
vi.mock("../../src/supabase/management/platform-v2.js", () => ({
  capturePlatformV2State: vi.fn(),
}));
vi.mock("../../src/supabase/management/auth.js", () => ({
  captureAuthControlPlane: vi.fn(),
}));
vi.mock("../../src/supabase/management/api-keys.js", () => ({
  captureApiKeys: vi.fn(),
}));

import {
  createApiKeysConsistencyAdapter,
  createAuthConsistencyAdapter,
  createControlPlaneConsistencyAdapter,
  createPlatformV2ConsistencyAdapter,
  createProjectStateConsistencyAdapter,
  type ManagementConsistencySnapshot,
} from "../../src/core/backup/management-consistency-adapters.js";
import type { CoverageDocument } from "../../src/core/bundle/schemas.js";
import { captureApiKeys } from "../../src/supabase/management/api-keys.js";
import { captureAuthControlPlane } from "../../src/supabase/management/auth.js";
import type { ManagementClient } from "../../src/supabase/management/client.js";
import { captureControlPlaneState } from "../../src/supabase/management/control-plane.js";
import { capturePlatformV2State } from "../../src/supabase/management/platform-v2.js";
import { captureProjectState } from "../../src/supabase/management/project-state.js";

type CoverageEntry = CoverageDocument["components"][number];

const temporaryDirectories: string[] = [];
const management = {} as ManagementClient;
const source = {
  management,
  projectRef: "abcdefghijklmnopqrst",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function coverage(
  id: CoverageEntry["id"],
  artifacts: string[],
  status: CoverageEntry["status"] = "backed_up",
): CoverageEntry {
  return {
    id,
    status,
    sensitivity: "internal",
    artifacts,
    sourceContract: { adapter: "test" },
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-management-consistency-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function snapshot(value: unknown): ManagementConsistencySnapshot {
  return value as ManagementConsistencySnapshot;
}

describe("Management consistency adapters", () => {
  it("hashes project state in memory while excluding volatile diagnostics", async () => {
    vi.mocked(captureProjectState).mockImplementation(
      async (client, projectRef, sink, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        await sink.writeJson(
          "control-plane/project.json",
          { data: { name: "stable-project" } },
          signal,
        );
        await sink.writeJson(
          "diagnostics/health.json",
          { data: { status: "HEALTHY", observedAt: "volatile" } },
          signal,
        );
        return {
          coverage: [
            coverage("project.metadata", ["control-plane/project.json"]),
            coverage("diagnostics.health", ["diagnostics/health.json"]),
          ],
        };
      },
    );

    const adapter = createProjectStateConsistencyAdapter(source);
    const captured = snapshot(
      await adapter.snapshot({ workspaceRoot: "unused" }),
    );

    expect(captured.coverage.map(({ id }) => id)).toEqual(["project.metadata"]);
    expect(captured.artifacts).toEqual([
      expect.objectContaining({
        path: "control-plane/project.json",
        protection: "ordinary",
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(JSON.stringify(captured)).not.toContain("stable-project");
    expect(JSON.stringify(captured)).not.toContain("volatile");
  });

  it("supports streamed ordinary artifacts in the in-memory digest sink", async () => {
    vi.mocked(captureProjectState).mockImplementation(
      async (client, projectRef, sink, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        const bytes = new TextEncoder().encode("streamed-project-state");
        await sink.writeStream(
          "control-plane/project.json",
          new Blob([bytes]).stream(),
          { maxBytes: bytes.byteLength, signal },
        );
        return {
          coverage: [
            coverage("project.metadata", ["control-plane/project.json"]),
          ],
        };
      },
    );

    const captured = snapshot(
      await createProjectStateConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    );

    expect(captured.artifacts[0]).toMatchObject({
      path: "control-plane/project.json",
      bytes: new TextEncoder().encode("streamed-project-state").byteLength,
    });
  });

  it("fails closed when a snapshot stream exceeds its declared byte limit", async () => {
    vi.mocked(captureProjectState).mockImplementation(
      async (client, projectRef, sink, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        await sink.writeStream(
          "control-plane/project.json",
          new Blob(["too-large"]).stream(),
          { maxBytes: 2, signal },
        );
        return {
          coverage: [
            coverage("project.metadata", ["control-plane/project.json"]),
          ],
        };
      },
    );

    await expect(
      createProjectStateConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "MANAGEMENT_CONSISTENCY_SNAPSHOT_FAILED",
      category: "consistency",
      component: "project-state",
    });
  });

  it("hashes protected Auth state without retaining secret plaintext", async () => {
    vi.mocked(captureAuthControlPlane).mockImplementation(
      async (client, projectRef, redactor, sink, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        redactor.register("super-secret-value");
        await sink.writeJson(
          "secrets/auth-config.json",
          { schemaVersion: 1, secret: "super-secret-value" },
          signal,
        );
        return {
          coverage: [
            coverage("auth.config", ["secrets/auth-config.json"]),
          ],
        };
      },
    );

    const captured = snapshot(
      await createAuthConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    );

    expect(captured.artifacts[0]).toMatchObject({
      path: "secrets/auth-config.json",
      protection: "protected",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(captured)).not.toContain("super-secret-value");
  });

  it("captures control-plane, platform-v2 and API-key source markers", async () => {
    vi.mocked(captureControlPlaneState).mockImplementation(
      async (client, projectRef, ordinary, protectedSink, redactor, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        expect(protectedSink).toBeDefined();
        expect(redactor).toBeDefined();
        await ordinary.writeJson(
          "control-plane/database-postgres.json",
          { data: { max_connections: 100 } },
          signal,
        );
        return {
          coverage: [
            coverage("database.postgres_config", [
              "control-plane/database-postgres.json",
            ]),
          ],
        };
      },
    );
    vi.mocked(capturePlatformV2State).mockImplementation(
      async (client, projectRef, ordinary, protectedSink, redactor, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        expect(protectedSink).toBeDefined();
        expect(redactor).toBeDefined();
        await ordinary.writeJson(
          "control-plane/private-link.json",
          { data: [] },
          signal,
        );
        return {
          coverage: [
            coverage(
              "network.private_link",
              ["control-plane/private-link.json"],
              "not_configured",
            ),
          ],
        };
      },
    );
    vi.mocked(captureApiKeys).mockImplementation(
      async (client, projectRef, redactor, sink, signal) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        expect(redactor).toBeDefined();
        await sink.writeJson(
          "secrets/api-keys.json",
          { schemaVersion: 1, keys: [] },
          signal,
        );
        return {
          coverage: [
            coverage(
              "api.modern_keys",
              ["secrets/api-keys.json"],
              "not_configured",
            ),
          ],
        };
      },
    );

    const control = snapshot(
      await createControlPlaneConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    );
    const platform = snapshot(
      await createPlatformV2ConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    );
    const apiKeys = snapshot(
      await createApiKeysConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    );

    expect(control.coverage).toEqual([
      expect.objectContaining({ id: "database.postgres_config" }),
    ]);
    expect(platform.coverage).toEqual([
      expect.objectContaining({
        id: "network.private_link",
        status: "not_configured",
      }),
    ]);
    expect(apiKeys.artifacts[0]).toMatchObject({
      path: "secrets/api-keys.json",
      protection: "protected",
    });
  });

  it("detects snapshot protection mismatches instead of silently hashing them", async () => {
    vi.mocked(captureControlPlaneState).mockImplementation(
      async (client, projectRef, ordinary) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        await ordinary.writeJson(
          "secrets/control-plane/postgrest.json",
          { data: { jwt_secret: "secret-value" } },
        );
        return {
          coverage: [
            coverage("rest.postgrest_config", [
              "secrets/control-plane/postgrest.json",
            ]),
          ],
        };
      },
    );

    await expect(
      createControlPlaneConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_SNAPSHOT_PROTECTION_MISMATCH",
      category: "consistency",
    });
  });

  it("rejects duplicate snapshot artifacts and missing coverage artifacts", async () => {
    vi.mocked(captureProjectState).mockImplementationOnce(
      async (client, projectRef, sink) => {
        expect(client).toBe(management);
        expect(projectRef).toBe(source.projectRef);
        await sink.writeJson("control-plane/project.json", { data: 1 });
        await sink.writeJson("control-plane/project.json", { data: 2 });
        return {
          coverage: [
            coverage("project.metadata", ["control-plane/project.json"]),
          ],
        };
      },
    );

    await expect(
      createProjectStateConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_SNAPSHOT_DUPLICATE_ARTIFACT",
    });

    vi.mocked(captureProjectState).mockImplementationOnce(async () => ({
      coverage: [coverage("project.metadata", ["control-plane/project.json"])],
    }));

    await expect(
      createProjectStateConsistencyAdapter(source).snapshot({
        workspaceRoot: "unused",
      }),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_SNAPSHOT_ARTIFACT_MISSING",
    });
  });

  it("removes only artifacts owned by the retrying management step", async () => {
    const root = await workspace();
    const authDirectory = path.join(root, "secrets");
    await mkdir(authDirectory, { recursive: true });
    const authConfig = path.join(authDirectory, "auth-config.json");
    const authSso = path.join(authDirectory, "auth-sso.json");
    const unrelated = path.join(authDirectory, "api-keys.json");
    await writeFile(authConfig, "config");
    await writeFile(authSso, "sso");
    await writeFile(unrelated, "keys");

    const adapter = createAuthConsistencyAdapter(source);
    await adapter.cleanup(
      {
        artifacts: ["secrets/auth-config.json", "secrets/auth-sso.json"],
        coverage: [],
      },
      { workspaceRoot: root },
    );

    await expect(access(authConfig)).rejects.toThrow();
    await expect(access(authSso)).rejects.toThrow();
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keys");
  });

  it("validates the entire management cleanup scope before deleting anything", async () => {
    const root = await workspace();
    const secretDirectory = path.join(root, "secrets");
    await mkdir(secretDirectory, { recursive: true });
    const authConfig = path.join(secretDirectory, "auth-config.json");
    const apiKeys = path.join(secretDirectory, "api-keys.json");
    await writeFile(authConfig, "config");
    await writeFile(apiKeys, "keys");

    const adapter = createAuthConsistencyAdapter(source);
    await expect(
      adapter.cleanup(
        {
          artifacts: ["secrets/auth-config.json", "secrets/api-keys.json"],
          coverage: [],
        },
        { workspaceRoot: root },
      ),
    ).rejects.toMatchObject({
      code: "CONSISTENCY_CLEANUP_SCOPE_INVALID",
      component: "auth",
    });

    await expect(readFile(authConfig, "utf8")).resolves.toBe("config");
    await expect(readFile(apiKeys, "utf8")).resolves.toBe("keys");
  });

  it("allows project-state cleanup to remove diagnostics excluded from equality", async () => {
    const root = await workspace();
    const diagnostics = path.join(root, "diagnostics");
    await mkdir(diagnostics, { recursive: true });
    const health = path.join(diagnostics, "health.json");
    await writeFile(health, "health");

    await createProjectStateConsistencyAdapter(source).cleanup(
      {
        artifacts: ["diagnostics/health.json"],
        coverage: [],
      },
      { workspaceRoot: root },
    );

    await expect(access(health)).rejects.toThrow();
  });

  it("honors cancellation before management cleanup begins", async () => {
    const root = await workspace();
    const secretDirectory = path.join(root, "secrets");
    await mkdir(secretDirectory, { recursive: true });
    const authConfig = path.join(secretDirectory, "auth-config.json");
    await writeFile(authConfig, "config");
    const controller = new AbortController();
    const reason = new Error("cancel management cleanup");
    controller.abort(reason);

    await expect(
      createAuthConsistencyAdapter(source).cleanup(
        {
          artifacts: ["secrets/auth-config.json"],
          coverage: [],
        },
        { workspaceRoot: root, signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    await expect(readFile(authConfig, "utf8")).resolves.toBe("config");
  });
});
