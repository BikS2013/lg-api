/**
 * SQL Server Storage Provider
 *
 * Implements IStorageProvider using the mssql package with connection pooling.
 * All configuration values are required -- no fallback values are used.
 */

import * as sql from 'mssql';
import type { SqlServerConfig } from '../../config.js';
import type {
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage,
} from '../../interfaces.js';
import { ALL_SCHEMA_STATEMENTS } from './sqlserver-schema.js';
import { SqlServerThreadStorage } from './sqlserver-thread-storage.js';
import { SqlServerAssistantStorage } from './sqlserver-assistant-storage.js';
import { SqlServerRunStorage } from './sqlserver-run-storage.js';
import { SqlServerCronStorage } from './sqlserver-cron-storage.js';
import { SqlServerStoreStorage } from './sqlserver-store-storage.js';

export class SqlServerStorageProvider implements IStorageProvider {
  readonly name = 'sqlserver';

  threads!: IThreadStorage;
  assistants!: IAssistantStorage;
  runs!: IRunStorage;
  crons!: ICronStorage;
  store!: IStoreStorage;

  private pool: sql.ConnectionPool | null = null;
  private config: SqlServerConfig;

  constructor(config: SqlServerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const poolConfig: sql.config = {
      server: this.config.server,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      port: this.config.port,
      options: {
        encrypt: this.config.encrypt,
        trustServerCertificate: this.config.trustServerCertificate,
      },
    };

    this.pool = new sql.ConnectionPool(poolConfig);
    await this.pool.connect();

    // Create tables if they do not exist
    for (const statement of ALL_SCHEMA_STATEMENTS) {
      await this.pool.request().query(statement);
    }

    // Wire up entity storage instances
    this.threads = new SqlServerThreadStorage(this.pool);
    this.assistants = new SqlServerAssistantStorage(this.pool);
    this.runs = new SqlServerRunStorage(this.pool);
    this.crons = new SqlServerCronStorage(this.pool);
    this.store = new SqlServerStoreStorage(this.pool);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }
}
