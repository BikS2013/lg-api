/**
 * SQLite Storage Provider
 *
 * Implements IStorageProvider using better-sqlite3.
 * Creates and manages a SQLite database with all required tables.
 * Enables WAL mode by default for better concurrent read performance.
 */

import Database from 'better-sqlite3';
import type { SqliteConfig } from '../../config.js';
import type {
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage,
} from '../../interfaces.js';
import { ALL_TABLES } from './sqlite-schema.js';
import { SqliteThreadStorage } from './sqlite-thread-storage.js';
import { SqliteAssistantStorage } from './sqlite-assistant-storage.js';
import { SqliteRunStorage } from './sqlite-run-storage.js';
import { SqliteCronStorage } from './sqlite-cron-storage.js';
import { SqliteStoreStorage } from './sqlite-store-storage.js';

export class SqliteStorageProvider implements IStorageProvider {
  readonly name = 'sqlite';

  threads: IThreadStorage;
  assistants: IAssistantStorage;
  runs: IRunStorage;
  crons: ICronStorage;
  store: IStoreStorage;

  private db: Database.Database;
  private config: SqliteConfig;

  constructor(config: SqliteConfig) {
    this.config = config;
    this.db = new Database(config.path);

    this.threads = new SqliteThreadStorage(this.db);
    this.assistants = new SqliteAssistantStorage(this.db);
    this.runs = new SqliteRunStorage(this.db);
    this.crons = new SqliteCronStorage(this.db);
    this.store = new SqliteStoreStorage(this.db);
  }

  async initialize(): Promise<void> {
    // Enable WAL mode unless explicitly disabled
    if (this.config.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Create all tables and indexes
    for (const sql of ALL_TABLES) {
      this.db.exec(sql);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
