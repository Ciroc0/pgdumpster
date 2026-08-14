import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { SourceEnvironment } from "../../src/config/environment.js";
import { runDoctor } from "../../src/doctor/doctor.js";
import { Redactor } from "../../src/security/redactor.js";
import { SecretValue } from "../../src/security/secret-value.js";
import { ManagementClient } from "../../src/supabase/management/client.js";

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
}

async function managementClient(): Promise<ManagementClient> {
  const project: unknown = JSON.parse(
    await readFile("tests/fixtures/contracts/management-project.json", "utf8"),
  );

  return new ManagementClient({
    accessToken: new SecretValue("sbp_doctor_hardening", new Redactor()),
    fetch: vi.fn<typeof fetch>((input) => {
      const pathname = new URL(requestUrl(input)).pathname;

      const payload = pathname.endsWith("/health")
        ? [
            {
              name: "db",
              healthy: true,
              status: "ACTIVE_HEALTHY",
            },
          ]
        : project;

      return Promise.resolve(Response.json(payload));
    }),
  });
}

function source(storageKey = "sb_secret_doctor_hardening"): SourceEnvironment {
  const redactor = new Redactor();

  return {
    projectRef: "abcdefghijklmnopqrst",
    accessToken: new SecretValue("sbp_doctor_hardening", redactor),
    databaseUrl: new SecretValue(
      "postgresql://postgres:doctor-secret@db.example.invalid/postgres",
      redactor,
    ),
    storageKey: new SecretValue(storageKey, redactor),
  };
}

describe("doctor branch hardening", () => {
  it("covers Node 22 minimum support, malformed CLI versions and default destination inspection", async () => {
    const report = await runDoctor(source(), await managementClient(), {
      nodeVersion: "22.15.0",
      resolveSupabaseCommand: () =>
        Promise.resolve({
          command: "supabase-test",
          prefixArgs: [],
        }),
      runProcess(command) {
        if (command === "supabase-test") {
          return Promise.resolve({
            exitCode: 0,
            stdout: "malformed-version",
            stderr: "",
          });
        }

        if (command === "docker") {
          return Promise.resolve({
            exitCode: 0,
            stdout: "malformed-version",
            stderr: "",
          });
        }

        return Promise.resolve({
          exitCode: 0,
          stdout: "1.2.3\n",
          stderr: "",
        });
      },
      checkDatabase: () =>
        Promise.resolve({
          database: "postgres",
        }),
      checkStorage: () =>
        Promise.resolve({
          credentialClass: "privileged",
        }),
    });

    expect(report.checks.find(({ id }) => id === "runtime.node")).toMatchObject(
      {
        status: "passed",
      },
    );

    expect(
      report.checks.find(({ id }) => id === "dependency.supabase_cli"),
    ).toMatchObject({
      status: "failed",
    });

    expect(
      report.checks.find(({ id }) => id === "dependency.docker"),
    ).toMatchObject({
      status: "failed",
    });

    expect(
      report.checks.find(({ id }) => id === "destination.local"),
    ).toMatchObject({
      status: "passed",
    });
  });

  it("rejects Node 22 before 22.15 and exercises the default unprivileged Storage check", async () => {
    const report = await runDoctor(
      source("sb_publishable_doctor_hardening"),
      await managementClient(),
      {
        nodeVersion: "22.14.9",
        resolveSupabaseCommand: () =>
          Promise.resolve({
            command: "supabase-test",
            prefixArgs: [],
          }),
        runProcess(command) {
          if (command === "supabase-test") {
            return Promise.resolve({
              exitCode: 0,
              stdout: "2.111.0\n",
              stderr: "",
            });
          }

          if (command === "docker") {
            return Promise.resolve({
              exitCode: 0,
              stdout: "27.1.2\n",
              stderr: "",
            });
          }

          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "",
          });
        },
        checkDatabase: () =>
          Promise.resolve({
            database: "postgres",
          }),
        checkDestination: () =>
          Promise.resolve({
            path: "fixture",
          }),
      },
    );

    expect(report.checks.find(({ id }) => id === "runtime.node")).toMatchObject(
      {
        status: "failed",
      },
    );

    expect(report.checks.find(({ id }) => id === "auth.storage")).toMatchObject(
      {
        status: "failed",
      },
    );

    expect(
      report.checks.find(({ id }) => id === "encryption.age"),
    ).toMatchObject({
      status: "warning",
    });
  });
});
