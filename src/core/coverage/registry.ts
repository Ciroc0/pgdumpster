import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const coverageStatusSchema = z.enum([
  "backed_up",
  "not_configured",
  "not_applicable",
  "not_exportable",
  "failed",
]);

export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

const sensitivitySchema = z.enum(["public", "internal", "sensitive", "secret"]);

const componentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u),
    class: z.string().min(1),
    required: z.boolean(),
    sensitivity: sensitivitySchema,
    restore_policy: z.string().min(1),
    never_log: z.boolean().optional(),
    exact_restore_may_be_impossible: z.boolean().optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();

const registrySchema = z
  .object({
    version: z.literal(1),
    product: z.literal("pgdumpster"),
    scope: z.literal("hosted_supabase_project"),
    status_values: z.array(coverageStatusSchema).length(5),
    components: z.array(componentSchema).min(1),
  })
  .strict();

export type CoverageComponent = z.infer<typeof componentSchema>;
export type CoverageRegistry = z.infer<typeof registrySchema>;

export async function loadCoverageRegistry(
  registryPath = fileURLToPath(
    new URL("../../../spec/coverage-registry.yaml", import.meta.url),
  ),
): Promise<CoverageRegistry> {
  const text = await readFile(registryPath, "utf8");
  const registry = registrySchema.parse(parseYaml(text));

  const ids = new Set<string>();
  for (const component of registry.components) {
    if (ids.has(component.id)) {
      throw new Error(`Duplicate coverage component: ${component.id}`);
    }
    ids.add(component.id);
  }

  if (
    new Set(registry.status_values).size !== coverageStatusSchema.options.length
  ) {
    throw new Error("Coverage status vocabulary contains duplicates");
  }

  return registry;
}
