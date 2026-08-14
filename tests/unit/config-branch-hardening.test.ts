import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSourceEnvironment } from "../../src/config/environment.js";
import { loadConfigFile } from "../../src/config/file.js";
import { Redactor } from "../../src/security/redactor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pgdumpster-config-branch-"),
  );

  temporaryDirectories.push(directory);

  return directory;
}

describe("environment config branch hardening", () => {
  it("accepts an explicit project-ref override without the environment variable", () => {
    const result = loadSourceEnvironment(
      {
        PGDUMPSTER_ACCESS_TOKEN: "management-token",
      },
      new Redactor(),
      {
        projectRef: "abcdefghijklmnopqrst",
      },
    );

    expect(result.projectRef).toBe("abcdefghijklmnopqrst");

    expect(result.databaseUrl).toBeUndefined();

    expect(result.storageKey).toBeUndefined();
  });

  it("rejects missing and invalid project refs", () => {
    expect(() =>
      loadSourceEnvironment(
        {
          PGDUMPSTER_ACCESS_TOKEN: "token",
        },
        new Redactor(),
      ),
    ).toThrow();

    expect(() =>
      loadSourceEnvironment(
        {
          PGDUMPSTER_PROJECT_REF: "INVALID",
          PGDUMPSTER_ACCESS_TOKEN: "token",
        },
        new Redactor(),
      ),
    ).toThrow("exactly 20 lowercase letters");
  });

  it("requires the management access token", () => {
    try {
      loadSourceEnvironment(
        {
          PGDUMPSTER_PROJECT_REF: "abcdefghijklmnopqrst",
        },
        new Redactor(),
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "CONFIG_MISSING_REQUIRED",
      });
    }
  });

  it("enforces required database and Storage credentials independently", () => {
    const base = {
      PGDUMPSTER_PROJECT_REF: "abcdefghijklmnopqrst",
      PGDUMPSTER_ACCESS_TOKEN: "token",
    };

    expect(() =>
      loadSourceEnvironment(base, new Redactor(), {
        requireDatabase: true,
      }),
    ).toThrow("PGDUMPSTER_DB_URL");

    expect(() =>
      loadSourceEnvironment(base, new Redactor(), {
        requireStorage: true,
      }),
    ).toThrow("PGDUMPSTER_STORAGE_KEY");
  });

  it("loads optional database and Storage credentials when supplied", () => {
    const result = loadSourceEnvironment(
      {
        PGDUMPSTER_PROJECT_REF: "abcdefghijklmnopqrst",
        PGDUMPSTER_ACCESS_TOKEN: "token",
        PGDUMPSTER_DB_URL:
          "postgresql://postgres:secret@example.invalid/postgres",
        PGDUMPSTER_STORAGE_KEY: "sb_secret_fixture",
      },
      new Redactor(),
      {
        requireDatabase: true,
        requireStorage: true,
      },
    );

    expect(result.databaseUrl?.expose()).toContain("postgresql://");

    expect(result.storageKey?.expose()).toBe("sb_secret_fixture");
  });
});

describe("file config branch hardening", () => {
  it("loads defaults and resolves backup output relative to the config file", async () => {
    const directory = await root();

    const filename = path.join(directory, "pgdumpster.yaml");

    await writeFile(filename, "{}\n");

    const loaded = await loadConfigFile(filename);

    expect(loaded.config.backup.output).toBe(
      path.resolve(directory, "backups"),
    );

    expect(loaded.config.destination.type).toBe("local");

    expect(loaded.config.encryption.mode).toBe("none");
  });

  it("rejects a configuration path that is a directory", async () => {
    const directory = await root();

    const target = path.join(directory, "config-directory");

    await mkdir(target);

    await expect(loadConfigFile(target)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects oversized configuration files", async () => {
    const directory = await root();

    const filename = path.join(directory, "oversized.yaml");

    await writeFile(filename, "x".repeat(1_048_577));

    await expect(loadConfigFile(filename)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects configuration schema violations", async () => {
    const directory = await root();

    const filename = path.join(directory, "invalid-schema.yaml");

    await writeFile(
      filename,
      ["backup:", "  maxStorageConcurrency: 0", ""].join("\n"),
    );

    await expect(loadConfigFile(filename)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("wraps malformed or duplicate-key YAML parse failures", async () => {
    const directory = await root();

    const filename = path.join(directory, "invalid-yaml.yaml");

    await writeFile(
      filename,
      [
        "projectRef: abcdefghijklmnopqrst",
        "projectRef: abcdefghijklmnopqrst",
        "",
      ].join("\n"),
    );

    await expect(loadConfigFile(filename)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});
