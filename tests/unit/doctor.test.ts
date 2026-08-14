import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import type { SourceEnvironment } from "../../src/config/environment.js";
import { runDoctor } from "../../src/doctor/doctor.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { storageCredentialClass } from "../../src/security/storage-credential.js";
import { ManagementClient } from "../../src/supabase/management/client.js";

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

async function managementClient(): Promise<ManagementClient> {
  const project: unknown = JSON.parse(
    await readFile("tests/fixtures/contracts/management-project.json", "utf8"),
  );
  const fetchImplementation = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    const payload = new URL(url).pathname.endsWith("/health")
      ? [
          {
            name: "db",
            healthy: true,
            status: "ACTIVE_HEALTHY",
          },
          {
            name: "storage",
            healthy: true,
            status: "ACTIVE_HEALTHY",
          },
        ]
      : project;
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200 }),
    );
  });
  const redactor = new Redactor();
  return new ManagementClient({
    accessToken: new SecretValue("sbp_doctor_test_access_token", redactor),
    fetch: fetchImplementation,
  });
}

function source(includeDataPlane = true): SourceEnvironment {
  const redactor = new Redactor();
  return {
    projectRef: "abcdefghijklmnopqrst",
    accessToken: new SecretValue("sbp_doctor_test_access_token", redactor),
    ...(includeDataPlane
      ? {
          databaseUrl: new SecretValue(
            "postgresql://postgres:doctor_secret@db.example.invalid/postgres",
            redactor,
          ),
          storageKey: new SecretValue("sb_secret_doctor_key", redactor),
        }
      : {}),
  };
}

describe("doctor", () => {
  it("reports each read-only preflight surface without returning secrets", async () => {
    const report = await runDoctor(source(), await managementClient(), {
      nodeVersion: "24.16.0",
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
      runProcess: (command) =>
        Promise.resolve({
          exitCode: 0,
          stdout: command === "supabase-test" ? "2.114.0\n" : "1.2.1\n",
          stderr: "",
        }),
      checkDatabase: () =>
        Promise.resolve({
          database: "postgres",
          role: "postgres",
          server_version: "17.6",
        }),
      checkStorage: () =>
        Promise.resolve({
          credentialClass: "privileged",
          bucketListing: "authorized",
        }),
      checkDestination: () =>
        Promise.resolve({ path: "test-output", availableBytes: "1000000" }),
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ id }) => id)).toEqual([
      "runtime.node",
      "dependency.supabase_cli",
      "dependency.docker",
      "auth.management_api",
      "capability.service_health",
      "auth.database",
      "auth.storage",
      "destination.local",
      "encryption.age",
    ]);
    expect(JSON.stringify(report)).not.toContain("doctor_secret");
    expect(JSON.stringify(report)).not.toContain("doctor_key");
  });

  it("fails closed when data-plane credentials are absent", async () => {
    const report = await runDoctor(source(false), await managementClient(), {
      nodeVersion: "24.16.0",
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
      runProcess: (command) =>
        command === "supabase-test"
          ? Promise.resolve({ exitCode: 0, stdout: "2.114.0\n", stderr: "" })
          : Promise.reject(new Error("not installed")),
      checkDestination: () => Promise.resolve({ path: "test-output" }),
    });
    expect(report.ok).toBe(false);
    expect(
      report.checks
        .filter(({ status }) => status === "failed")
        .map(({ id }) => id),
    ).toEqual(["dependency.docker", "auth.database", "auth.storage"]);
    expect(report.checks.at(-1)?.status).toBe("warning");
  });

  it("classifies only documented privileged Storage key forms as privileged", () => {
    const serviceRolePayload = Buffer.from(
      JSON.stringify({ role: "service_role" }),
    ).toString("base64url");
    const anonPayload = Buffer.from(JSON.stringify({ role: "anon" })).toString(
      "base64url",
    );
    expect(storageCredentialClass("sb_secret_example")).toBe("privileged");
    expect(storageCredentialClass(`x.${serviceRolePayload}.x`)).toBe(
      "privileged",
    );
    expect(storageCredentialClass("sb_publishable_example")).toBe(
      "unprivileged",
    );
    expect(storageCredentialClass(`x.${anonPayload}.x`)).toBe("unprivileged");
    expect(storageCredentialClass("opaque-key")).toBe("unknown");
    expect(storageCredentialClass("not.a-jwt")).toBe("unknown");
    expect(
      storageCredentialClass(
        `x.${Buffer.from(JSON.stringify({ role: 123 })).toString("base64url")}.x`,
      ),
    ).toBe("unknown");
    expect(
      storageCredentialClass(
        `x.${Buffer.from(JSON.stringify({ subject: "user" })).toString("base64url")}.x`,
      ),
    ).toBe("unknown");
  });

  it("reports unsupported, unhealthy, and failed dependency branches", async () => {
    const project: unknown = JSON.parse(
      await readFile(
        "tests/fixtures/contracts/management-project.json",
        "utf8",
      ),
    );
    const management = new ManagementClient({
      accessToken: new SecretValue("test-token", new Redactor()),
      fetch: (input) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              new URL(requestUrl(input)).pathname.endsWith("/health")
                ? [{ name: "db", healthy: false, status: "INACTIVE" }]
                : project,
            ),
            { status: 200 },
          ),
        ),
    });
    let processCalls = 0;
    const report = await runDoctor(source(), management, {
      nodeVersion: "23.0.0",
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
      runProcess: () => {
        processCalls += 1;
        return Promise.resolve(
          processCalls === 1
            ? { exitCode: 0, stdout: "2.101.0\n", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "" },
        );
      },
      checkDatabase: () => Promise.reject(new Error("database canary")),
      checkStorage: () => Promise.reject(new Error("storage canary")),
      checkDestination: () => Promise.reject(new Error("destination canary")),
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.node", status: "failed" }),
        expect.objectContaining({
          id: "dependency.supabase_cli",
          status: "failed",
        }),
        expect.objectContaining({
          id: "dependency.docker",
          status: "failed",
        }),
        expect.objectContaining({
          id: "capability.service_health",
          status: "failed",
        }),
        expect.objectContaining({ id: "auth.database", status: "failed" }),
        expect.objectContaining({ id: "auth.storage", status: "failed" }),
        expect.objectContaining({ id: "destination.local", status: "failed" }),
        expect.objectContaining({ id: "encryption.age", status: "warning" }),
      ]),
    );
  });

  it("reports unavailable CLI and Management API without leaking causes", async () => {
    const management = new ManagementClient({
      accessToken: new SecretValue("test-token", new Redactor()),
      fetch: () =>
        Promise.resolve(new Response("unauthorized canary", { status: 401 })),
    });
    const report = await runDoctor(source(false), management, {
      nodeVersion: "not-a-version",
      resolveSupabaseCommand: () => Promise.reject(new Error("missing CLI")),
      runProcess: () => Promise.reject(new Error("missing age")),
      checkDestination: () => Promise.resolve({ path: "test" }),
    });
    expect(report.ok).toBe(false);
    expect(
      report.checks.find(({ id }) => id === "dependency.supabase_cli"),
    ).toMatchObject({ status: "failed" });
    expect(
      report.checks.find(({ id }) => id === "dependency.docker"),
    ).toMatchObject({ status: "failed" });
    expect(
      report.checks.find(({ id }) => id === "auth.management_api"),
    ).toMatchObject({ status: "failed" });
    expect(JSON.stringify(report)).not.toContain("canary");
  });

  it("is exposed as stable machine-readable CLI behavior", async () => {
    const project: unknown = JSON.parse(
      await readFile(
        "tests/fixtures/contracts/management-project.json",
        "utf8",
      ),
    );
    const fetchImplementation = vi.fn<typeof fetch>(async (input) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            new URL(requestUrl(input)).pathname.endsWith("/health")
              ? [
                  {
                    name: "db",
                    healthy: true,
                    status: "ACTIVE_HEALTHY",
                  },
                ]
              : project,
          ),
          { status: 200 },
        ),
      ),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(
      ["doctor", "--project-ref", "abcdefghijklmnopqrst", "--json"],
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      {
        environment: {
          PGDUMPSTER_ACCESS_TOKEN: "sbp_doctor_cli_canary",
          PGDUMPSTER_DB_URL:
            "postgresql://postgres:doctor_cli_secret@invalid/postgres",
          PGDUMPSTER_STORAGE_KEY: "sb_secret_doctor_cli_key",
        },
        fetch: fetchImplementation,
        doctorDependencies: {
          nodeVersion: "24.16.0",
          resolveSupabaseCommand: () =>
            Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
          runProcess: (command) =>
            Promise.resolve({
              exitCode: 0,
              stdout: command === "supabase-test" ? "2.114.0\n" : "1.2.1\n",
              stderr: "",
            }),
          checkDatabase: () => Promise.resolve({ database: "postgres" }),
          checkStorage: () =>
            Promise.resolve({ credentialClass: "privileged" }),
          checkDestination: () => Promise.resolve({ path: "test-output" }),
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      ok: true,
      projectRef: "abcdefghijklmnopqrst",
    });
    expect(stdout.join("")).not.toContain("doctor_cli_secret");
    expect(stdout.join("")).not.toContain("doctor_cli_key");
  });
});
