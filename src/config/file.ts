import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";

const MAX_CONFIG_BYTES = 1_048_576;

const s3PrefixSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.split("/").some((segment) => segment === "." || segment === ".."),
  );

const configSchema = z
  .object({
    projectRef: z
      .string()
      .regex(/^[a-z]{20}$/u)
      .optional(),
    backup: z
      .object({
        output: z.string().min(1).default("./backups"),
        consistency: z
          .enum(["verified", "best-effort", "quiesced"])
          .default("verified"),
        maxStorageConcurrency: z.number().int().min(1).max(64).default(8),
        maxApiConcurrency: z.number().int().min(1).max(16).default(3),
        maxConsistencyRetries: z.number().int().min(0).max(20).default(3),
      })
      .strict()
      .default({
        output: "./backups",
        consistency: "verified",
        maxStorageConcurrency: 8,
        maxApiConcurrency: 3,
        maxConsistencyRetries: 3,
      }),
    encryption: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("age"),
            recipient: z.string().startsWith("age1").min(20).optional(),
            identityFile: z.string().min(1).optional(),
          })
          .strict(),
        z.object({ mode: z.literal("none") }).strict(),
      ])
      .default({ mode: "none" }),
    destination: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("local") }).strict(),
        z
          .object({
            type: z.literal("s3"),
            endpoint: z.string().url().startsWith("https://").optional(),
            region: z.string().min(1).max(128).optional(),
            bucket: z.string().min(1).max(255),
            prefix: s3PrefixSchema.optional(),
            forcePathStyle: z.boolean().default(false),
            partSizeMiB: z.number().int().min(5).max(5120).default(64),
            maxConcurrency: z.number().int().min(1).max(16).default(4),
          })
          .strict(),
      ])
      .default({ type: "local" }),
    logging: z
      .object({
        level: z.enum(["error", "warn", "info", "debug"]).default("info"),
        file: z.string().min(1).nullable().default(null),
      })
      .strict()
      .default({ level: "info", file: null }),
  })
  .strict();

export type PgDumpsterConfig = z.infer<typeof configSchema>;

export interface LoadedConfig {
  path: string;
  directory: string;
  config: PgDumpsterConfig;
}

function configError(message: string, cause?: unknown): PgDumpsterError {
  return new PgDumpsterError({
    code: "CONFIG_INVALID",
    category: "config",
    message,
    retryable: false,
    cause,
  });
}

export async function loadConfigFile(filePath: string): Promise<LoadedConfig> {
  const absolute = path.resolve(filePath);
  try {
    const fileStat = await lstat(absolute);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw configError(
        "Configuration path must be a regular non-symlink file.",
      );
    }
    if (fileStat.size > MAX_CONFIG_BYTES) {
      throw configError(`Configuration exceeds ${MAX_CONFIG_BYTES} bytes.`);
    }
    const raw: unknown = parse(await readFile(absolute, "utf8"), {
      maxAliasCount: 0,
      uniqueKeys: true,
    });
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PgDumpsterError({
        code: "CONFIG_INVALID",
        category: "config",
        message: "Configuration does not match the supported schema.",
        retryable: false,
        details: {
          issues: parsed.error.issues.map(({ code, path }) => ({ code, path })),
        },
      });
    }
    const directory = path.dirname(absolute);
    const encryption =
      parsed.data.encryption.mode === "age" &&
      parsed.data.encryption.identityFile !== undefined
        ? {
            ...parsed.data.encryption,
            identityFile: path.resolve(
              directory,
              parsed.data.encryption.identityFile,
            ),
          }
        : parsed.data.encryption;
    return {
      path: absolute,
      directory,
      config: {
        ...parsed.data,
        backup: {
          ...parsed.data.backup,
          output: path.resolve(directory, parsed.data.backup.output),
        },
        encryption,
      },
    };
  } catch (error) {
    if (error instanceof PgDumpsterError) throw error;
    throw configError("Configuration could not be read or parsed.", error);
  }
}
