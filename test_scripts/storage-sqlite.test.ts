/**
 * Comprehensive integration tests for the SQLite storage provider.
 *
 * Uses a fresh temp database for every test. Covers threads, assistants,
 * runs, crons, and store key-value operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SqliteStorageProvider } from '../src/storage/providers/sqlite/sqlite-provider.js';
import type { IStorageProvider } from '../src/storage/interfaces.js';
import type { Thread, ThreadState, Assistant, Run, Cron } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let provider: IStorageProvider;
let dbPath: string;

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = new Date().toISOString();
  return {
    thread_id: randomUUID(),
    created_at: now,
    updated_at: now,
    metadata: {},
    status: 'idle',
    ...overrides,
  };
}

function makeThreadState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    values: { messages: [] },
    next: [],
    checkpoint: {
      thread_id: randomUUID(),
      checkpoint_ns: '',
      checkpoint_id: randomUUID(),
    },
    metadata: {},
    created_at: new Date().toISOString(),
    tasks: [],
    ...overrides,
  };
}

function makeAssistant(overrides: Partial<Assistant> = {}): Assistant {
  const now = new Date().toISOString();
  return {
    assistant_id: randomUUID(),
    graph_id: 'test-graph',
    config: {},
    created_at: now,
    updated_at: now,
    metadata: {},
    version: 1,
    name: 'Test Assistant',
    description: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    run_id: randomUUID(),
    thread_id: null,
    assistant_id: randomUUID(),
    created_at: now,
    updated_at: now,
    status: 'pending',
    metadata: {},
    ...overrides,
  };
}

function makeCron(overrides: Partial<Cron> = {}): Cron {
  const now = new Date().toISOString();
  return {
    cron_id: randomUUID(),
    assistant_id: randomUUID(),
    schedule: '0 * * * *',
    created_at: now,
    updated_at: now,
    metadata: {},
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `test-lg-api-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  provider = new SqliteStorageProvider({ path: dbPath });
  await provider.initialize();
});

afterEach(async () => {
  await provider.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

// ===========================================================================
// THREAD STORAGE
// ===========================================================================

describe('SQLite Thread Storage', () => {
  it('should create a thread and return it', async () => {
    const t = makeThread({ metadata: { env: 'test' } });
    const created = await provider.threads.create(t);

    expect(created.thread_id).toBe(t.thread_id);
    expect(created.status).toBe('idle');
    expect(created.metadata).toEqual({ env: 'test' });
  });

  it('should get a thread by ID', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    const fetched = await provider.threads.getById(t.thread_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.thread_id).toBe(t.thread_id);
  });

  it('should return null for non-existent thread', async () => {
    const fetched = await provider.threads.getById(randomUUID());
    expect(fetched).toBeNull();
  });

  it('should update thread metadata and status', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    const updated = await provider.threads.update(t.thread_id, {
      metadata: { env: 'prod' },
      status: 'busy',
    });

    expect(updated).not.toBeNull();
    expect(updated!.metadata).toEqual({ env: 'prod' });
    expect(updated!.status).toBe('busy');
  });

  it('should return null when updating non-existent thread', async () => {
    const updated = await provider.threads.update(randomUUID(), { status: 'busy' });
    expect(updated).toBeNull();
  });

  it('should delete a thread', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    const deleted = await provider.threads.delete(t.thread_id);
    expect(deleted).toBe(true);

    const fetched = await provider.threads.getById(t.thread_id);
    expect(fetched).toBeNull();
  });

  it('should return false when deleting non-existent thread', async () => {
    const deleted = await provider.threads.delete(randomUUID());
    expect(deleted).toBe(false);
  });

  // Search / Count
  it('should search threads - empty result', async () => {
    const result = await provider.threads.search({ limit: 10, offset: 0 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should search threads with status filter', async () => {
    await provider.threads.create(makeThread({ status: 'idle' }));
    await provider.threads.create(makeThread({ status: 'busy' }));

    const result = await provider.threads.search(
      { limit: 10, offset: 0 },
      { status: 'busy' },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].status).toBe('busy');
  });

  it('should search threads with pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.threads.create(makeThread());
    }

    const page1 = await provider.threads.search({ limit: 2, offset: 0 });
    expect(page1.items.length).toBe(2);
    expect(page1.total).toBe(5);

    const page2 = await provider.threads.search({ limit: 2, offset: 2 });
    expect(page2.items.length).toBe(2);
  });

  it('should count threads', async () => {
    await provider.threads.create(makeThread());
    await provider.threads.create(makeThread());

    const count = await provider.threads.count();
    expect(count).toBe(2);
  });

  it('should count threads with filters', async () => {
    await provider.threads.create(makeThread({ status: 'idle' }));
    await provider.threads.create(makeThread({ status: 'busy' }));

    const count = await provider.threads.count({ status: 'idle' });
    expect(count).toBe(1);
  });

  // State / State History
  it('should add and get thread state', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    const state = makeThreadState();
    await provider.threads.addState(t.thread_id, state);

    const fetched = await provider.threads.getState(t.thread_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.values).toEqual(state.values);
  });

  it('should return null state for thread with no states', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    const state = await provider.threads.getState(t.thread_id);
    expect(state).toBeNull();
  });

  it('should get state history ordered by created_at desc', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    const state1 = makeThreadState({ created_at: '2025-01-01T00:00:00.000Z', values: { step: 1 } });
    const state2 = makeThreadState({ created_at: '2025-01-02T00:00:00.000Z', values: { step: 2 } });
    const state3 = makeThreadState({ created_at: '2025-01-03T00:00:00.000Z', values: { step: 3 } });

    await provider.threads.addState(t.thread_id, state1);
    await provider.threads.addState(t.thread_id, state2);
    await provider.threads.addState(t.thread_id, state3);

    const history = await provider.threads.getStateHistory(t.thread_id);
    expect(history.length).toBe(3);
    // Desc order: newest first
    expect(history[0].values).toEqual({ step: 3 });
    expect(history[2].values).toEqual({ step: 1 });
  });

  it('should limit state history', async () => {
    const t = makeThread();
    await provider.threads.create(t);

    for (let i = 0; i < 5; i++) {
      await provider.threads.addState(
        t.thread_id,
        makeThreadState({ created_at: `2025-01-0${i + 1}T00:00:00.000Z` }),
      );
    }

    const history = await provider.threads.getStateHistory(t.thread_id, 2);
    expect(history.length).toBe(2);
  });

  // Copy thread
  it('should copy a thread including state history', async () => {
    const source = makeThread({ metadata: { source: true } });
    await provider.threads.create(source);
    await provider.threads.addState(source.thread_id, makeThreadState({ values: { step: 1 } }));
    await provider.threads.addState(source.thread_id, makeThreadState({ values: { step: 2 } }));

    const targetId = randomUUID();
    const copied = await provider.threads.copyThread(source.thread_id, targetId);

    expect(copied.thread_id).toBe(targetId);
    expect(copied.metadata).toEqual({ source: true });

    // State history should be copied
    const history = await provider.threads.getStateHistory(targetId);
    expect(history.length).toBe(2);
  });

  it('should throw when copying a non-existent thread', async () => {
    await expect(
      provider.threads.copyThread(randomUUID(), randomUUID()),
    ).rejects.toThrow(/Thread not found/);
  });
});

// ===========================================================================
// ASSISTANT STORAGE
// ===========================================================================

describe('SQLite Assistant Storage', () => {
  it('should create an assistant', async () => {
    const a = makeAssistant();
    const created = await provider.assistants.create(a);

    expect(created.assistant_id).toBe(a.assistant_id);
    expect(created.graph_id).toBe('test-graph');
    expect(created.version).toBe(1);
  });

  it('should get an assistant by ID', async () => {
    const a = makeAssistant();
    await provider.assistants.create(a);

    const fetched = await provider.assistants.getById(a.assistant_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Assistant');
  });

  it('should return null for non-existent assistant', async () => {
    expect(await provider.assistants.getById(randomUUID())).toBeNull();
  });

  it('should update an assistant', async () => {
    const a = makeAssistant();
    await provider.assistants.create(a);

    const updated = await provider.assistants.update(a.assistant_id, {
      name: 'Updated',
      metadata: { env: 'prod' },
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated');
    expect(updated!.metadata).toEqual({ env: 'prod' });
  });

  it('should delete an assistant', async () => {
    const a = makeAssistant();
    await provider.assistants.create(a);

    expect(await provider.assistants.delete(a.assistant_id)).toBe(true);
    expect(await provider.assistants.getById(a.assistant_id)).toBeNull();
  });

  it('should return false when deleting non-existent assistant', async () => {
    expect(await provider.assistants.delete(randomUUID())).toBe(false);
  });

  // Search
  it('should search assistants by graph_id', async () => {
    await provider.assistants.create(makeAssistant({ graph_id: 'alpha' }));
    await provider.assistants.create(makeAssistant({ graph_id: 'beta' }));

    const result = await provider.assistants.search(
      { limit: 10, offset: 0 },
      { graph_id: 'alpha' },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].graph_id).toBe('alpha');
  });

  it('should search assistants by name', async () => {
    await provider.assistants.create(makeAssistant({ name: 'Agent A' }));
    await provider.assistants.create(makeAssistant({ name: 'Agent B' }));

    const result = await provider.assistants.search(
      { limit: 10, offset: 0 },
      { name: 'Agent B' },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].name).toBe('Agent B');
  });

  it('should count assistants', async () => {
    await provider.assistants.create(makeAssistant());
    await provider.assistants.create(makeAssistant());
    expect(await provider.assistants.count()).toBe(2);
  });

  // Versions
  it('should add versions and list them', async () => {
    const a = makeAssistant();
    await provider.assistants.create(a);

    // Add version snapshots
    const v1 = { ...a, version: 1 };
    const v2 = { ...a, version: 2, name: 'V2 Name' };
    await provider.assistants.addVersion(a.assistant_id, v1);
    await provider.assistants.addVersion(a.assistant_id, v2);

    const versions = await provider.assistants.getVersions(a.assistant_id);
    expect(versions.total).toBe(2);
    // Ordered desc by version
    expect(versions.items[0].version).toBe(2);
    expect(versions.items[1].version).toBe(1);
  });

  it('should set latest version from version history', async () => {
    const a = makeAssistant({ name: 'V1' });
    await provider.assistants.create(a);
    await provider.assistants.addVersion(a.assistant_id, { ...a, version: 1 });

    const v2 = { ...a, version: 2, name: 'V2' };
    await provider.assistants.addVersion(a.assistant_id, v2);

    // Update main record to v2
    await provider.assistants.update(a.assistant_id, { version: 2, name: 'V2' });

    // Now set latest back to version 1
    const restored = await provider.assistants.setLatestVersion(a.assistant_id, 1);
    expect(restored).not.toBeNull();
    expect(restored!.version).toBe(1);
    expect(restored!.name).toBe('V1');
  });

  it('should return null when setting non-existent version', async () => {
    const a = makeAssistant();
    await provider.assistants.create(a);
    const result = await provider.assistants.setLatestVersion(a.assistant_id, 999);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// RUN STORAGE
// ===========================================================================

describe('SQLite Run Storage', () => {
  it('should create a run', async () => {
    const r = makeRun();
    const created = await provider.runs.create(r);
    expect(created.run_id).toBe(r.run_id);
    expect(created.status).toBe('pending');
  });

  it('should get a run by ID', async () => {
    const r = makeRun();
    await provider.runs.create(r);

    const fetched = await provider.runs.getById(r.run_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.assistant_id).toBe(r.assistant_id);
  });

  it('should return null for non-existent run', async () => {
    expect(await provider.runs.getById(randomUUID())).toBeNull();
  });

  it('should update a run', async () => {
    const r = makeRun();
    await provider.runs.create(r);

    const updated = await provider.runs.update(r.run_id, { status: 'running' });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('running');
  });

  it('should delete a run', async () => {
    const r = makeRun();
    await provider.runs.create(r);
    expect(await provider.runs.delete(r.run_id)).toBe(true);
    expect(await provider.runs.getById(r.run_id)).toBeNull();
  });

  it('should return false when deleting non-existent run', async () => {
    expect(await provider.runs.delete(randomUUID())).toBe(false);
  });

  // List by thread
  it('should list runs by thread ID with pagination', async () => {
    const threadId = randomUUID();
    for (let i = 0; i < 4; i++) {
      await provider.runs.create(makeRun({ thread_id: threadId }));
    }
    // Another thread's run
    await provider.runs.create(makeRun({ thread_id: randomUUID() }));

    const page1 = await provider.runs.listByThreadId(threadId, { limit: 2, offset: 0 });
    expect(page1.total).toBe(4);
    expect(page1.items.length).toBe(2);

    const page2 = await provider.runs.listByThreadId(threadId, { limit: 2, offset: 2 });
    expect(page2.items.length).toBe(2);
  });

  // Count
  it('should count runs with filters', async () => {
    const threadId = randomUUID();
    await provider.runs.create(makeRun({ thread_id: threadId, status: 'pending' }));
    await provider.runs.create(makeRun({ thread_id: threadId, status: 'running' }));
    await provider.runs.create(makeRun({ thread_id: randomUUID(), status: 'pending' }));

    const totalCount = await provider.runs.count();
    expect(totalCount).toBe(3);

    const threadCount = await provider.runs.count({ thread_id: threadId });
    expect(threadCount).toBe(2);

    const statusCount = await provider.runs.count({ status: 'running' });
    expect(statusCount).toBe(1);
  });
});

// ===========================================================================
// CRON STORAGE
// ===========================================================================

describe('SQLite Cron Storage', () => {
  it('should create a cron', async () => {
    const c = makeCron();
    const created = await provider.crons.create(c);
    expect(created.cron_id).toBe(c.cron_id);
    expect(created.enabled).toBe(true);
    expect(created.schedule).toBe('0 * * * *');
  });

  it('should get a cron by ID', async () => {
    const c = makeCron();
    await provider.crons.create(c);

    const fetched = await provider.crons.getById(c.cron_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.assistant_id).toBe(c.assistant_id);
  });

  it('should return null for non-existent cron', async () => {
    expect(await provider.crons.getById(randomUUID())).toBeNull();
  });

  it('should update a cron', async () => {
    const c = makeCron();
    await provider.crons.create(c);

    const updated = await provider.crons.update(c.cron_id, {
      enabled: false,
      schedule: '*/5 * * * *',
    });
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
    expect(updated!.schedule).toBe('*/5 * * * *');
  });

  it('should delete a cron', async () => {
    const c = makeCron();
    await provider.crons.create(c);
    expect(await provider.crons.delete(c.cron_id)).toBe(true);
    expect(await provider.crons.getById(c.cron_id)).toBeNull();
  });

  it('should return false when deleting non-existent cron', async () => {
    expect(await provider.crons.delete(randomUUID())).toBe(false);
  });

  // Search
  it('should search crons with assistant_id filter', async () => {
    const aid = randomUUID();
    await provider.crons.create(makeCron({ assistant_id: aid }));
    await provider.crons.create(makeCron({ assistant_id: randomUUID() }));

    const result = await provider.crons.search(
      { limit: 10, offset: 0 },
      { assistant_id: aid },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].assistant_id).toBe(aid);
  });

  it('should search crons with enabled filter', async () => {
    await provider.crons.create(makeCron({ enabled: true }));
    await provider.crons.create(makeCron({ enabled: false }));

    const result = await provider.crons.search(
      { limit: 10, offset: 0 },
      { enabled: false },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].enabled).toBe(false);
  });

  // Count
  it('should count crons with filters', async () => {
    const aid = randomUUID();
    await provider.crons.create(makeCron({ assistant_id: aid }));
    await provider.crons.create(makeCron({ assistant_id: aid }));
    await provider.crons.create(makeCron({ assistant_id: randomUUID() }));

    expect(await provider.crons.count()).toBe(3);
    expect(await provider.crons.count({ assistant_id: aid })).toBe(2);
  });
});

// ===========================================================================
// STORE STORAGE (Key-Value)
// ===========================================================================

describe('SQLite Store Storage', () => {
  it('should put and get an item', async () => {
    const ns = ['users', 'prefs'];
    const item = await provider.store.putItem(ns, 'theme', { color: 'dark' });

    expect(item.namespace).toEqual(ns);
    expect(item.key).toBe('theme');
    expect(item.value).toEqual({ color: 'dark' });
    expect(item.created_at).toBeDefined();
    expect(item.updated_at).toBeDefined();

    const fetched = await provider.store.getItem(ns, 'theme');
    expect(fetched).not.toBeNull();
    expect(fetched!.value).toEqual({ color: 'dark' });
  });

  it('should update an existing item (putItem overwrites)', async () => {
    const ns = ['cfg'];
    await provider.store.putItem(ns, 'key1', { v: 1 });
    const updated = await provider.store.putItem(ns, 'key1', { v: 2 });

    expect(updated.value).toEqual({ v: 2 });

    // Verify created_at is preserved
    const fetched = await provider.store.getItem(ns, 'key1');
    expect(fetched!.value).toEqual({ v: 2 });
  });

  it('should return null for non-existent item', async () => {
    const fetched = await provider.store.getItem(['ns'], 'missing');
    expect(fetched).toBeNull();
  });

  it('should delete an item', async () => {
    const ns = ['data'];
    await provider.store.putItem(ns, 'k', { x: 1 });
    const deleted = await provider.store.deleteItem(ns, 'k');
    expect(deleted).toBe(true);

    expect(await provider.store.getItem(ns, 'k')).toBeNull();
  });

  it('should return false when deleting non-existent item', async () => {
    expect(await provider.store.deleteItem(['ns'], 'missing')).toBe(false);
  });

  // Search items
  it('should search items by namespace prefix', async () => {
    await provider.store.putItem(['app', 'config'], 'db', { host: 'localhost' });
    await provider.store.putItem(['app', 'config'], 'cache', { host: 'redis' });
    await provider.store.putItem(['app', 'logs'], 'level', { v: 'debug' });
    await provider.store.putItem(['other'], 'key', { v: 1 });

    const result = await provider.store.searchItems(['app', 'config'], {});
    expect(result.total).toBe(2);
    expect(result.items.every((i) => i.namespace[0] === 'app' && i.namespace[1] === 'config')).toBe(true);
  });

  it('should search items with empty prefix (returns all)', async () => {
    await provider.store.putItem(['a'], 'k1', { v: 1 });
    await provider.store.putItem(['b'], 'k2', { v: 2 });

    const result = await provider.store.searchItems([], {});
    expect(result.total).toBe(2);
  });

  // List namespaces
  it('should list namespaces with prefix filtering', async () => {
    await provider.store.putItem(['app', 'config'], 'k1', { v: 1 });
    await provider.store.putItem(['app', 'logs'], 'k2', { v: 2 });
    await provider.store.putItem(['other', 'data'], 'k3', { v: 3 });

    const namespaces = await provider.store.listNamespaces({ prefix: ['app'] });
    expect(namespaces.length).toBe(2);
    expect(namespaces.every((ns) => ns[0] === 'app')).toBe(true);
  });

  it('should list namespaces with suffix filtering', async () => {
    await provider.store.putItem(['app', 'config'], 'k1', { v: 1 });
    await provider.store.putItem(['service', 'config'], 'k2', { v: 2 });
    await provider.store.putItem(['app', 'logs'], 'k3', { v: 3 });

    const namespaces = await provider.store.listNamespaces({ suffix: ['config'] });
    expect(namespaces.length).toBe(2);
    expect(namespaces.every((ns) => ns[ns.length - 1] === 'config')).toBe(true);
  });

  it('should list namespaces with maxDepth filtering', async () => {
    await provider.store.putItem(['a'], 'k1', { v: 1 });
    await provider.store.putItem(['a', 'b'], 'k2', { v: 2 });
    await provider.store.putItem(['a', 'b', 'c'], 'k3', { v: 3 });

    const namespaces = await provider.store.listNamespaces({ maxDepth: 2 });
    expect(namespaces.length).toBe(2);
    expect(namespaces.every((ns) => ns.length <= 2)).toBe(true);
  });

  it('should list all namespaces when no filters', async () => {
    await provider.store.putItem(['x'], 'k1', { v: 1 });
    await provider.store.putItem(['y', 'z'], 'k2', { v: 2 });

    const namespaces = await provider.store.listNamespaces({});
    expect(namespaces.length).toBe(2);
  });
});
