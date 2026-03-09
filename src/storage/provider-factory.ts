/**
 * Storage Provider Factory
 *
 * Creates and initializes the appropriate IStorageProvider implementation
 * based on the StorageConfig.
 */

import type { StorageConfig } from './config.js';
import type { IStorageProvider } from './interfaces.js';

/**
 * Create and initialize a storage provider based on the given configuration.
 * Throws if the provider type is unknown or not yet implemented.
 */
export async function createStorageProvider(config: StorageConfig): Promise<IStorageProvider> {
  switch (config.provider) {
    case 'memory': {
      const { InMemoryStorageProvider } = await import('./providers/memory/memory-provider.js');
      const provider = new InMemoryStorageProvider();
      await provider.initialize();
      return provider;
    }

    case 'sqlite': {
      if (!config.sqlite) {
        throw new Error('SQLite configuration is required when provider is "sqlite".');
      }
      const { SqliteStorageProvider } = await import('./providers/sqlite/sqlite-provider.js');
      const sqliteProvider = new SqliteStorageProvider(config.sqlite);
      await sqliteProvider.initialize();
      return sqliteProvider;
    }

    case 'sqlserver': {
      if (!config.sqlserver) {
        throw new Error('SQL Server configuration is required when provider is "sqlserver".');
      }
      const { SqlServerStorageProvider } = await import('./providers/sqlserver/sqlserver-provider.js');
      const sqlServerProvider = new SqlServerStorageProvider(config.sqlserver);
      await sqlServerProvider.initialize();
      return sqlServerProvider;
    }

    case 'azure-blob': {
      if (!config.azureBlob) {
        throw new Error(
          'Azure Blob configuration is required when provider is "azure-blob". ' +
          'No fallback value is permitted.',
        );
      }
      const { AzureBlobStorageProvider } = await import('./providers/azure-blob/index.js');
      const azureBlobProvider = new AzureBlobStorageProvider(config.azureBlob);
      await azureBlobProvider.initialize();
      return azureBlobProvider;
    }

    default:
      throw new Error(`Unknown storage provider: ${String((config as { provider: string }).provider)}`);
  }
}
