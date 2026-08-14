import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface JsonValidator {
  (value: unknown): boolean;
  readonly errors?: readonly unknown[] | null;
}

interface JsonSchemaCompiler {
  compile(schema: unknown): JsonValidator;
}

type CompilerConstructor = new (options: {
  allErrors: boolean;
  strict: boolean;
}) => JsonSchemaCompiler;
type FormatsPlugin = (compiler: JsonSchemaCompiler) => unknown;

function defaultExport(moduleName: string): unknown {
  const loaded: unknown = require(moduleName);
  if (typeof loaded === "object" && loaded !== null && "default" in loaded) {
    return loaded.default;
  }
  return loaded;
}

function isCompilerConstructor(value: unknown): value is CompilerConstructor {
  return typeof value === "function";
}

function isFormatsPlugin(value: unknown): value is FormatsPlugin {
  return typeof value === "function";
}

const ajvExport = defaultExport("ajv/dist/2020.js");
const formatsExport = defaultExport("ajv-formats");
if (!isCompilerConstructor(ajvExport) || !isFormatsPlugin(formatsExport)) {
  throw new TypeError("Ajv modules did not expose callable default exports");
}
const Ajv2020: CompilerConstructor = ajvExport;
const addFormats: FormatsPlugin = formatsExport;

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("published JSON schemas", () => {
  it.each([
    ["schemas/manifest.schema.json", "examples/manifest.example.json"],
    ["schemas/coverage.schema.json", "examples/coverage.example.json"],
  ])("validates %s against its example", async (schemaPath, examplePath) => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(await json(schemaPath));
    expect(
      validate(await json(examplePath)),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });
});
