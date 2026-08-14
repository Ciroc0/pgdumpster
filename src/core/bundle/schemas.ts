import { z } from "zod";

import { coverageStatusSchema } from "../coverage/registry.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const bundlePathSchema = z.string().min(1);
const sensitivitySchema = z.enum(["public", "internal", "sensitive", "secret"]);

export const coverageEntrySchema = z
  .object({
    id: z.string().min(1),
    status: coverageStatusSchema,
    reasonCode: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    sensitivity: sensitivitySchema,
    artifacts: z.array(bundlePathSchema),
    children: z.array(z.record(z.string(), z.unknown())).optional(),
    sourceContract: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.status === "not_exportable" && entry.reasonCode === undefined) {
      context.addIssue({
        code: "custom",
        message: "not_exportable requires reasonCode",
        path: ["reasonCode"],
      });
    }
    if (entry.status === "failed" && entry.reasonCode === undefined) {
      context.addIssue({
        code: "custom",
        message: "failed requires reasonCode",
        path: ["reasonCode"],
      });
    }
  });

export const coverageDocumentSchema = z
  .object({
    formatVersion: z.literal("1.0.0"),
    components: z.array(coverageEntrySchema).min(1),
  })
  .strict();

export const manifestSchema = z
  .object({
    formatVersion: z.literal("1.0.0"),
    tool: z
      .object({ name: z.literal("pgdumpster"), version: z.string().min(1) })
      .strict(),
    operation: z
      .object({
        id: z.string().uuid(),
        startedAt: z.string().datetime({ offset: true }),
        completedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    source: z
      .object({
        projectRef: z.string().regex(/^[a-z0-9]{20}$/u),
        projectName: z.string().min(1).optional(),
        region: z.string().min(1).optional(),
      })
      .strict(),
    result: z
      .object({
        status: z.enum(["complete", "complete_with_platform_limits", "failed"]),
        consistency: z.enum([
          "verified",
          "best_effort",
          "quiesced",
          "drift_detected",
        ]),
      })
      .strict(),
    coverageFile: z.literal("coverage.json"),
    checksumFile: z.literal("checksums.sha256"),
    checksumFileSha256: sha256Schema,
    components: z
      .array(
        z
          .object({ id: z.string().min(1), status: coverageStatusSchema })
          .strict(),
      )
      .min(1),
    statistics: z
      .object({
        files: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type CoverageDocument = z.infer<typeof coverageDocumentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
