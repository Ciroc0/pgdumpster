import { constants as fsConstants } from "node:fs";
import { access, statfs } from "node:fs/promises";

import { StorageClient } from "@supabase/storage-js";
import pg from "pg";

import type { SourceEnvironment } from "../config/environment.js";
import { storageCredentialClass } from "../security/storage-credential.js";
import type { ManagementClient } from "../supabase/management/client.js";
import { discoverProject } from "../supabase/management/project.js";
import {
  resolveSupabaseCommand,
  runProcess,
  type ProcessResult,
} from "../utils/process.js";

const { Client } = pg;

export type DoctorStatus = "passed" | "failed" | "warning";
export type DoctorCategory =
  | "runtime"
  | "dependency"
  | "auth"
  | "database"
  | "storage"
  | "capability"
  | "destination"
  | "encryption";

export interface DoctorCheck {
  id: string;
  category: DoctorCategory;
  status: DoctorStatus;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  projectRef: string;
  checks: DoctorCheck[];
}

export interface DoctorDependencies {
  nodeVersion?: string;
  runProcess?: (
    command: string,
    args: readonly string[],
  ) => Promise<ProcessResult>;
  resolveSupabaseCommand?: () => Promise<{
    command: string;
    prefixArgs: readonly string[];
  }>;
  checkDatabase?: (
    connectionString: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  checkStorage?: (
    projectRef: string,
    storageKey: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  checkDestination?: () => Promise<Readonly<Record<string, unknown>>>;
}

function runtimeCheck(version: string): DoctorCheck {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const supported = (major === 22 && minor >= 15) || major === 24;
  return {
    id: "runtime.node",
    category: "runtime",
    status: supported ? "passed" : "failed",
    message: supported
      ? `Node.js ${version} is supported.`
      : `Node.js ${version} is outside the supported runtime range.`,
    details: { version },
  };
}

function parseSupabaseCliVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output.trim())?.[1];
}

function cliVersionSupported(version: string): boolean {
  const majorMinor = /^(\d+)\.(\d+)\./u.exec(version);
  return Number(majorMinor?.[1]) === 2 && Number(majorMinor?.[2]) >= 111;
}

async function databaseCheck(
  connectionString: string,
): Promise<Readonly<Record<string, unknown>>> {
  const client = new Client({
    connectionString,
    application_name: "pgdumpster-doctor",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    const result = await client.query<{
      database: string;
      role: string;
      server_version: string;
    }>(
      "select current_database()::text as database, current_user::text as role, current_setting('server_version')::text as server_version",
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("Database identity query returned no row");
    return row;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function storageCheck(
  projectRef: string,
  storageKey: string,
): Promise<Readonly<Record<string, unknown>>> {
  const credentialClass = storageCredentialClass(storageKey);
  if (credentialClass !== "privileged") {
    throw new Error(
      "Storage credential is not a Supabase secret key or legacy service_role key",
    );
  }
  const storage = new StorageClient(
    `https://${projectRef}.supabase.co/storage/v1`,
    {
      apikey: storageKey,
      authorization: `Bearer ${storageKey}`,
    },
  );
  const result = await storage.listBuckets({ limit: 1, offset: 0 });
  if (result.error !== null) throw new Error("Storage bucket listing failed");
  return {
    credentialClass,
    bucketListing: "authorized",
    sampledBucketCount: result.data.length,
  };
}

async function destinationCheck(): Promise<Readonly<Record<string, unknown>>> {
  await access(process.cwd(), fsConstants.W_OK);
  const filesystem = await statfs(process.cwd(), { bigint: true });
  return {
    path: process.cwd(),
    availableBytes: (filesystem.bavail * filesystem.bsize).toString(),
  };
}

function safeFailure(
  id: string,
  category: DoctorCategory,
  message: string,
): DoctorCheck {
  return { id, category, status: "failed", message };
}

export async function runDoctor(
  source: SourceEnvironment,
  management: ManagementClient,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    runtimeCheck(dependencies.nodeVersion ?? process.versions.node),
  ];
  const processRunner = dependencies.runProcess ?? runProcess;
  try {
    const resolved = await (
      dependencies.resolveSupabaseCommand ?? resolveSupabaseCommand
    )();
    const result = await processRunner(resolved.command, [
      ...resolved.prefixArgs,
      "--version",
    ]);
    const version = parseSupabaseCliVersion(result.stdout);
    if (result.exitCode !== 0 || version === undefined) {
      checks.push(
        safeFailure(
          "dependency.supabase_cli",
          "dependency",
          "Supabase CLI version could not be determined.",
        ),
      );
    } else {
      const supported = cliVersionSupported(version);
      checks.push({
        id: "dependency.supabase_cli",
        category: "dependency",
        status: supported ? "passed" : "failed",
        message: supported
          ? `Supabase CLI ${version} is in the validated compatibility range.`
          : `Supabase CLI ${version} is outside the validated compatibility range.`,
        details: { version, validatedRange: ">=2.111.0 <3.0.0" },
      });
    }
  } catch {
    checks.push(
      safeFailure(
        "dependency.supabase_cli",
        "dependency",
        "Supabase CLI is unavailable or did not start.",
      ),
    );
  }

  try {
    const result = await processRunner("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    const version = parseSupabaseCliVersion(result.stdout);
    if (result.exitCode !== 0 || version === undefined) {
      checks.push(
        safeFailure(
          "dependency.docker",
          "dependency",
          "Docker daemon is required for the Supabase CLI database dump workflow.",
        ),
      );
    } else {
      checks.push({
        id: "dependency.docker",
        category: "dependency",
        status: "passed",
        message: `Docker daemon ${version} is reachable.`,
        details: { serverVersion: version },
      });
    }
  } catch {
    checks.push(
      safeFailure(
        "dependency.docker",
        "dependency",
        "Docker daemon is unavailable; Supabase CLI database dumps cannot run.",
      ),
    );
  }

  try {
    const discovery = await discoverProject(management, source.projectRef);
    checks.push({
      id: "auth.management_api",
      category: "auth",
      status: "passed",
      message: "Management API project access is valid.",
      details: {
        projectStatus: discovery.project.status,
        region: discovery.project.region,
      },
    });
    const unhealthy = discovery.services.filter(
      ({ status }) => status !== "ACTIVE_HEALTHY",
    );
    checks.push({
      id: "capability.service_health",
      category: "capability",
      status: unhealthy.length === 0 ? "passed" : "failed",
      message:
        unhealthy.length === 0
          ? "All reported Supabase services are healthy."
          : `${unhealthy.length} reported Supabase service(s) are not healthy.`,
      details: {
        services: discovery.services.map(({ name, status }) => ({
          name,
          status,
        })),
      },
    });
  } catch {
    checks.push(
      safeFailure(
        "auth.management_api",
        "auth",
        "Management API project access or contract validation failed.",
      ),
    );
    checks.push(
      safeFailure(
        "capability.service_health",
        "capability",
        "Service capability inventory could not be retrieved.",
      ),
    );
  }

  if (source.databaseUrl === undefined) {
    checks.push(
      safeFailure(
        "auth.database",
        "database",
        "PGDUMPSTER_DB_URL is required for database preflight.",
      ),
    );
  } else {
    try {
      const details = await (dependencies.checkDatabase ?? databaseCheck)(
        source.databaseUrl.expose(),
      );
      checks.push({
        id: "auth.database",
        category: "database",
        status: "passed",
        message: "Read-only PostgreSQL identity query succeeded.",
        details,
      });
    } catch {
      checks.push(
        safeFailure(
          "auth.database",
          "database",
          "PostgreSQL connection or read-only identity query failed.",
        ),
      );
    }
  }

  if (source.storageKey === undefined) {
    checks.push(
      safeFailure(
        "auth.storage",
        "storage",
        "PGDUMPSTER_STORAGE_KEY is required to prove full Storage access.",
      ),
    );
  } else {
    try {
      const details = await (dependencies.checkStorage ?? storageCheck)(
        source.projectRef,
        source.storageKey.expose(),
      );
      checks.push({
        id: "auth.storage",
        category: "storage",
        status: "passed",
        message: "Privileged Storage credential and bucket listing are valid.",
        details,
      });
    } catch {
      checks.push(
        safeFailure(
          "auth.storage",
          "storage",
          "Full Storage read access was not proven.",
        ),
      );
    }
  }

  try {
    const details = await (dependencies.checkDestination ?? destinationCheck)();
    checks.push({
      id: "destination.local",
      category: "destination",
      status: "passed",
      message: "Local destination is writable and capacity was inspected.",
      details,
    });
  } catch {
    checks.push(
      safeFailure(
        "destination.local",
        "destination",
        "Local destination is not writable or capacity could not be inspected.",
      ),
    );
  }

  try {
    const result = await processRunner("age", ["--version"]);
    checks.push({
      id: "encryption.age",
      category: "encryption",
      status: result.exitCode === 0 ? "passed" : "warning",
      message:
        result.exitCode === 0
          ? "age encryption tooling is available."
          : "age encryption tooling did not report a usable version.",
    });
  } catch {
    checks.push({
      id: "encryption.age",
      category: "encryption",
      status: "warning",
      message: "age is not installed; encrypted backup output is unavailable.",
    });
  }

  return {
    schemaVersion: 1,
    ok: !checks.some(({ status }) => status === "failed"),
    projectRef: source.projectRef,
    checks,
  };
}
