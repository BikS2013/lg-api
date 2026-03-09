/**
 * Storage Configuration Types
 *
 * Defines the configuration schema for the pluggable storage infrastructure.
 *
 * The YAML config supports multiple named profiles per provider type.
 * The active profile is selected by `provider` (type) + `profile` (name).
 *
 * Example:
 *   provider: azure-blob
 *   profile: production
 *   azureBlob:
 *     production:
 *       accountName: prodaccount
 *       sasToken: ...
 *     staging:
 *       accountName: stagingaccount
 *       sasToken: ...
 */

export type StorageProviderType = 'memory' | 'sqlite' | 'sqlserver' | 'azure-blob';

export interface SqliteConfig {
  path: string;
  walMode?: boolean;
}

export interface SqlServerConfig {
  server: string;
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export interface AzureBlobConfig {
  connectionString?: string;
  accountName?: string;
  sasToken?: string;
  containerPrefix?: string;
  useManagedIdentity?: boolean;
}

/**
 * Resolved storage configuration (after profile selection).
 * This is what the provider factory receives.
 */
export interface StorageConfig {
  provider: StorageProviderType;
  profile?: string;
  sqlite?: SqliteConfig;
  sqlserver?: SqlServerConfig;
  azureBlob?: AzureBlobConfig;
}

/**
 * Raw YAML structure before profile resolution.
 * Each provider section is a map of named profiles.
 */
export interface StorageConfigFile {
  provider: StorageProviderType;
  profile?: string;
  sqlite?: Record<string, SqliteConfig>;
  sqlserver?: Record<string, SqlServerConfig>;
  azureBlob?: Record<string, AzureBlobConfig>;
}
