/**
 * Smoke tests for the In-Memory Storage Provider.
 *
 * Verifies that the memory provider adapter correctly delegates
 * to the underlying in-memory repositories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { InMemoryStorageProvider } from '../src/storage/providers/memory/memory-provider.js';
import type { IStorageProvider } from '../src/storage/interfaces.js';

let provider: IStorageProvider;

beforeEach(async () => {
  provider = new InMemoryStorageProvider();
  await provider.initialize();
});

afterEach(async () => {
  await provider.close();
});

describe('Memory Provider - Thread smoke tests', () => {
  it('should have name "memory"', () => {
    expect(provider.name).toBe('memory');
  });

  it('should create and retrieve a thread', async () => {
    const now = new Date().toISOString();
    const thread = {
      thread_id: randomUUID(),
      created_at: now,
      updated_at: now,
      metadata: { foo: 'bar' },
      status: 'idle' as const,
    };

    const created = await provider.threads.create(thread);
    expect(created.thread_id).toBe(thread.thread_id);

    const fetched = await provider.threads.getById(thread.thread_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.metadata).toEqual({ foo: 'bar' });
  });

  it('should search threads and return results', async () => {
    const now = new Date().toISOString();
    await provider.threads.create({
      thread_id: randomUUID(),
      created_at: now,
      updated_at: now,
      metadata: {},
      status: 'idle',
    });
    await provider.threads.create({
      thread_id: randomUUID(),
      created_at: now,
      updated_at: now,
      metadata: {},
      status: 'busy',
    });

    const result = await provider.threads.search({ limit: 10, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(2);
  });

  it('should count threads', async () => {
    const now = new Date().toISOString();
    await provider.threads.create({
      thread_id: randomUUID(),
      created_at: now,
      updated_at: now,
      metadata: {},
      status: 'idle',
    });

    const count = await provider.threads.count();
    expect(count).toBe(1);
  });

  it('should return null for non-existent thread', async () => {
    const result = await provider.threads.getById(randomUUID());
    expect(result).toBeNull();
  });
});

describe('Memory Provider - Assistant smoke tests', () => {
  it('should create and retrieve an assistant', async () => {
    const now = new Date().toISOString();
    const assistant = {
      assistant_id: randomUUID(),
      graph_id: 'test-graph',
      config: {},
      created_at: now,
      updated_at: now,
      metadata: {},
      version: 1,
      name: 'Test',
      description: null,
    };

    const created = await provider.assistants.create(assistant);
    expect(created.assistant_id).toBe(assistant.assistant_id);

    const fetched = await provider.assistants.getById(assistant.assistant_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.graph_id).toBe('test-graph');
  });
});

describe('Memory Provider - Store smoke tests', () => {
  it('should put and get a store item', async () => {
    const item = await provider.store.putItem(['ns1'], 'key1', { data: 42 });
    expect(item.key).toBe('key1');
    expect(item.value).toEqual({ data: 42 });

    const fetched = await provider.store.getItem(['ns1'], 'key1');
    expect(fetched).not.toBeNull();
    expect(fetched!.value).toEqual({ data: 42 });
  });
});
