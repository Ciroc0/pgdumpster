import type { ManagementClient } from "./client.js";
import {
  projectSchema,
  servicesHealthSchema,
  type ManagementProject,
  type ServiceHealth,
} from "./schemas.js";

export interface ProjectDiscovery {
  project: ManagementProject;
  services: ServiceHealth[];
}

export async function discoverProject(
  client: ManagementClient,
  projectRef: string,
  signal?: AbortSignal,
): Promise<ProjectDiscovery> {
  const encodedRef = encodeURIComponent(projectRef);
  const requestOptions = signal === undefined ? {} : { signal };
  const [project, services] = await Promise.all([
    client.get(`/v1/projects/${encodedRef}`, projectSchema, requestOptions),
    client.get(`/v1/projects/${encodedRef}/health`, servicesHealthSchema, {
      ...requestOptions,
      query: {
        services:
          "auth,db,db_postgres_user,pooler,realtime,rest,storage,pg_bouncer",
      },
    }),
  ]);
  if (project.ref !== projectRef) {
    throw new Error("Management API returned a different project ref");
  }
  return { project, services };
}
