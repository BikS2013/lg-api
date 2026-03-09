/**
 * Storage Configuration Types
 *
 * Defines the configuration schema for the pluggable storage infrastructure.
 * Each provider type has its own configuration section with required fields.
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
  containerPrefix?: string;
  useManagedIdentity?: boolean;
}

export interface StorageConfig {
  provider: StorageProviderType;
  sqlite?: SqliteConfig;
  sqlserver?: SqlServerConfig;
  azureBlob?: AzureBlobConfig;
}
