/**
 * Tests for the Storage Provider Factory.
 *
 * Covers:
 * - Creating memory provider
 * - Creating SQLite provider (with temp file)
 * - Unknown provider throws error
 * - Created providers implement IStorageProvider interface shape
 */

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';

import { createStorageProvider } from '../src/storage/provider-factory.js';
import type { IStorageProvider } from '../src/storage/interfaces.js';
import type { StorageConfig } from '../src/storage/config.js';

/** Verify that an object structurally satisfies IStorageProvider. */
function assertStorageProviderShape(provider: IStorageProvider) {
  expect(typeof provider.name).toBe('string');
  expect(provider.threads).toBeDefined();
  expect(provider.assistants).toBeDefined();
  expect(provider.runs).toBeDefined();
  expect(provider.crons).toBeDefined();
  expect(provider.store).toBeDefined();
  expect(typeof provider.initialize).toBe('function');
  expect(typeof provider.close).toBe('function');

  // Thread storage methods
  expect(typeof provider.threads.create).toBe('function');
  expect(typeof provider.threads.getById).toBe('function');
  expect(typeof provider.threads.update).toBe('function');
  expect(typeof provider.threads.delete).toBe('function');
  expect(typeof provider.threads.search).toBe('function');
  expect(typeof provider.threads.count).toBe('function');
  expect(typeof provider.threads.getState).toBe('function');
  expect(typeof provider.threads.addState).toBe('function');
  expect(typeof provider.threads.getStateHistory).toBe('function');
  expect(typeof provider.threads.copyThread).toBe('function');

  // Assistant storage methods
  expect(typeof provider.assistants.create).toBe('function');
  expect(typeof provider.assistants.getVersions).toBe('function');
  expect(typeof provider.assistants.addVersion).toBe('function');
  expect(typeof provider.assistants.setLatestVersion).toBe('function');

  // Run storage methods
  expect(typeof provider.runs.listByThreadId).toBe('function');

  // Store storage methods
  expect(typeof provider.store.putItem).toBe('function');
  expect(typeof provider.store.getItem).toBe('function');
  expect(typeof provider.store.deleteItem).toBe('function');
  expect(typeof provider.store.searchItems).toBe('function');
  expect(typeof provider.store.listNamespaces).toBe('function');
}

describe('Storage Provider Factory', () => {
  const providers: IStorageProvider[] = [];
  const tmpFiles: string[] = [];

  afterEach(async () => {
    // Close all providers created during the test
    for (const p of providers) {
      try { await p.close(); } catch { /* ignore */ }
    }
    providers.length = 0;

    // Clean up temp files
    for (const f of tmpFiles) {
      try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
      // SQLite WAL + SHM files
      try { if (existsSync(f + '-wal')) unlinkSync(f + '-wal'); } catch { /* ignore */ }
      try { if (existsSync(f + '-shm')) unlinkSync(f + '-shm'); } catch { /* ignore */ }
    }
    tmpFiles.length = 0;
  });

  // -----------------------------------------------------------------------
  // Memory provider
  // -----------------------------------------------------------------------
  it('should create a memory provider', async () => {
    const provider = await createStorageProvider({ provider: 'memory' });
    providers.push(provider);

    expect(provider.name).toBe('memory');
    assertStorageProviderShape(provider);
  });

  // -----------------------------------------------------------------------
  // SQLite provider
  // -----------------------------------------------------------------------
  it('should create a SQLite provider with a temp file', async () => {
    const dbPath = path.join(os.tmpdir(), `test-lg-api-factory-${Date.now()}.db`);
    tmpFiles.push(dbPath);

    const provider = await createStorageProvider({
      provider: 'sqlite',
      sqlite: { path: dbPath },
    });
    providers.push(provider);

    expect(provider.name).toBe('sqlite');
    assertStorageProviderShape(provider);
    expect(existsSync(dbPath)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Unknown provider
  // -----------------------------------------------------------------------
  it('should throw for an unknown provider type', async () => {
    const bogusConfig = { provider: 'redis' } as unknown as StorageConfig;
    await expect(createStorageProvider(bogusConfig)).rejects.toThrow(/Unknown storage provider/);
  });

  // -----------------------------------------------------------------------
  // Missing config section
  // -----------------------------------------------------------------------
  it('should throw when sqlite config section is missing', async () => {
    await expect(
      createStorageProvider({ provider: 'sqlite' }),
    ).rejects.toThrow(/SQLite configuration is required/);
  });
});
