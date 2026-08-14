import { z } from "zod";

export const projectStatusSchema = z.enum([
  "INACTIVE",
  "ACTIVE_HEALTHY",
  "ACTIVE_UNHEALTHY",
  "COMING_UP",
  "UNKNOWN",
  "GOING_DOWN",
  "INIT_FAILED",
  "REMOVED",
  "RESTORING",
  "UPGRADING",
  "PAUSING",
  "RESTORE_FAILED",
  "RESTARTING",
  "PAUSE_FAILED",
  "RESIZING",
]);

export const projectSchema = z
  .object({
    id: z.string(),
    ref: z.string().regex(/^[a-z]{20}$/u),
    organization_id: z.string(),
    organization_slug: z.string().regex(/^[\w-]+$/u),
    name: z.string(),
    region: z.string(),
    created_at: z.string(),
    status: projectStatusSchema,
    database: z
      .object({
        host: z.string(),
        version: z.string(),
        postgres_engine: z.string(),
        release_channel: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const serviceHealthSchema = z
  .object({
    name: z.enum([
      "auth",
      "db",
      "db_postgres_user",
      "pooler",
      "realtime",
      "rest",
      "storage",
      "pg_bouncer",
    ]),
    healthy: z.boolean(),
    status: z.enum(["COMING_UP", "ACTIVE_HEALTHY", "UNHEALTHY"]),
    info: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const servicesHealthSchema = z.array(serviceHealthSchema);

export type ManagementProject = z.infer<typeof projectSchema>;
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;
