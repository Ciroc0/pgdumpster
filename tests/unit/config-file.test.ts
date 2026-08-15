import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfigFile } from "../../src/config/file.js";
import { serializeError } from "../../src/core/errors/serialize.js";
import { Redactor } from "../../src/security/redactor.js";

const temporaryDirectories: string[] = [];

async function config(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pgdumpster-config-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "pgdumpster.yaml");
  await writeFile(filePath, contents);
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("explicit configuration file", () => {
  it("applies safe defaults and resolves output relative to the file", async () => {
    const filePath = await config(
      "projectRef: abcdefghijklmnopqrst\nbackup:\n  output: ./backup-output\n",
    );
    const loaded = await loadConfigFile(filePath);
    expect(loaded.config.projectRef).toBe("abcdefghijklmnopqrst");
    expect(loaded.config.backup.output).toBe(
      path.join(path.dirname(filePath), "backup-output"),
    );
    expect(loaded.config.backup.maxApiConcurrency).toBe(3);
    expect(loaded.config.encryption.mode).toBe("none");
  });

  it("resolves an age identity path relative to config and permits decrypt-only age config", async () => {
    const filePath = await config(
      "encryption:\n  mode: age\n  identityFile: ./keys/backup-identity.txt\n",
    );
    const loaded = await loadConfigFile(filePath);
    expect(loaded.config.encryption).toEqual({
      mode: "age",
      identityFile: path.join(
        path.dirname(filePath),
        "keys",
        "backup-identity.txt",
      ),
    });
  });

  it("preserves an age recipient alongside the resolved identity reference", async () => {
    const recipient = `age1${"q".repeat(58)}`;
    const filePath = await config(
      `encryption:\n  mode: age\n  recipient: ${recipient}\n  identityFile: ./identity.txt\n`,
    );
    const loaded = await loadConfigFile(filePath);
    expect(loaded.config.encryption).toEqual({
      mode: "age",
      recipient,
      identityFile: path.join(path.dirname(filePath), "identity.txt"),
    });
  });

  it("rejects secret fields, duplicate keys, aliases, and insecure endpoints", async () => {
    const invalid = [
      "projectRef: abcdefghijklmnopqrst\naccessToken: secret\n",
      "projectRef: abcdefghijklmnopqrst\nprojectRef: abcdefghijklmnopqrst\n",
      "projectRef: &ref abcdefghijklmnopqrst\nbackup:\n  output: *ref\n",
      "destination:\n  type: s3\n  endpoint: http://insecure.example\n  bucket: backup\n",
    ];
    for (const contents of invalid) {
      const filePath = await config(contents);
      let captured: unknown;
      try {
        await loadConfigFile(filePath);
      } catch (error) {
        captured = error;
      }
      expect(serializeError(captured, new Redactor()).code).toBe(
        "CONFIG_INVALID",
      );
    }
  });
});
