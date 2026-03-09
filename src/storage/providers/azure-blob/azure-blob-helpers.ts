/**
 * Azure Blob Storage Helper Utilities
 *
 * Provides common operations for JSON blob upload/download, deletion,
 * and prefix-based listing used by all entity storage implementations.
 */

import type { ContainerClient, BlobItem } from '@azure/storage-blob';
import { RestError } from '@azure/storage-blob';

/**
 * Upload a JSON-serializable object as a blob.
 *
 * @param containerClient - The Azure container client
 * @param blobName - Full blob path (e.g., "{id}/state.json")
 * @param data - Object to serialize and upload
 * @param tags - Optional blob index tags for server-side search
 * @param metadata - Optional blob metadata for quick property access
 * @returns The ETag of the uploaded blob
 */
export async function uploadJson(
  containerClient: ContainerClient,
  blobName: string,
  data: unknown,
  tags?: Record<string, string>,
  metadata?: Record<string, string>,
): Promise<string> {
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  const content = JSON.stringify(data);
  const response = await blockBlobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    tags,
    metadata,
  });
  return response.etag ?? '';
}

/**
 * Download and parse a JSON blob.
 *
 * @param containerClient - The Azure container client
 * @param blobName - Full blob path
 * @returns Parsed JSON object, or null if the blob does not exist (404)
 */
export async function downloadJson<T>(
  containerClient: ContainerClient,
  blobName: string,
): Promise<T | null> {
  try {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download(0);

    if (!downloadResponse.readableStreamBody) {
      return null;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Download a JSON blob along with its ETag for optimistic concurrency.
 *
 * @param containerClient - The Azure container client
 * @param blobName - Full blob path
 * @returns Object with data and etag, or null if blob does not exist
 */
export async function downloadJsonWithEtag<T>(
  containerClient: ContainerClient,
  blobName: string,
): Promise<{ data: T; etag: string } | null> {
  try {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download(0);

    if (!downloadResponse.readableStreamBody) {
      return null;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString('utf-8');
    return {
      data: JSON.parse(content) as T,
      etag: downloadResponse.etag ?? '',
    };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Upload a JSON blob with ETag-based optimistic concurrency.
 *
 * @param containerClient - The Azure container client
 * @param blobName - Full blob path
 * @param data - Object to serialize and upload
 * @param etag - Expected ETag for conditional update
 * @param tags - Optional blob index tags
 * @param metadata - Optional blob metadata
 * @returns The new ETag of the uploaded blob
 * @throws If ETag does not match (concurrent modification)
 */
export async function uploadJsonWithEtag(
  containerClient: ContainerClient,
  blobName: string,
  data: unknown,
  etag: string,
  tags?: Record<string, string>,
  metadata?: Record<string, string>,
): Promise<string> {
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  const content = JSON.stringify(data);
  const response = await blockBlobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    conditions: { ifMatch: etag },
    tags,
    metadata,
  });
  return response.etag ?? '';
}

/**
 * Delete a blob. Returns true if deleted, false if not found.
 *
 * @param containerClient - The Azure container client
 * @param blobName - Full blob path
 * @returns true if the blob was deleted, false if it did not exist
 */
export async function deleteBlob(
  containerClient: ContainerClient,
  blobName: string,
): Promise<boolean> {
  try {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.delete();
    return true;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Delete all blobs matching a prefix. Used for cascading deletes
 * (e.g., deleting a thread and all its state history).
 *
 * @param containerClient - The Azure container client
 * @param prefix - Blob name prefix to match
 * @returns Number of blobs deleted
 */
export async function deleteBlobsByPrefix(
  containerClient: ContainerClient,
  prefix: string,
): Promise<number> {
  let count = 0;
  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
    try {
      await blockBlobClient.delete();
      count++;
    } catch (error: unknown) {
      // Ignore 404 in case blob was deleted between list and delete
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  return count;
}

/**
 * List all blobs matching a prefix.
 *
 * @param containerClient - The Azure container client
 * @param prefix - Blob name prefix to match
 * @returns Array of BlobItem objects
 */
export async function listBlobsByPrefix(
  containerClient: ContainerClient,
  prefix: string,
): Promise<BlobItem[]> {
  const blobs: BlobItem[] = [];
  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    blobs.push(blob);
  }
  return blobs;
}

/**
 * List all blobs matching a prefix, including their tags.
 *
 * @param containerClient - The Azure container client
 * @param prefix - Blob name prefix to match
 * @returns Array of BlobItem objects with tags populated
 */
export async function listBlobsByPrefixWithTags(
  containerClient: ContainerClient,
  prefix: string,
): Promise<BlobItem[]> {
  const blobs: BlobItem[] = [];
  for await (const blob of containerClient.listBlobsFlat({
    prefix,
    includeTags: true,
  })) {
    blobs.push(blob);
  }
  return blobs;
}

/**
 * Check whether an error is a "not found" (404) RestError from Azure Blob SDK.
 */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof RestError) {
    return error.statusCode === 404;
  }
  return false;
}

/**
 * Check whether an error is a "conflict" (409) RestError from Azure Blob SDK.
 * This occurs when an ETag condition fails.
 */
export function isConflictError(error: unknown): boolean {
  if (error instanceof RestError) {
    return error.statusCode === 409 || error.statusCode === 412;
  }
  return false;
}

/**
 * Build blob index tags from an entity object. Only includes non-null string values
 * and truncates to 256 characters (Azure tag value limit).
 *
 * @param fields - Record of field name to value
 * @returns Record of tag name to string value suitable for Azure blob tags
 */
export function buildTags(fields: Record<string, unknown>): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      const strValue = String(value);
      // Azure tag values are limited to 256 characters
      tags[key] = strValue.length > 256 ? strValue.substring(0, 256) : strValue;
    }
  }
  return tags;
}

/**
 * Apply client-side filtering to an array of items based on filter criteria.
 * Supports nested property matching using dot notation in filter keys.
 *
 * @param items - Array of items to filter
 * @param filters - Key-value pairs to match against item properties
 * @returns Filtered array
 */
export function applyFilters<T extends Record<string, unknown>>(
  items: T[],
  filters?: Record<string, unknown>,
): T[] {
  if (!filters || Object.keys(filters).length === 0) {
    return items;
  }

  return items.filter((item) => {
    for (const [key, expectedValue] of Object.entries(filters)) {
      const actualValue = getNestedValue(item, key);
      if (actualValue !== expectedValue) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Get a nested property value using dot-notation path (e.g., "metadata.userId").
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Apply pagination (offset + limit) to an array.
 *
 * @param items - Full array of items
 * @param offset - Number of items to skip
 * @param limit - Maximum number of items to return
 * @returns Sliced array
 */
export function paginate<T>(items: T[], offset: number, limit: number): T[] {
  return items.slice(offset, offset + limit);
}

/**
 * Sort an array of items by a given field and direction.
 *
 * @param items - Array of items to sort
 * @param sortBy - Field name to sort by (defaults to "created_at")
 * @param sortOrder - "asc" or "desc" (defaults to "desc")
 * @returns Sorted array (mutates in-place for efficiency)
 */
export function sortItems<T extends Record<string, unknown>>(
  items: T[],
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
): T[] {
  const field = sortBy ?? 'created_at';
  const order = sortOrder ?? 'desc';

  return items.sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];

    if (aVal === bVal) return 0;
    if (aVal === null || aVal === undefined) return 1;
    if (bVal === null || bVal === undefined) return -1;

    const comparison = aVal < bVal ? -1 : 1;
    return order === 'asc' ? comparison : -comparison;
  });
}
