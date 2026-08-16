// @ts-check

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { z } from "zod";

const MAX_COMMAND_OUTPUT_BYTES = 65_536;
const projectRefPattern = /^[a-z0-9]{20}$/u;
const restoreArtifactNamePattern =
  /^[0-9a-f-]{36}\.(?:api-key-rotation|checkpoint|parity|plan)\.json$/u;
const commandOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
});
const cleanTargetSchema = z
  .object({
    rows: z
      .array(
        z.object({ fixture_absent: z.boolean(), storage_empty: z.boolean() }),
      )
      .min(1),
  })
  .passthrough();
const backupSchema = z.object({
  status: z.enum(["complete", "complete_with_platform_limits", "failed"]),
  output: z.string(),
});
const verificationSchema = z.object({ status: z.literal("verified") });
const coverageSchema = z.object({
  components: z.array(z.object({ status: z.string() }).passthrough()),
});
const planSchema = z.object({ target: z.object({ projectRef: z.string() }) });
const restoreSchema = z.object({
  status: z.enum(["restored", "restored_with_platform_limits"]),
  parityReportPath: z.string(),
  manualActions: z
    .array(z.object({ component: z.string(), reasonCode: z.string() }))
    .optional(),
});
const smokeSchema = z
  .object({
    rows: z.array(
      z.object({
        accounts: z.number(),
        jobs: z.number(),
        valid_checksums: z.number(),
        rls_policies: z.number(),
        realtime_membership: z.number(),
        user_triggers: z.number(),
      }),
    ),
  })
  .passthrough();
const storageObjectsSchema = z
  .object({
    rows: z
      .array(z.object({ bucket: z.string().min(1), name: z.string().min(1) }))
      .min(1),
  })
  .passthrough();
const paritySchema = z.object({
  status: z.enum(["restored", "restored_with_platform_limits"]),
  manualActions: z.array(
    z.object({ component: z.string(), reasonCode: z.string() }),
  ),
});

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Missing required live-E2E environment variable: ${name}`);
  return value;
}

/** @param {string} name */
function projectRef(name) {
  const value = required(name);
  if (!projectRefPattern.test(value))
    throw new Error(`${name} is not a Supabase project ref.`);
  return value;
}

/** @param {string} name @param {string} ref */
function databaseUrl(name, ref) {
  const value = required(name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a database URL.`);
  }
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.username !== `postgres.${ref}` ||
    (!parsed.hostname.endsWith(".pooler.supabase.com") &&
      parsed.hostname !== `db.${ref}.supabase.co`)
  )
    throw new Error(`${name} does not bind to ${ref}.`);
  return value;
}

/**
 * @param {string} commandName
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} environment
 * @returns {Promise<z.infer<typeof commandOutputSchema>>}
 */
function command(commandName, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      windowsHide: true,
    });
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    /** @param {string[]} destination @param {{ value: number }} currentBytes */
    const collect =
      (destination, currentBytes) => /** @param {Buffer} chunk */ (chunk) => {
        if (currentBytes.value >= MAX_COMMAND_OUTPUT_BYTES) return;
        const text = chunk.toString("utf8");
        const remaining = MAX_COMMAND_OUTPUT_BYTES - currentBytes.value;
        destination.push(text.slice(0, remaining));
        currentBytes.value += Buffer.byteLength(text, "utf8");
      };
    const stdoutCounter = { value: 0 };
    const stderrCounter = { value: 0 };
    child.stdout.on("data", collect(stdout, stdoutCounter));
    child.stderr.on("data", collect(stderr, stderrCounter));
    child.once("error", () => {
      reject(new Error(`${commandName} could not start.`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve(
          commandOutputSchema.parse({
            stdout: stdout.join(""),
            stderr: stderr.join(""),
          }),
        );
        return;
      }
      reject(
        new Error(`${commandName} exited with code ${code ?? "unknown"}.`),
      );
    });
  });
}

/**
 * @template T
 * @param {string} output
 * @param {string} operation
 * @param {z.ZodType<T>} schema
 * @returns {T}
 */
function lastJson(output, operation, schema) {
  const lines = output.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      return schema.parse(JSON.parse(line));
    } catch {
      // CLI status output can precede JSON in future versions.
    }
  }
  throw new Error(`${operation} did not produce a machine-readable result.`);
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} environment */
async function cli(args, environment) {
  return command(process.execPath, ["dist/cli/main.js", ...args], environment);
}

/** @param {string} database @param {string[]} args @param {NodeJS.ProcessEnv} environment */
async function supabaseQuery(database, args, environment) {
  return command(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "supabase", "db", "query", "--db-url", database, ...args],
    environment,
  );
}

/** @param {string} targetDatabaseUrl @param {NodeJS.ProcessEnv} environment */
async function assertCleanTarget(targetDatabaseUrl, environment) {
  const { stdout } = await supabaseQuery(
    targetDatabaseUrl,
    [
      "select to_regclass('pgdumpster_e2e.jobs') is null as fixture_absent, (select count(*) from storage.buckets) = 0 as storage_empty",
      "--output",
      "json",
    ],
    environment,
  );
  const result = cleanTargetSchema.parse(JSON.parse(stdout));
  const row = result.rows[0];
  if (row.fixture_absent !== true || row.storage_empty !== true)
    throw new Error(
      "Target is not clean. Reset or recreate the protected disposable target before running live E2E.",
    );
}

/** @param {string} projectRef @param {string} bucket @param {string} name */
function storageObjectUrl(projectRef, bucket, name) {
  const segments = name.split("/");
  if (
    name.includes("\0") ||
    segments.some((segment) => segment === "." || segment === "..")
  )
    throw new Error("Storage smoke object identity is invalid.");
  return `https://${projectRef}.supabase.co/storage/v1/object/${encodeURIComponent(bucket)}/${segments.map(encodeURIComponent).join("/")}`;
}

/** @param {string} url @param {string} key */
async function storageDigest(url, key) {
  const response = await globalThis.fetch(url, {
    headers: { authorization: `Bearer ${key}`, apikey: key },
  });
  if (!response.ok || response.body === null)
    throw new Error("Storage smoke object could not be read.");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** @param {string} directory @returns {Promise<Set<string>>} */
async function restoreDirectoryEntries(directory) {
  try {
    return new Set(await readdir(directory));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return new Set();
    throw error;
  }
}

/** @param {string} directory @param {ReadonlySet<string>} previousEntries */
async function removeNewRestoreArtifacts(directory, previousEntries) {
  const currentEntries = await restoreDirectoryEntries(directory);
  for (const entry of currentEntries) {
    if (previousEntries.has(entry)) continue;
    if (!restoreArtifactNamePattern.test(entry))
      throw new Error("Live E2E created an unexpected restore artifact.");
    const filename = path.join(directory, entry);
    const artifact = await lstat(filename);
    if (!artifact.isFile() || artifact.isSymbolicLink())
      throw new Error("Live E2E restore artifact is not a regular file.");
    await rm(filename, { force: true });
  }
  if (previousEntries.size === 0) await rmdir(directory).catch(() => undefined);
}

async function main() {
  const sourceProjectRef = projectRef("PGDUMPSTER_E2E_SOURCE_PROJECT_REF");
  const targetProjectRef = projectRef("PGDUMPSTER_E2E_TARGET_PROJECT_REF");
  if (sourceProjectRef === targetProjectRef)
    throw new Error("Live E2E source and target project refs must differ.");
  const sourceDatabaseUrl = databaseUrl(
    "PGDUMPSTER_E2E_SOURCE_DB_URL",
    sourceProjectRef,
  );
  const targetDatabaseUrl = databaseUrl(
    "PGDUMPSTER_E2E_TARGET_DB_URL",
    targetProjectRef,
  );
  const recipient = required("PGDUMPSTER_E2E_AGE_RECIPIENT");
  const identityFile = required("PGDUMPSTER_E2E_AGE_IDENTITY_FILE");
  const accessToken = required("PGDUMPSTER_ACCESS_TOKEN");
  const sourceStorageKey = required("PGDUMPSTER_E2E_SOURCE_STORAGE_KEY");
  const targetStorageKey = required("PGDUMPSTER_E2E_TARGET_STORAGE_KEY");
  const root = await mkdtemp(path.join(tmpdir(), "pgdumpster-live-e2e-"));
  const configPath = path.join(root, "pgdumpster.yaml");
  const restoreDirectory = path.join(process.cwd(), ".pgdumpster-restore");
  const previousRestoreEntries =
    await restoreDirectoryEntries(restoreDirectory);
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...process.env,
    PGDUMPSTER_ACCESS_TOKEN: accessToken,
    PGDUMPSTER_E2E_SOURCE_DB_URL: sourceDatabaseUrl,
    PGDUMPSTER_E2E_TARGET_DB_URL: targetDatabaseUrl,
    PGDUMPSTER_DB_URL: sourceDatabaseUrl,
    PGDUMPSTER_STORAGE_KEY: sourceStorageKey,
  };
  try {
    await writeFile(
      configPath,
      [
        `projectRef: ${sourceProjectRef}`,
        "backup:",
        `  output: ${path.join(root, "backups").replaceAll("\\", "/")}`,
        "  consistency: verified",
        "encryption:",
        "  mode: age",
        `  recipient: ${recipient}`,
        `  identityFile: ${identityFile.replaceAll("\\", "/")}`,
        "destination:",
        "  type: local",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );

    await assertCleanTarget(targetDatabaseUrl, environment);
    await supabaseQuery(
      sourceDatabaseUrl,
      ["--file", "scripts/live-e2e-fixture.sql"],
      environment,
    );
    const doctor = lastJson(
      (
        await cli(
          ["doctor", "--project-ref", sourceProjectRef, "--json"],
          environment,
        )
      ).stdout,
      "doctor",
      z.object({ ok: z.boolean() }).passthrough(),
    );
    if (!doctor.ok)
      throw new Error("Doctor did not report a ready source project.");

    const backup = lastJson(
      (
        await cli(
          [
            "--config",
            configPath,
            "--non-interactive",
            "backup",
            "--project-ref",
            sourceProjectRef,
            "--db-url-env",
            "PGDUMPSTER_E2E_SOURCE_DB_URL",
            "--output",
            path.join(root, "backups"),
            "--consistency",
            "verified",
            "--json",
          ],
          environment,
        )
      ).stdout,
      "backup",
      backupSchema,
    );
    if (
      backup.status !== "complete" &&
      backup.status !== "complete_with_platform_limits"
    )
      throw new Error("Live backup did not reach a terminal successful state.");
    const bundle = backup.output;
    if (typeof bundle !== "string")
      throw new Error("Backup did not return an output path.");

    const verification = lastJson(
      (
        await cli(
          ["--config", configPath, "verify", bundle, "--json"],
          environment,
        )
      ).stdout,
      "offline verification",
      verificationSchema,
    );
    const coverage = lastJson(
      (
        await cli(
          ["--config", configPath, "coverage", bundle, "--json"],
          environment,
        )
      ).stdout,
      "coverage inspection",
      coverageSchema,
    );
    if (coverage.components.some((entry) => entry.status === "failed"))
      throw new Error("Coverage inspection contains a failed component.");

    const restoreArguments = [
      "--config",
      configPath,
      "--non-interactive",
      "restore",
      bundle,
      "--target-project-ref",
      targetProjectRef,
      "--target-db-url-env",
      "PGDUMPSTER_E2E_TARGET_DB_URL",
    ];
    const plan = lastJson(
      (await cli([...restoreArguments, "--dry-run", "--json"], environment))
        .stdout,
      "restore dry-run",
      planSchema,
    );
    if (plan.target.projectRef !== targetProjectRef)
      throw new Error("Restore dry-run target binding is invalid.");
    const restore = lastJson(
      (await cli([...restoreArguments, "--apply", "--json"], environment))
        .stdout,
      "restore apply",
      restoreSchema,
    );
    const parity = paritySchema.parse(
      JSON.parse(await readFile(restore.parityReportPath, "utf8")),
    );
    if (
      parity.status !== restore.status ||
      parity.manualActions.length !== (restore.manualActions?.length ?? 0)
    )
      throw new Error("Restore parity report does not match the apply result.");

    const smokeSql =
      "select (select count(*) from pgdumpster_e2e.accounts) as accounts, (select count(*) from pgdumpster_e2e.jobs) as jobs, (select count(*) from pgdumpster_e2e.jobs where checksum = encode(digest(payload::text, 'sha256'), 'hex')) as valid_checksums, (select count(*) from pg_policies where schemaname = 'pgdumpster_e2e') as rls_policies, (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'pgdumpster_e2e' and tablename = 'jobs') as realtime_membership, (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgdumpster_e2e' and c.relname = 'jobs' and not t.tgisinternal) as user_triggers";
    const [sourceSmoke, targetSmoke] = await Promise.all([
      supabaseQuery(
        sourceDatabaseUrl,
        [smokeSql, "--output", "json"],
        environment,
      ),
      supabaseQuery(
        targetDatabaseUrl,
        [smokeSql, "--output", "json"],
        environment,
      ),
    ]);
    const sourceRow = smokeSchema.parse(JSON.parse(sourceSmoke.stdout)).rows[0];
    const targetRow = smokeSchema.parse(JSON.parse(targetSmoke.stdout)).rows[0];
    if (JSON.stringify(sourceRow) !== JSON.stringify(targetRow))
      throw new Error(
        "Post-restore database smoke does not match the source fixture.",
      );
    const sourceStorage = storageObjectsSchema.parse(
      JSON.parse(
        (
          await supabaseQuery(
            sourceDatabaseUrl,
            [
              "select b.id as bucket, o.name from storage.objects o join storage.buckets b on b.id = o.bucket_id order by b.id, o.name limit 1",
              "--output",
              "json",
            ],
            environment,
          )
        ).stdout,
      ),
    ).rows[0];
    const sourceObjectUrl = storageObjectUrl(
      sourceProjectRef,
      sourceStorage.bucket,
      sourceStorage.name,
    );
    const targetObjectUrl = storageObjectUrl(
      targetProjectRef,
      sourceStorage.bucket,
      sourceStorage.name,
    );
    const [sourceObject, targetObject] = await Promise.all([
      storageDigest(sourceObjectUrl, sourceStorageKey),
      storageDigest(targetObjectUrl, targetStorageKey),
    ]);
    if (
      sourceObject.bytes !== targetObject.bytes ||
      sourceObject.sha256 !== targetObject.sha256
    )
      throw new Error(
        "Post-restore Storage object smoke does not match the source.",
      );

    const report = {
      schemaVersion: 1,
      type: "live-e2e.result",
      backupStatus: backup.status,
      verificationStatus: verification.status,
      restoreStatus: restore.status,
      parityStatus: parity.status,
      coverageComponents: coverage.components.length,
      databaseSmoke: "matched",
      storageSmoke: "matched",
      manualActions: Array.isArray(restore.manualActions)
        ? restore.manualActions.map(({ component, reasonCode }) => ({
            component,
            reasonCode,
          }))
        : [],
    };
    await writeFile(
      path.join(process.cwd(), "live-e2e-summary.json"),
      `${JSON.stringify(report)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    try {
      await removeNewRestoreArtifacts(restoreDirectory, previousRestoreEntries);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

await main();
