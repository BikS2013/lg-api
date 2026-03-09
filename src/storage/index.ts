/**
 * Storage Layer Barrel Export
 *
 * Public API for the storage abstraction layer.
 */

// Interfaces
export type {
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage,
  StoreItem,
  SearchOptions,
  SearchResult,
} from './interfaces.js';

// Config types
export type {
  StorageConfig,
  StorageProviderType,
  SqliteConfig,
  SqlServerConfig,
  AzureBlobConfig,
} from './config.js';

// Factory
export { createStorageProvider } from './provider-factory.js';

// YAML config loader
export { loadStorageConfig } from './yaml-config-loader.js';

// Storage lifecycle (re-exported from registry for convenience)
export {
  initializeStorage,
  getStorageProvider,
  closeStorage,
} from '../repositories/registry.js';
