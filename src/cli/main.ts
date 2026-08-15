#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadSourceEnvironment } from "../config/environment.js";
import { loadConfigFile } from "../config/file.js";
import { executeProductBackup } from "../core/backup/product.js";
import type { packBundle } from "../core/bundle/archive.js";
import type {
  decryptArchiveWithAge,
  encryptArchiveWithAge,
} from "../core/bundle/encryption.js";
import { backupCheckpointSchema } from "../core/checkpoint/backup.js";
import { inspectVerifiedBundle } from "../core/bundle/inspect.js";
import { buildRestorePlan, type RestorePlan } from "../core/restore/plan.js";
import {
  assertRestorePlanExecutable,
  executeRestore,
  validatePlanForExecution,
} from "../core/restore/executor.js";
import { restoreCheckpointSchema } from "../core/checkpoint/restore.js";
import {
  createDatabaseRestoreHandlers,
  resolveBundleArtifact,
} from "../core/restore/database-handlers.js";
import { createDatabaseSupplementRestoreHandlers } from "../core/restore/database-supplement-handlers.js";
import { createPublicationRestoreHandler } from "../core/restore/publication-handler.js";
import { createVaultRootKeyRestoreHandler } from "../core/restore/vault-root-key-handler.js";
import { createControlPlaneRestoreHandlers } from "../core/restore/control-plane-handler.js";
import { createFileStorageRestoreHandlers } from "../core/restore/file-storage-handlers.js";
import { createVectorStorageRestoreHandlers } from "../core/restore/vector-storage-handlers.js";
import { createEdgeFunctionRestoreHandler } from "../core/restore/edge-function-handler.js";
import { createAuthConfigRestoreHandler } from "../core/restore/auth-config-handler.js";
import { createApiKeyRestoreHandler } from "../core/restore/api-key-handler.js";
import { createLegacyApiKeyRestoreHandler } from "../core/restore/legacy-api-key-handler.js";
import {
  createRestoreParityReport,
  writeRestoreParityReport,
} from "../core/restore/parity-report.js";
import {
  createAuthSsoRestoreHandler,
  createAuthTpaRestoreHandler,
} from "../core/restore/auth-provider-handlers.js";
import type { PgDumpsterError } from "../core/errors/error.js";
import { PgDumpsterError as DomainError } from "../core/errors/error.js";
import { serializeError } from "../core/errors/serialize.js";
import { publishBackupOutput } from "../destination/backup-output.js";
import { withConfiguredBundleInput } from "../destination/bundle-input.js";
import type {
  materializeS3Backup,
  publishS3Backup,
} from "../destination/s3.js";
import {
  runDoctor,
  type DoctorDependencies,
  type DoctorReport,
} from "../doctor/doctor.js";
import { Redactor } from "../security/redactor.js";
import { SecretValue } from "../security/secret-value.js";
import { ManagementClient } from "../supabase/management/client.js";
import { discoverPrivilegedStorageKey } from "../supabase/management/api-keys.js";

interface Io {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface CliContext {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  doctorDependencies?: DoctorDependencies;
  backupExecutor?: typeof executeProductBackup;
  archivePacker?: typeof packBundle;
  ageEncryptor?: typeof encryptArchiveWithAge;
  ageDecryptor?: typeof decryptArchiveWithAge;
  s3Publisher?: typeof publishS3Backup;
  s3Materializer?: typeof materializeS3Backup;
  now?: () => Date;
  randomUUID?: () => string;
  restoreExecutor?: typeof executeRestore;
}

const HELP = `pgDumpster

Usage:
  pgdumpster doctor [--project-ref <ref>] [--json]
  pgdumpster backup --project-ref <ref> (--linked|--db-url-env <name>) [options]
  pgdumpster inspect <bundle-directory|archive.tar.zst|archive.tar.zst.age|s3://backup-locator/> [--json]
  pgdumpster coverage <bundle-directory|archive.tar.zst|archive.tar.zst.age|s3://backup-locator/> [--json]
  pgdumpster verify <bundle-directory|archive.tar.zst|archive.tar.zst.age|s3://backup-locator/> [--json]
  pgdumpster restore <bundle-directory|archive.tar.zst|archive.tar.zst.age|s3://backup-locator/> --target-project-ref <ref> --target-db-url-env <name> (--dry-run|--apply) [--resume <checkpoint>]
  pgdumpster --version
  pgdumpster --help
`;

interface ParsedGlobalArguments {
  json: boolean;
  configPath?: string;
  positional: string[];
}

interface ParsedBackupArguments {
  projectRef?: string;
  linked: boolean;
  dbUrlEnvironment?: string;
  output?: string;
  consistency?: "verified" | "best-effort" | "quiesced";
  maxStorageConcurrency?: number;
  maxApiConcurrency?: number;
  allowPlaintextSecrets: boolean;
  archive: boolean;
  resume?: string;
}

interface ParsedRestoreArguments {
  targetProjectRef?: string;
  targetDbUrlEnvironment?: string;
  mode?: "dry-run" | "apply";
  conflictPolicy: "fail" | "replace";
  allowBillableResources: boolean;
  resume?: string;
}

function positiveInteger(value: string | undefined, option: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value))
    throw new Error(`${option} requires a positive integer`);
  return Number(value);
}

function parseBackupArguments(args: readonly string[]): ParsedBackupArguments {
  const parsed: ParsedBackupArguments = {
    linked: false,
    allowPlaintextSecrets: false,
    archive: false,
  };
  const valueOption = (index: number, option: string): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--linked") parsed.linked = true;
    else if (argument === "--allow-plaintext-secrets")
      parsed.allowPlaintextSecrets = true;
    else if (argument === "--archive") parsed.archive = true;
    else if (argument === "--project-ref") {
      parsed.projectRef = valueOption(index, argument);
      index += 1;
    } else if (argument === "--db-url-env") {
      parsed.dbUrlEnvironment = valueOption(index, argument);
      index += 1;
    } else if (argument === "--output") {
      parsed.output = valueOption(index, argument);
      index += 1;
    } else if (argument === "--consistency") {
      const value = valueOption(index, argument);
      if (
        value !== "verified" &&
        value !== "best-effort" &&
        value !== "quiesced"
      )
        throw new Error("--consistency is invalid");
      parsed.consistency = value;
      index += 1;
    } else if (argument === "--max-storage-concurrency") {
      parsed.maxStorageConcurrency = positiveInteger(
        valueOption(index, argument),
        argument,
      );
      index += 1;
    } else if (argument === "--max-api-concurrency") {
      parsed.maxApiConcurrency = positiveInteger(
        valueOption(index, argument),
        argument,
      );
      index += 1;
    } else if (argument === "--resume") {
      parsed.resume = valueOption(index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown backup option: ${argument}`);
    }
  }
  if (parsed.linked === (parsed.dbUrlEnvironment !== undefined)) {
    throw new Error("Specify exactly one of --linked or --db-url-env <name>");
  }
  return parsed;
}

function backupName(now: Date): string {
  return `pgdumpster-${now.toISOString().replaceAll(":", "-")}`;
}

function parseRestoreArguments(
  args: readonly string[],
): ParsedRestoreArguments {
  const parsed: ParsedRestoreArguments = {
    conflictPolicy: "fail",
    allowBillableResources: false,
  };
  const valueOption = (index: number, option: string): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--target-project-ref") {
      parsed.targetProjectRef = valueOption(index, argument);
      index += 1;
    } else if (argument === "--target-db-url-env") {
      parsed.targetDbUrlEnvironment = valueOption(index, argument);
      index += 1;
    } else if (argument === "--dry-run" || argument === "--apply") {
      if (parsed.mode !== undefined)
        throw new Error("Specify exactly one of --dry-run or --apply");
      parsed.mode = argument === "--dry-run" ? "dry-run" : "apply";
    } else if (argument === "--conflict") {
      const value = valueOption(index, argument);
      if (value !== "fail" && value !== "replace")
        throw new Error("--conflict must be fail or replace");
      parsed.conflictPolicy = value;
      index += 1;
    } else if (argument === "--allow-billable-resources") {
      parsed.allowBillableResources = true;
    } else if (argument === "--resume") {
      parsed.resume = valueOption(index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown restore option: ${argument}`);
    }
  }
  if (parsed.targetProjectRef === undefined)
    throw new Error("--target-project-ref is required");
  if (parsed.targetDbUrlEnvironment === undefined)
    throw new Error("--target-db-url-env is required");
  if (parsed.mode === undefined)
    throw new Error("Specify exactly one of --dry-run or --apply");
  return parsed;
}

function configurationHash(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseGlobalArguments(argv: readonly string[]): ParsedGlobalArguments {
  const positional: string[] = [];
  let json = false;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      if (json) throw new Error("--json may only be specified once");
      json = true;
    } else if (argument === "--config") {
      if (configPath !== undefined) {
        throw new Error("--config may only be specified once");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--config requires a path");
      }
      configPath = value;
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  return {
    json,
    positional,
    ...(configPath === undefined ? {} : { configPath }),
  };
}

function doctorProjectRef(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--project-ref") return args[1];
  throw new Error("Usage: pgdumpster doctor [--project-ref <ref>] [--json]");
}

function doctorHuman(report: DoctorReport): string {
  const lines = [`pgDumpster doctor  ${report.ok ? "PASS" : "FAIL"}`, ""];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(7)}  ${check.id}  ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function doctorExitCode(report: DoctorReport): number {
  if (report.ok) return 0;
  return report.checks.some(
    ({ id, status }) => status === "failed" && id.startsWith("auth."),
  )
    ? 3
    : 4;
}

function errorExitCode(error: unknown): number {
  const category = (error as Partial<PgDumpsterError> | undefined)?.category;
  if (category === "config") return 2;
  if (category === "auth") return 3;
  if (category === "dependency") return 4;
  if (
    category === "network" ||
    category === "rate_limit" ||
    category === "database" ||
    category === "storage" ||
    category === "edge" ||
    category === "control_plane"
  )
    return 5;
  if (category === "consistency") return 6;
  if (category === "destination" || category === "io") return 8;
  if (category === "platform_contract") return 9;
  if (category === "cancelled") return 10;
  return 7;
}

async function version(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof pkg.version !== "string")
    throw new Error("Package version is invalid");
  return pkg.version;
}

function restoreCheckpointPath(planId: string): string {
  return path.resolve(".pgdumpster-restore", `${planId}.checkpoint.json`);
}

export async function preflightPlannedRestoreArtifacts(
  bundleRoot: string,
  plan: Pick<RestorePlan, "actions">,
): Promise<void> {
  for (const action of plan.actions) {
    if (action.status !== "planned") continue;
    for (const artifact of action.artifacts) {
      try {
        const direct = path.join(bundleRoot, ...artifact.split("/"));
        const directStat = await lstat(direct);
        if (directStat.isSymbolicLink()) {
          throw new Error("symlink");
        }
        await resolveBundleArtifact(bundleRoot, artifact);
      } catch (cause) {
        throw new DomainError({
          code: "RESTORE_ARTIFACT_INVALID",
          category: "integrity",
          message: "A planned restore artifact is unavailable or unsafe.",
          retryable: false,
          component: action.component,
          cause,
        });
      }
    }
  }
}

async function readResumeCheckpoint(filename: string) {
  const resolved = path.resolve(filename);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) {
    throw new DomainError({
      code: "RESTORE_CHECKPOINT_INVALID",
      category: "restore_policy",
      message: "Restore resume checkpoint must be a bounded regular file.",
      retryable: false,
    });
  }
  return {
    path: resolved,
    checkpoint: restoreCheckpointSchema.parse(
      JSON.parse(await readFile(resolved, "utf8")),
    ),
  };
}

export async function runCli(
  argv: readonly string[],
  io: Io,
  context: CliContext = {},
): Promise<number> {
  let globals: ParsedGlobalArguments;
  try {
    globals = parseGlobalArguments(argv);
  } catch (error) {
    io.stderr(
      `${error instanceof Error ? error.message : "Invalid options"}\n`,
    );
    return 2;
  }
  const { json, positional } = globals;
  const [command, bundlePath, ...extra] = positional;

  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${await version()}\n`);
    return 0;
  }
  const redactor = new Redactor();
  if (command === "doctor") {
    try {
      const cliProjectRef = doctorProjectRef(positional.slice(1));
      const loadedConfig =
        globals.configPath === undefined
          ? undefined
          : await loadConfigFile(globals.configPath);
      const projectRef = cliProjectRef ?? loadedConfig?.config.projectRef;
      const source = loadSourceEnvironment(
        context.environment ?? process.env,
        redactor,
        projectRef === undefined ? {} : { projectRef },
      );
      const management = new ManagementClient({
        accessToken: source.accessToken,
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      });
      const report = await runDoctor(
        source,
        management,
        context.doctorDependencies,
      );
      io.stdout(json ? `${JSON.stringify(report)}\n` : doctorHuman(report));
      return doctorExitCode(report);
    } catch (error) {
      const serialized = serializeError(error, redactor);
      io.stderr(
        json
          ? `${JSON.stringify(serialized)}\n`
          : `${serialized.message}\nError: ${serialized.code}\n`,
      );
      return errorExitCode(error);
    }
  }
  if (command === "backup") {
    const redactor = new Redactor();
    try {
      const args = parseBackupArguments(positional.slice(1));
      const loadedConfig =
        globals.configPath === undefined
          ? undefined
          : await loadConfigFile(globals.configPath);
      const destination =
        loadedConfig?.config.destination ?? ({ type: "local" } as const);
      const encryption =
        loadedConfig?.config.encryption ?? ({ mode: "none" } as const);
      if (encryption.mode === "age" && encryption.recipient === undefined) {
        throw new DomainError({
          code: "CONFIG_MISSING_REQUIRED",
          category: "config",
          message: "age backup encryption requires encryption.recipient.",
          retryable: false,
        });
      }
      const encryptedOutput = encryption.mode === "age";
      const allowProtectedWorkspace =
        args.allowPlaintextSecrets || encryptedOutput;
      if (!allowProtectedWorkspace) {
        throw new DomainError({
          code: "PLAINTEXT_SECRETS_NOT_ALLOWED",
          category: "security",
          message:
            "Plaintext backup requires explicit --allow-plaintext-secrets when age encryption is not configured.",
          retryable: false,
        });
      }
      const environment = context.environment ?? process.env;
      let checkpoint:
        ReturnType<typeof backupCheckpointSchema.parse> | undefined;
      let workspaceRoot: string;
      let checkpointPath: string;
      if (args.resume !== undefined) {
        const resumePath = path.resolve(args.resume);
        const resumeStat = await lstat(resumePath);
        if (resumeStat.isFile() && !resumeStat.isSymbolicLink()) {
          checkpointPath = resumePath;
          workspaceRoot = resumePath.endsWith(".checkpoint.json")
            ? resumePath.slice(0, -".checkpoint.json".length)
            : `${resumePath}.workspace`;
        } else if (resumeStat.isDirectory() && !resumeStat.isSymbolicLink()) {
          workspaceRoot = resumePath;
          checkpointPath = `${resumePath}.checkpoint.json`;
        } else {
          throw new Error(
            "--resume must reference a real workspace or checkpoint file",
          );
        }
        checkpoint = backupCheckpointSchema.parse(
          JSON.parse(await readFile(checkpointPath, "utf8")),
        );
      } else {
        const configuredOutput =
          args.output ??
          loadedConfig?.config.backup.output ??
          path.resolve("backups");
        const outputRoot = path.resolve(configuredOutput);
        await mkdir(outputRoot, { recursive: true, mode: 0o700 });
        const outputStat = await lstat(outputRoot);
        if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
          throw new Error("Backup output must be a real directory");
        }
        workspaceRoot = path.join(
          outputRoot,
          backupName((context.now ?? (() => new Date()))()),
        );
        await mkdir(workspaceRoot, { recursive: false, mode: 0o700 });
        checkpointPath = `${workspaceRoot}.checkpoint.json`;
      }
      const projectRef =
        args.projectRef ??
        loadedConfig?.config.projectRef ??
        checkpoint?.projectRef;
      const source = loadSourceEnvironment(
        environment,
        redactor,
        projectRef === undefined ? {} : { projectRef },
      );
      let databaseUrl: SecretValue | undefined;
      if (args.dbUrlEnvironment !== undefined) {
        const value = environment[args.dbUrlEnvironment];
        if (value === undefined || value.length === 0) {
          throw new DomainError({
            code: "CONFIG_MISSING_REQUIRED",
            category: "config",
            message: `Required database URL environment variable ${args.dbUrlEnvironment} is not set.`,
            retryable: false,
            details: { variable: args.dbUrlEnvironment },
          });
        }
        databaseUrl = new SecretValue(value, redactor);
      }
      const consistency =
        args.consistency ??
        loadedConfig?.config.backup.consistency ??
        "verified";
      const maxStorageConcurrency =
        args.maxStorageConcurrency ??
        loadedConfig?.config.backup.maxStorageConcurrency ??
        8;
      const maxApiConcurrency =
        args.maxApiConcurrency ??
        loadedConfig?.config.backup.maxApiConcurrency ??
        3;
      if (maxStorageConcurrency > 64 || maxApiConcurrency > 16) {
        throw new Error("Backup concurrency exceeds the supported bound");
      }
      const immutableConfigSha256 = configurationHash({
        projectRef: source.projectRef,
        databaseMode: args.linked ? "linked" : args.dbUrlEnvironment,
        consistency,
        maxStorageConcurrency,
        maxApiConcurrency,
        allowPlaintextSecrets: args.allowPlaintextSecrets,
        encryptionMode: encryption.mode,
        encryptionRecipient:
          encryption.mode === "age" ? encryption.recipient : undefined,
        destination,
      });
      const runId = checkpoint?.runId ?? (context.randomUUID ?? randomUUID)();
      const startedAt =
        checkpoint?.createdAt ??
        (context.now ?? (() => new Date()))().toISOString();
      const management = new ManagementClient({
        accessToken: source.accessToken,
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
      });
      const completed = await (context.backupExecutor ?? executeProductBackup)({
        workspaceRoot,
        checkpointPath,
        runId,
        projectRef: source.projectRef,
        immutableConfigSha256,
        toolVersion: await version(),
        startedAt,
        consistency,
        management,
        redactor,
        ...(databaseUrl === undefined ? {} : { databaseUrl }),
        ...(args.linked ? { linked: true } : {}),
        ...(source.storageKey === undefined
          ? {}
          : { storageKey: source.storageKey }),
        allowPlaintextSecrets: allowProtectedWorkspace,
        maxStorageConcurrency,
        maxApiConcurrency,
        ...(checkpoint === undefined ? {} : { resume: true }),
      });
      const publication = await publishBackupOutput({
        workspaceRoot,
        checkpointPath,
        runId,
        destination,
        encryption,
        archiveRequested: args.archive,
        resume: checkpoint !== undefined,
        environment,
        ...(context.archivePacker === undefined
          ? {}
          : { archivePacker: context.archivePacker }),
        ...(context.ageEncryptor === undefined
          ? {}
          : { ageEncryptor: context.ageEncryptor }),
        ...(context.s3Publisher === undefined
          ? {}
          : { s3Publisher: context.s3Publisher }),
      });
      const outputPath = publication.output;
      const final = {
        schemaVersion: 1,
        type: "backup.result",
        runId,
        status: completed.manifest.result.status,
        consistency: completed.manifest.result.consistency,
        output: outputPath,
        coverageCount: completed.coverage.components.length,
        ...(publication.remote === undefined
          ? {}
          : {
              remote: {
                object: publication.remote.objectUri,
                marker: publication.remote.markerUri,
                size: publication.remote.size,
                sha256: publication.remote.sha256,
                recovered: publication.remote.recovered,
              },
            }),
      };
      io.stdout(
        json
          ? `${JSON.stringify(final)}\n`
          : `BACKUP ${final.status.toUpperCase()}\n${outputPath}\n`,
      );
      return final.status === "failed" ? 7 : 0;
    } catch (error) {
      const serialized = serializeError(error, redactor);
      io.stderr(
        json
          ? `${JSON.stringify(serialized)}\n`
          : `${serialized.message}\nError: ${serialized.code}\n`,
      );
      return errorExitCode(error);
    }
  }
  if (command === "restore") {
    const redactor = new Redactor();
    try {
      if (bundlePath === undefined)
        throw new Error("restore requires a bundle directory or archive");
      const args = parseRestoreArguments(extra);
      const loadedConfig =
        globals.configPath === undefined
          ? undefined
          : await loadConfigFile(globals.configPath);
      const targetProjectRef = args.targetProjectRef!;
      const targetDbUrlEnvironment = args.targetDbUrlEnvironment!;
      const environment = context.environment ?? process.env;
      const resume =
        args.resume === undefined
          ? undefined
          : await readResumeCheckpoint(args.resume);
      const outcome = await withConfiguredBundleInput(
        bundlePath,
        loadedConfig,
        async (bundle) => {
          const plan = await buildRestorePlan(
            bundle.manifest,
            bundle.coverage,
            {
              planId:
                resume?.checkpoint.planId ??
                (context.randomUUID ?? randomUUID)(),
              createdAt:
                resume?.checkpoint.createdAt ??
                (context.now ?? (() => new Date()))().toISOString(),
              targetProjectRef,
              conflictPolicy: args.conflictPolicy,
              allowBillableResources: args.allowBillableResources,
            },
          );
          if (args.mode !== "apply") return { plan };
          assertRestorePlanExecutable(plan);
          const targetDatabaseUrl = environment[targetDbUrlEnvironment];
          if (
            targetDatabaseUrl === undefined ||
            targetDatabaseUrl.length === 0
          ) {
            throw new DomainError({
              code: "CONFIG_MISSING_REQUIRED",
              category: "config",
              message: `Required target database URL environment variable ${targetDbUrlEnvironment} is not set.`,
              retryable: false,
              details: { variable: targetDbUrlEnvironment },
            });
          }
          const targetDatabase = new SecretValue(targetDatabaseUrl, redactor);
          const target = loadSourceEnvironment(environment, redactor, {
            projectRef: targetProjectRef,
          });
          const management = new ManagementClient({
            accessToken: target.accessToken,
            ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
          });
          const storageComponents = new Set([
            "storage.file_buckets",
            "storage.file_objects",
            "storage.file_metadata",
            "storage.vector_buckets",
            "storage.vector_indexes",
            "storage.vectors",
          ]);
          const storageRequired = plan.actions.some(
            (action) =>
              action.status === "planned" &&
              storageComponents.has(action.component),
          );
          const storageKey = storageRequired
            ? await discoverPrivilegedStorageKey(
                management,
                targetProjectRef,
                redactor,
              )
            : undefined;
          if (storageRequired && storageKey === undefined) {
            throw new DomainError({
              code: "RESTORE_TARGET_STORAGE_KEY_UNAVAILABLE",
              category: "auth",
              message:
                "A target privileged Storage credential could not be obtained from the Management API.",
              retryable: false,
            });
          }
          const handlers = {
            ...createDatabaseRestoreHandlers({
              bundleRoot: bundle.root,
              targetDatabaseUrl: targetDatabase,
            }),
            ...createDatabaseSupplementRestoreHandlers({
              bundleRoot: bundle.root,
              targetDatabaseUrl: targetDatabase,
              conflictPolicy: args.conflictPolicy,
            }),
            "database.publications": createPublicationRestoreHandler({
              bundleRoot: bundle.root,
              targetDatabaseUrl: targetDatabase,
              conflictPolicy: args.conflictPolicy,
            }),
            "database.vault_root_key": createVaultRootKeyRestoreHandler({
              bundleRoot: bundle.root,
              targetProjectRef,
              targetDatabaseUrl: targetDatabase,
              client: management,
              redactor,
            }),
            ...createControlPlaneRestoreHandlers({
              bundleRoot: bundle.root,
              targetProjectRef,
              conflictPolicy: args.conflictPolicy,
              client: management,
            }),
            ...(storageKey === undefined
              ? {}
              : {
                  ...createFileStorageRestoreHandlers({
                    bundleRoot: bundle.root,
                    targetProjectRef,
                    targetDatabaseUrl: targetDatabase,
                    storageKey,
                    conflictPolicy: args.conflictPolicy,
                  }),
                  ...createVectorStorageRestoreHandlers({
                    bundleRoot: bundle.root,
                    targetProjectRef,
                    storageKey,
                    conflictPolicy: args.conflictPolicy,
                  }),
                }),
            "edge.functions": createEdgeFunctionRestoreHandler({
              bundleRoot: bundle.root,
              targetProjectRef,
              accessToken: target.accessToken,
              conflictPolicy: args.conflictPolicy,
              ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
            }),
            "auth.config": createAuthConfigRestoreHandler({
              bundleRoot: bundle.root,
              targetProjectRef,
              client: management,
            }),
            "auth.sso": createAuthSsoRestoreHandler({
              bundleRoot: bundle.root,
              targetProjectRef,
              conflictPolicy: args.conflictPolicy,
              client: management,
            }),
            "auth.tpa": createAuthTpaRestoreHandler({
              bundleRoot: bundle.root,
              targetProjectRef,
              conflictPolicy: args.conflictPolicy,
              client: management,
            }),
            "api.modern_keys": createApiKeyRestoreHandler({
              bundleRoot: bundle.root,
              sourceProjectRef: bundle.manifest.source.projectRef,
              targetProjectRef,
              rotationMapPath: path.join(
                path.dirname(
                  resume?.path ?? restoreCheckpointPath(plan.planId),
                ),
                `${plan.planId}.api-key-rotation.json`,
              ),
              client: management,
              registerSecret: (value) => {
                redactor.register(value);
              },
            }),
            "api.legacy_keys_state": createLegacyApiKeyRestoreHandler({
              bundleRoot: bundle.root,
              targetProjectRef,
              conflictPolicy: args.conflictPolicy,
              client: management,
            }),
          };
          validatePlanForExecution(plan, handlers);
          await preflightPlannedRestoreArtifacts(bundle.root, plan);
          const checkpointPath =
            resume?.path ?? restoreCheckpointPath(plan.planId);
          if (resume === undefined)
            await mkdir(path.dirname(checkpointPath), {
              recursive: true,
              mode: 0o700,
            });
          const result = await (context.restoreExecutor ?? executeRestore)({
            plan,
            checkpointPath,
            handlers,
            ...(resume === undefined ? {} : { resume: true }),
          });
          const parityReportPath = path.join(
            path.dirname(checkpointPath),
            `${plan.planId}.parity.json`,
          );
          await writeRestoreParityReport(
            parityReportPath,
            createRestoreParityReport(plan, result),
          );
          return { plan, result, checkpointPath, parityReportPath };
        },
        {
          environment,
          ...(context.ageDecryptor === undefined
            ? {}
            : { ageDecryptor: context.ageDecryptor }),
          ...(context.s3Materializer === undefined
            ? {}
            : { s3Materializer: context.s3Materializer }),
        },
      );
      if (outcome.result !== undefined) {
        const { result, checkpointPath, parityReportPath } = outcome;
        io.stdout(
          json
            ? `${JSON.stringify({ ...result, checkpointPath, parityReportPath })}\n`
            : `RESTORE ${result.status.toUpperCase()}\n${result.completedActions} actions completed\n${checkpointPath}\n${parityReportPath}\n`,
        );
        return 0;
      }
      io.stdout(
        json
          ? `${JSON.stringify(outcome.plan)}\n`
          : `RESTORE PLAN ${outcome.plan.status.toUpperCase()}\n${outcome.plan.actions.length} actions, ${outcome.plan.manualActions.length} manual actions\n`,
      );
      return 0;
    } catch (error) {
      const serialized = serializeError(error, redactor);
      io.stderr(
        json
          ? `${JSON.stringify(serialized)}\n`
          : `${serialized.message}\nError: ${serialized.code}\n`,
      );
      return errorExitCode(error);
    }
  }
  if (
    !(["inspect", "coverage", "verify"] as const).includes(command as never)
  ) {
    io.stderr(`Unknown command: ${command}\n`);
    return 2;
  }
  if (bundlePath === undefined || extra.length > 0) {
    io.stderr(`Usage error for ${command}. Run pgdumpster --help.\n`);
    return 2;
  }

  try {
    const loadedConfig =
      globals.configPath === undefined
        ? undefined
        : await loadConfigFile(globals.configPath);
    await withConfiguredBundleInput(
      bundlePath,
      loadedConfig,
      (bundle) => {
        if (command === "verify") {
          const result = { status: "verified", files: bundle.checksums.size };
          io.stdout(
            json
              ? `${JSON.stringify(result)}\n`
              : `VERIFIED  ${result.files} files\n`,
          );
        } else if (command === "coverage") {
          io.stdout(
            json
              ? `${JSON.stringify(bundle.coverage)}\n`
              : `${bundle.coverage.components.map(({ id, status }) => `${status.padEnd(16)} ${id}`).join("\n")}\n`,
          );
        } else {
          const inspection = inspectVerifiedBundle(bundle);
          io.stdout(
            json
              ? `${JSON.stringify(inspection)}\n`
              : `${JSON.stringify(inspection, null, 2)}\n`,
          );
        }
      },
      {
        environment: context.environment ?? process.env,
        ...(context.ageDecryptor === undefined
          ? {}
          : { ageDecryptor: context.ageDecryptor }),
        ...(context.s3Materializer === undefined
          ? {}
          : { s3Materializer: context.s3Materializer }),
      },
    );
    return 0;
  } catch (error) {
    const serialized = serializeError(error, redactor);
    io.stderr(
      json
        ? `${JSON.stringify(serialized)}\n`
        : `${serialized.message}\nError: ${serialized.code}\n`,
    );
    return errorExitCode(error);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  });
}
