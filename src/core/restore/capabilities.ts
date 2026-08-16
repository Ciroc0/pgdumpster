export const AUTOMATIC_RESTORE_COMPONENTS = [
  "database.extensions",
  "database.roles",
  "database.schema",
  "database.data",
  "auth.data",
  "database.cron",
  "database.queues",
  "database.webhooks",
  "database.migrations",
  "database.auth_storage_customizations",
  "database.publications",
  "storage.service_config",
  "storage.file_buckets",
  "storage.file_objects",
  "storage.file_metadata",
  "storage.vector_buckets",
  "storage.vector_indexes",
  "storage.vectors",
  "auth.config",
  "auth.sso",
  "auth.tpa",
  "api.modern_keys",
  "api.legacy_keys_state",
  "database.postgres_config",
  "database.pooler",
  "database.ssl",
  "realtime.config",
  "rest.postgrest_config",
  "network.restrictions",
  "database.vault_root_key",
] as const;

export type AutomaticRestoreComponent =
  (typeof AUTOMATIC_RESTORE_COMPONENTS)[number];

const automaticRestoreComponents = new Set<string>(
  AUTOMATIC_RESTORE_COMPONENTS,
);

export function supportsAutomaticRestore(component: string): boolean {
  return automaticRestoreComponents.has(component);
}

export const STORAGE_CREDENTIAL_RESTORE_COMPONENTS = [
  "storage.file_buckets",
  "storage.file_objects",
  "storage.file_metadata",
  "storage.vector_buckets",
  "storage.vector_indexes",
  "storage.vectors",
] as const satisfies readonly AutomaticRestoreComponent[];

const storageCredentialRestoreComponents = new Set<string>(
  STORAGE_CREDENTIAL_RESTORE_COMPONENTS,
);

export function requiresStorageRestoreCredential(component: string): boolean {
  return storageCredentialRestoreComponents.has(component);
}

export const DATABASE_CREDENTIAL_RESTORE_COMPONENTS = [
  "database.extensions",
  "database.roles",
  "database.schema",
  "database.data",
  "auth.data",
  "database.cron",
  "database.queues",
  "database.webhooks",
  "database.migrations",
  "database.auth_storage_customizations",
  "database.publications",
  "database.vault_root_key",
  "storage.file_buckets",
  "storage.file_objects",
  "storage.file_metadata",
] as const satisfies readonly AutomaticRestoreComponent[];

const databaseCredentialRestoreComponents = new Set<string>(
  DATABASE_CREDENTIAL_RESTORE_COMPONENTS,
);

export function requiresDatabaseRestoreCredential(component: string): boolean {
  return databaseCredentialRestoreComponents.has(component);
}

export const MANAGEMENT_CREDENTIAL_RESTORE_COMPONENTS = [
  "database.vault_root_key",
  "storage.service_config",
  "storage.file_buckets",
  "storage.file_objects",
  "storage.file_metadata",
  "storage.vector_buckets",
  "storage.vector_indexes",
  "storage.vectors",
  "auth.config",
  "auth.sso",
  "auth.tpa",
  "api.modern_keys",
  "api.legacy_keys_state",
  "database.postgres_config",
  "database.pooler",
  "database.ssl",
  "realtime.config",
  "rest.postgrest_config",
  "network.restrictions",
] as const satisfies readonly AutomaticRestoreComponent[];

const managementCredentialRestoreComponents = new Set<string>(
  MANAGEMENT_CREDENTIAL_RESTORE_COMPONENTS,
);

export function requiresManagementRestoreCredential(
  component: string,
): boolean {
  return managementCredentialRestoreComponents.has(component);
}
