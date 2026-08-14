import { createRequire } from "node:module";

import { z } from "zod";

const require = createRequire(import.meta.url);

interface ContractValidationError {
  keyword: string;
  instancePath: string;
}

interface ContractValidator {
  (value: unknown): boolean;
  readonly errors?: readonly ContractValidationError[] | null;
}

interface ContractCompiler {
  compile(schema: unknown): ContractValidator;
}

type CompilerConstructor = new (options: {
  allErrors: boolean;
  strict: boolean;
  validateFormats: boolean;
}) => ContractCompiler;
type FormatsPlugin = (compiler: ContractCompiler) => unknown;

function defaultExport(moduleName: string): unknown {
  const loaded: unknown = require(moduleName);
  if (typeof loaded === "object" && loaded !== null && "default" in loaded) {
    return loaded.default;
  }
  return loaded;
}

function normalizeOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenApiSchema);
  if (value === null || typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$schema") continue;
    normalized[key] = normalizeOpenApiSchema(entry);
  }
  if (
    Reflect.get(normalized, "format") === "date-time" &&
    typeof Reflect.get(normalized, "pattern") === "string"
  ) {
    Reflect.deleteProperty(normalized, "pattern");
  }
  if (
    Reflect.get(normalized, "nullable") === true &&
    Reflect.get(normalized, "type") === undefined
  ) {
    Reflect.deleteProperty(normalized, "nullable");
  }
  return normalized;
}

const ajvExport = defaultExport("ajv");
const formatsExport = defaultExport("ajv-formats");
if (typeof ajvExport !== "function" || typeof formatsExport !== "function") {
  throw new TypeError("Ajv modules did not expose callable default exports");
}
const Compiler = ajvExport as CompilerConstructor;
const addFormats = formatsExport as FormatsPlugin;
const ajv = new Compiler({
  allErrors: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);

export function openApiContractSchema(
  schema: unknown,
  label: string,
): z.ZodType<unknown> {
  const validate = ajv.compile(normalizeOpenApiSchema(schema));
  return z.unknown().superRefine((value, context) => {
    if (validate(value)) return;
    for (const error of validate.errors ?? []) {
      context.addIssue({
        code: "custom",
        message: `${label} failed ${error.keyword}`,
        path: error.instancePath
          .split("/")
          .filter(Boolean)
          .map((segment) =>
            segment.replaceAll("~1", "/").replaceAll("~0", "~"),
          ),
      });
    }
  });
}
