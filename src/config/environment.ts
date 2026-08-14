import { z } from "zod";

import { PgDumpsterError } from "../core/errors/error.js";
import type { Redactor } from "../security/redactor.js";
import { SecretValue } from "../security/secret-value.js";

const projectRefSchema = z.string().regex(/^[a-z]{20}$/u);

export interface SourceEnvironment {
  projectRef: string;
  accessToken: SecretValue;
  databaseUrl?: SecretValue;
  storageKey?: SecretValue;
}

export interface EnvironmentOptions {
  projectRef?: string;
  requireDatabase?: boolean;
  requireStorage?: boolean;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new PgDumpsterError({
      code: "CONFIG_MISSING_REQUIRED",
      category: "config",
      message: `Required environment variable ${name} is not set.`,
      retryable: false,
      details: { variable: name },
    });
  }
  return value;
}

export function loadSourceEnvironment(
  environment: NodeJS.ProcessEnv,
  redactor: Redactor,
  options: EnvironmentOptions = {},
): SourceEnvironment {
  const rawProjectRef =
    options.projectRef ?? required(environment, "PGDUMPSTER_PROJECT_REF");
  const parsedRef = projectRefSchema.safeParse(rawProjectRef);
  if (!parsedRef.success) {
    throw new PgDumpsterError({
      code: "PROJECT_REF_INVALID",
      category: "config",
      message:
        "Supabase project ref must contain exactly 20 lowercase letters.",
      retryable: false,
    });
  }
  const result: SourceEnvironment = {
    projectRef: parsedRef.data,
    accessToken: new SecretValue(
      required(environment, "PGDUMPSTER_ACCESS_TOKEN"),
      redactor,
    ),
  };
  const databaseUrl = environment["PGDUMPSTER_DB_URL"];
  if (options.requireDatabase === true && !databaseUrl) {
    required(environment, "PGDUMPSTER_DB_URL");
  }
  if (databaseUrl) result.databaseUrl = new SecretValue(databaseUrl, redactor);
  const storageKey = environment["PGDUMPSTER_STORAGE_KEY"];
  if (options.requireStorage === true && !storageKey) {
    required(environment, "PGDUMPSTER_STORAGE_KEY");
  }
  if (storageKey) result.storageKey = new SecretValue(storageKey, redactor);
  return result;
}
