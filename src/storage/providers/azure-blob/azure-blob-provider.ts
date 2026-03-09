/**
 * Azure Blob Storage Provider
 *
 * Implements IStorageProvider using Azure Blob Storage as the backend.
 * Each entity type is stored in a separate container with JSON serialization.
 *
 * Container naming: {containerPrefix}-threads, {containerPrefix}-assistants,
 * {containerPrefix}-runs, {containerPrefix}-crons, {containerPrefix}-store.
 *
 * Authentication supports:
 * 1. Managed identity (DefaultAzureCredential) when useManagedIdentity is true
 * 2. Connection string
 * 3. Account name with DefaultAzureCredential fallback
 *
 * Limitations:
 * - No transaction support across multiple blobs
 * - Search/filter is limited compared to SQL providers (client-side filtering)
 * - count() may be slow for large datasets (requires blob enumeration)
 */

import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import type { AzureBlobConfig } from '../../config.js';
import type {
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage,
} from '../../interfaces.js';
import { AzureBlobThreadStorage } from './azure-blob-thread-storage.js';
import { AzureBlobAssistantStorage } from './azure-blob-assistant-storage.js';
import { AzureBlobRunStorage } from './azure-blob-run-storage.js';
import { AzureBlobCronStorage } from './azure-blob-cron-storage.js';
import { AzureBlobStoreStorage } from './azure-blob-store-storage.js';

/**
 * Container suffix constants for each entity type.
 */
const CONTAINER_SUFFIXES = {
  threads: 'threads',
  assistants: 'assistants',
  runs: 'runs',
  crons: 'crons',
  store: 'store',
} as const;

export class AzureBlobStorageProvider implements IStorageProvider {
  readonly name = 'azure-blob';

  threads!: IThreadStorage;
  assistants!: IAssistantStorage;
  runs!: IRunStorage;
  crons!: ICronStorage;
  store!: IStoreStorage;

  private config: AzureBlobConfig;
  private blobServiceClient!: BlobServiceClient;
  private containerClients: Map<string, ContainerClient> = new Map();

  constructor(config: AzureBlobConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Create BlobServiceClient based on authentication method
    this.blobServiceClient = this.createBlobServiceClient();

    // Determine container prefix
    const prefix = this.config.containerPrefix;
    if (!prefix) {
      throw new Error(
        'Azure Blob Storage configuration error: "containerPrefix" is required. ' +
        'No fallback value is permitted.',
      );
    }

    // Ensure all containers exist
    for (const [entityKey, suffix] of Object.entries(CONTAINER_SUFFIXES)) {
      const containerName = `${prefix}-${suffix}`;
      const containerClient = this.blobServiceClient.getContainerClient(containerName);

      // Create the container if it does not exist
      await containerClient.createIfNotExists();

      this.containerClients.set(entityKey, containerClient);
    }

    // Initialize entity storage implementations
    this.threads = new AzureBlobThreadStorage(this.containerClients.get('threads')!);
    this.assistants = new AzureBlobAssistantStorage(this.containerClients.get('assistants')!);
    this.runs = new AzureBlobRunStorage(this.containerClients.get('runs')!);
    this.crons = new AzureBlobCronStorage(this.containerClients.get('crons')!);
    this.store = new AzureBlobStoreStorage(this.containerClients.get('store')!);
  }

  async close(): Promise<void> {
    // Azure Blob SDK uses HTTP-based operations with no persistent connections.
    // No cleanup is required.
  }

  /**
   * Create a BlobServiceClient using the configured authentication method.
   *
   * Priority:
   * 1. If useManagedIdentity is true: use DefaultAzureCredential with accountName
   * 2. If sasToken is provided: use accountName + SAS token URL
   * 3. If connectionString is provided: use BlobServiceClient.fromConnectionString()
   * 4. Otherwise: throw (no valid authentication method)
   */
  private createBlobServiceClient(): BlobServiceClient {
    if (this.config.useManagedIdentity) {
      if (!this.config.accountName) {
        throw new Error(
          'Azure Blob Storage configuration error: "accountName" is required when "useManagedIdentity" is true. ' +
          'No fallback value is permitted.',
        );
      }
      const accountUrl = `https://${this.config.accountName}.blob.core.windows.net`;
      return new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    }

    if (this.config.sasToken) {
      if (!this.config.accountName) {
        throw new Error(
          'Azure Blob Storage configuration error: "accountName" is required when using "sasToken". ' +
          'No fallback value is permitted.',
        );
      }
      const sas = this.config.sasToken.startsWith('?') ? this.config.sasToken : `?${this.config.sasToken}`;
      const accountUrl = `https://${this.config.accountName}.blob.core.windows.net${sas}`;
      return new BlobServiceClient(accountUrl);
    }

    if (this.config.connectionString) {
      return BlobServiceClient.fromConnectionString(this.config.connectionString);
    }

    throw new Error(
      'Azure Blob Storage configuration error: no valid authentication method configured. ' +
      'Provide "connectionString", "sasToken" with "accountName", or set "useManagedIdentity" to true with "accountName". ' +
      'No fallback value is permitted.',
    );
  }
}
