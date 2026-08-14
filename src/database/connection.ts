import { PgDumpsterError } from "../core/errors/error.js";

export function postgresConnectionWithoutPassword(connectionString: string): {
  safeUrl: string;
  password: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message: "Database URL is not a valid PostgreSQL URL.",
      retryable: false,
      cause: error,
    });
  }
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    !url.hostname ||
    !url.username ||
    !url.password
  ) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message:
        "Database URL must include PostgreSQL protocol, host, username, and password.",
      retryable: false,
    });
  }
  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch (error) {
    throw new PgDumpsterError({
      code: "CONFIG_INVALID",
      category: "config",
      message: "Database URL contains an invalid encoded password.",
      retryable: false,
      cause: error,
    });
  }
  url.password = "";
  return { safeUrl: url.toString(), password };
}
