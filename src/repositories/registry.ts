/**
 * Repository Registry & Storage Lifecycle
 *
 * Provides:
 * 1. Storage provider lifecycle: initializeStorage(), getStorageProvider(), closeStorage()
 * 2. Backward-compatible repository registry: getRepositoryRegistry(), resetRepositoryRegistry()
 *
 * The storage provider is the new abstraction (IStorageProvider).
 * The repository registry is kept for backward compatibility -- route modules
 * still call getRepositoryRegistry() and receive the same repository instances.
 * Route modules will be migrated to use the storage provider directly in a future phase.
 */

import type { IStorageProvider } from '../storage/interfaces.js';
import { loadStorageConfig } from '../storage/yaml-config-loader.js';
import { createStorageProvider } from '../storage/provider-factory.js';
import { AssistantsRepository } from '../modules/assistants/assistants.repository.js';
import { ThreadsRepository } from '../modules/threads/threads.repository.js';
import { RunsRepository } from '../modules/runs/runs.repository.js';
import { CronsRepository } from '../modules/crons/crons.repository.js';
import { StoreRepository } from '../modules/store/store.repository.js';

// ---------------------------------------------------------------------------
// Storage Provider Lifecycle
// ---------------------------------------------------------------------------

let storageProvider: IStorageProvider | null = null;

/**
 * Initialize the storage provider based on the YAML configuration.
 * Safe to call multiple times -- returns the existing provider if already initialized.
 *
 * Resolution order for configuration:
 * 1. STORAGE_CONFIG_PATH env var (explicit path, must exist)
 * 2. storage-config.yaml at project root (auto-detection)
 * 3. In-memory provider (no config file needed)
 */
export async function initializeStorage(): Promise<IStorageProvider> {
  if (storageProvider) return storageProvider;
  const config = loadStorageConfig();
  storageProvider = await createStorageProvider(config);
  return storageProvider;
}

/**
 * Get the current storage provider.
 * Throws if initializeStorage() has not been called.
 */
export function getStorageProvider(): IStorageProvider {
  if (!storageProvider) {
    throw new Error('Storage not initialized. Call initializeStorage() first.');
  }
  return storageProvider;
}

/**
 * Close the storage provider and release resources.
 * Safe to call multiple times or when no provider is initialized.
 */
export async function closeStorage(): Promise<void> {
  if (storageProvider) {
    await storageProvider.close();
    storageProvider = null;
  }
}

// ---------------------------------------------------------------------------
// Backward-Compatible Repository Registry
// ---------------------------------------------------------------------------

export interface RepositoryRegistry {
  assistants: AssistantsRepository;
  threads: ThreadsRepository;
  runs: RunsRepository;
  crons: CronsRepository;
  store: StoreRepository;
}

let registry: RepositoryRegistry | null = null;

/**
 * Get the shared repository registry (singleton).
 *
 * @deprecated Use initializeStorage() and getStorageProvider() instead.
 * This function is kept for backward compatibility with existing route modules
 * and will be removed once all routes are migrated to the storage provider.
 */
export function getRepositoryRegistry(): RepositoryRegistry {
  if (!registry) {
    registry = {
      assistants: new AssistantsRepository(),
      threads: new ThreadsRepository(),
      runs: new RunsRepository(),
      crons: new CronsRepository(),
      store: new StoreRepository(),
    };
  }
  return registry;
}

/**
 * Reset the repository registry (useful for tests).
 *
 * @deprecated Use closeStorage() instead.
 */
export function resetRepositoryRegistry(): void {
  registry = null;
}
