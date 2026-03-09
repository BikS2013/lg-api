/**
 * SQLite Schema Definitions
 *
 * Table creation SQL for the SQLite storage provider.
 * Uses singular table naming per project conventions.
 */

export const CREATE_THREAD_TABLE = `
  CREATE TABLE IF NOT EXISTS Thread (
    thread_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle',
    "values" TEXT,
    interrupts TEXT
  )
`;

export const CREATE_THREAD_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS ThreadState (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    "values" TEXT NOT NULL DEFAULT '{}',
    next TEXT NOT NULL DEFAULT '[]',
    checkpoint TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    parent_checkpoint TEXT,
    tasks TEXT NOT NULL DEFAULT '[]',
    interrupts TEXT,
    FOREIGN KEY (thread_id) REFERENCES Thread(thread_id) ON DELETE CASCADE
  )
`;

export const CREATE_THREAD_STATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_thread_state_thread_id
    ON ThreadState(thread_id, created_at DESC)
`;

export const CREATE_ASSISTANT_TABLE = `
  CREATE TABLE IF NOT EXISTS Assistant (
    assistant_id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    context TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    description TEXT
  )
`;

export const CREATE_ASSISTANT_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS AssistantVersion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assistant_id TEXT NOT NULL,
    graph_id TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    context TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    FOREIGN KEY (assistant_id) REFERENCES Assistant(assistant_id) ON DELETE CASCADE
  )
`;

export const CREATE_ASSISTANT_VERSION_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_assistant_version_assistant_id
    ON AssistantVersion(assistant_id, version DESC)
`;

export const CREATE_RUN_TABLE = `
  CREATE TABLE IF NOT EXISTS Run (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT,
    assistant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata TEXT NOT NULL DEFAULT '{}',
    multitask_strategy TEXT,
    kwargs TEXT
  )
`;

export const CREATE_RUN_THREAD_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_run_thread_id
    ON Run(thread_id, created_at DESC)
`;

export const CREATE_CRON_TABLE = `
  CREATE TABLE IF NOT EXISTS Cron (
    cron_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    thread_id TEXT,
    schedule TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    on_run_completed TEXT,
    end_time TEXT,
    payload TEXT,
    user_id TEXT,
    next_run_date TEXT
  )
`;

export const CREATE_STORE_ITEM_TABLE = `
  CREATE TABLE IF NOT EXISTS StoreItem (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  )
`;

export const ALL_TABLES = [
  CREATE_THREAD_TABLE,
  CREATE_THREAD_STATE_TABLE,
  CREATE_THREAD_STATE_INDEX,
  CREATE_ASSISTANT_TABLE,
  CREATE_ASSISTANT_VERSION_TABLE,
  CREATE_ASSISTANT_VERSION_INDEX,
  CREATE_RUN_TABLE,
  CREATE_RUN_THREAD_INDEX,
  CREATE_CRON_TABLE,
  CREATE_STORE_ITEM_TABLE,
];
