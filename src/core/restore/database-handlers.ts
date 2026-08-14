import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  dumpExcludedDatabaseComponent,
  dumpLogicalDatabaseComponent,
  type DatabaseDumpOptions,
} from "../../database/dump.js";
import {
  collectDatabaseInventory,
  databaseInventorySchema,
} from "../../database/inventory.js";
import {
  ensureDatabaseExtensions,
  restorePlatformCompatibleRolesArtifact,
  restoreSqlArtifact,
} from "../../database/restore.js";
import { assertSafeBundlePath } from "../../security/bundle-path.js";
import type { SecretValue } from "../../security/secret-value.js";
import { PgDumpsterError } from "../errors/error.js";
import type { RestoreActionHandler, RestoreActionResult } from "./executor.js";

type LogicalComponent = "database.roles" | "database.schema" | "database.data";
type DedicatedComponent = "auth.data" | "database.vault_data";
type SqlComponent = LogicalComponent | DedicatedComponent;

export interface DatabaseRestoreHandlerDependencies {
  restoreSqlArtifact?: typeof restoreSqlArtifact;
  restorePlatformCompatibleRolesArtifact?:
    typeof restorePlatformCompatibleRolesArtifact | undefined;
  dumpLogicalDatabaseComponent?: typeof dumpLogicalDatabaseComponent;
  dumpExcludedDatabaseComponent?: typeof dumpExcludedDatabaseComponent;
  collectDatabaseInventory?: typeof collectDatabaseInventory;
  ensureDatabaseExtensions?: typeof ensureDatabaseExtensions;
}

export interface DatabaseRestoreHandlersOptions {
  bundleRoot: string;
  targetDatabaseUrl: SecretValue;
  dependencies?: DatabaseRestoreHandlerDependencies | undefined;
}

const NON_SEMANTIC_DUMP_LINE = /^-- \\(?:un)?restrict [A-Za-z0-9]+$/u;

async function normalizedSqlSha256(filename: string): Promise<string> {
  const fileStat = await lstat(filename);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
      message: "Database restore artifact must be a regular file.",
      retryable: false,
    });
  }
  const hash = createHash("sha256");
  const input = createReadStream(filename, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!NON_SEMANTIC_DUMP_LINE.test(line)) hash.update(line).update("\n");
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return hash.digest("hex");
}

export async function resolveBundleArtifact(
  bundleRoot: string,
  artifact: string,
): Promise<string> {
  assertSafeBundlePath(artifact);
  const [resolvedRoot, resolvedArtifact] = await Promise.all([
    realpath(bundleRoot),
    realpath(path.join(bundleRoot, ...artifact.split("/"))),
  ]);
  const relative = path.relative(resolvedRoot, resolvedArtifact);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "security",
      message: "Database restore artifact escapes the verified bundle.",
      retryable: false,
    });
  }
  return resolvedArtifact;
}

async function readDatabaseInventory(bundleRoot: string) {
  const filename = await resolveBundleArtifact(
    bundleRoot,
    "database/metadata.json",
  );
  try {
    return databaseInventorySchema.parse(
      JSON.parse(await readFile(filename, "utf8")),
    );
  } catch (error) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "integrity",
      message: "Database inventory artifact is invalid.",
      retryable: false,
      component: "database.extensions",
      cause: error,
    });
  }
}

function sqlArtifact(component: SqlComponent, artifacts: string[]): string {
  if (artifacts.length !== 1 || !artifacts[0]!.endsWith(".sql")) {
    throw new PgDumpsterError({
      code: "RESTORE_ARTIFACT_INVALID",
      category: "restore_policy",
      message: "Logical database restore requires exactly one SQL artifact.",
      retryable: false,
      component,
    });
  }
  return artifacts[0]!;
}

export function createLogicalDatabaseRestoreHandlers(
  options: DatabaseRestoreHandlersOptions,
): Readonly<Record<LogicalComponent, RestoreActionHandler>> {
  const restore =
    options.dependencies?.restoreSqlArtifact ?? restoreSqlArtifact;
  const restoreRoles =
    options.dependencies?.restorePlatformCompatibleRolesArtifact ??
    restorePlatformCompatibleRolesArtifact;
  const dump =
    options.dependencies?.dumpLogicalDatabaseComponent ??
    dumpLogicalDatabaseComponent;

  const handler = (component: LogicalComponent): RestoreActionHandler => ({
    async apply(context): Promise<RestoreActionResult> {
      const artifact = sqlArtifact(component, context.action.artifacts);
      const sourcePath = await resolveBundleArtifact(
        options.bundleRoot,
        artifact,
      );
      const fingerprint = await normalizedSqlSha256(sourcePath);
      const restoreArtifact =
        component === "database.roles" ? restoreRoles : restore;
      await restoreArtifact({
        bundleRoot: options.bundleRoot,
        artifact,
        targetDatabaseUrl: options.targetDatabaseUrl,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return { fingerprint };
    },

    async verify(context): Promise<boolean> {
      const artifact = sqlArtifact(component, context.action.artifacts);
      const sourcePath = await resolveBundleArtifact(
        options.bundleRoot,
        artifact,
      );
      const expected =
        context.expectedFingerprint ?? (await normalizedSqlSha256(sourcePath));
      const outputDirectory = await mkdtemp(
        path.join(tmpdir(), "pgdumpster-restore-verify-"),
      );
      try {
        const dumpOptions: DatabaseDumpOptions = {
          connectionString: options.targetDatabaseUrl,
          outputDirectory,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        };
        const inventory =
          component === "database.data"
            ? await readDatabaseInventory(options.bundleRoot)
            : undefined;
        const target = await dump(dumpOptions, component, inventory);
        return (await normalizedSqlSha256(target.path)) === expected;
      } finally {
        await rm(outputDirectory, { recursive: true, force: true });
      }
    },
  });

  return {
    "database.roles": handler("database.roles"),
    "database.schema": handler("database.schema"),
    "database.data": handler("database.data"),
  };
}

export function createDatabaseExtensionRestoreHandler(
  options: DatabaseRestoreHandlersOptions,
): RestoreActionHandler {
  const collect =
    options.dependencies?.collectDatabaseInventory ?? collectDatabaseInventory;
  const ensure =
    options.dependencies?.ensureDatabaseExtensions ?? ensureDatabaseExtensions;

  const sourceInventory = async (artifacts: string[]) => {
    if (artifacts.length !== 1 || artifacts[0] !== "database/metadata.json") {
      throw new PgDumpsterError({
        code: "RESTORE_ARTIFACT_INVALID",
        category: "restore_policy",
        message: "Extension restore requires database/metadata.json.",
        retryable: false,
        component: "database.extensions",
      });
    }
    return readDatabaseInventory(options.bundleRoot);
  };

  const targetInventory = async (signal?: AbortSignal) => {
    const outputDirectory = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-extension-verify-"),
    );
    try {
      return await collect(options.targetDatabaseUrl, outputDirectory, signal);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  };

  return {
    async apply(context): Promise<RestoreActionResult> {
      const source = await sourceInventory(context.action.artifacts);
      const target = await targetInventory(context.signal);
      await ensure({
        targetDatabaseUrl: options.targetDatabaseUrl,
        sourceExtensions: source.extensions,
        targetExtensions: target.extensions,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return {
        fingerprint: createHash("sha256")
          .update(JSON.stringify(source.extensions))
          .digest("hex"),
      };
    },

    async verify(context): Promise<boolean> {
      const source = await sourceInventory(context.action.artifacts);
      const target = await targetInventory(context.signal);
      const sourceByName = new Map(
        source.extensions.map((extension) => [extension.name, extension]),
      );
      return [...sourceByName].every(([name, extension]) => {
        const candidate = target.extensions.find((item) => item.name === name);
        return (
          candidate?.version === extension.version &&
          candidate.schema === extension.schema
        );
      });
    },
  };
}

export function createDatabaseRestoreHandlers(
  options: DatabaseRestoreHandlersOptions,
): Readonly<Record<string, RestoreActionHandler>> {
  return {
    "database.extensions": createDatabaseExtensionRestoreHandler(options),
    ...createLogicalDatabaseRestoreHandlers(options),
    ...createDedicatedDatabaseRestoreHandlers(options),
  };
}

export function createDedicatedDatabaseRestoreHandlers(
  options: DatabaseRestoreHandlersOptions,
): Readonly<Record<DedicatedComponent, RestoreActionHandler>> {
  const restore =
    options.dependencies?.restoreSqlArtifact ?? restoreSqlArtifact;
  const dump =
    options.dependencies?.dumpExcludedDatabaseComponent ??
    dumpExcludedDatabaseComponent;
  const targetMatches = async (
    component: DedicatedComponent,
    expected: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const inventory = await readDatabaseInventory(options.bundleRoot);
    const outputDirectory = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-dedicated-verify-"),
    );
    try {
      const target = await dump(
        {
          connectionString: options.targetDatabaseUrl,
          outputDirectory,
          ...(signal === undefined ? {} : { signal }),
        },
        inventory,
        component,
      );
      return (await normalizedSqlSha256(target.path)) === expected;
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  };
  const handler = (component: DedicatedComponent): RestoreActionHandler => ({
    async apply(context) {
      const artifact = sqlArtifact(component, context.action.artifacts);
      const sourcePath = await resolveBundleArtifact(
        options.bundleRoot,
        artifact,
      );
      const fingerprint = await normalizedSqlSha256(sourcePath);
      if (await targetMatches(component, fingerprint, context.signal))
        return { fingerprint };
      await restore({
        bundleRoot: options.bundleRoot,
        artifact,
        targetDatabaseUrl: options.targetDatabaseUrl,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return { fingerprint };
    },

    async verify(context) {
      const artifact = sqlArtifact(component, context.action.artifacts);
      const sourcePath = await resolveBundleArtifact(
        options.bundleRoot,
        artifact,
      );
      const expected =
        context.expectedFingerprint ?? (await normalizedSqlSha256(sourcePath));
      return targetMatches(component, expected, context.signal);
    },
  });
  return {
    "auth.data": handler("auth.data"),
    "database.vault_data": handler("database.vault_data"),
  };
}
