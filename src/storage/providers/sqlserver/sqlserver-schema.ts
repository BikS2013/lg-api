/**
 * SQL Server Schema Definitions
 *
 * Table creation SQL (T-SQL) for the SQL Server storage provider.
 * Uses singular table naming per project conventions.
 * Uses IF NOT EXISTS pattern via sys.tables checks.
 * Uses NVARCHAR(MAX) for JSON columns (Option A - SQL Server 2016-2022 compatible).
 * Uses NVARCHAR(36) for UUID fields, DATETIMEOFFSET for timestamps, BIT for booleans.
 */

export const CREATE_THREAD_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Thread')
  CREATE TABLE Thread (
    thread_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    created_at DATETIMEOFFSET NOT NULL,
    updated_at DATETIMEOFFSET NOT NULL,
    metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Thread_metadata DEFAULT '{}',
    status NVARCHAR(20) NOT NULL CONSTRAINT DF_Thread_status DEFAULT 'idle',
    [values] NVARCHAR(MAX) NULL,
    interrupts NVARCHAR(MAX) NULL
  )
`;

export const CREATE_THREAD_INDEXES = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_thread_status' AND object_id = OBJECT_ID('Thread'))
    CREATE INDEX idx_thread_status ON Thread(status);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_thread_created_at' AND object_id = OBJECT_ID('Thread'))
    CREATE INDEX idx_thread_created_at ON Thread(created_at DESC);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_thread_updated_at' AND object_id = OBJECT_ID('Thread'))
    CREATE INDEX idx_thread_updated_at ON Thread(updated_at DESC);
`;

export const CREATE_THREAD_STATE_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ThreadState')
  CREATE TABLE ThreadState (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    thread_id NVARCHAR(36) NOT NULL,
    [values] NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ThreadState_values DEFAULT '{}',
    next NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ThreadState_next DEFAULT '[]',
    checkpoint NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ThreadState_checkpoint DEFAULT '{}',
    metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ThreadState_metadata DEFAULT '{}',
    created_at DATETIMEOFFSET NOT NULL,
    parent_checkpoint NVARCHAR(MAX) NULL,
    tasks NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ThreadState_tasks DEFAULT '[]',
    interrupts NVARCHAR(MAX) NULL,
    CONSTRAINT FK_ThreadState_Thread FOREIGN KEY (thread_id)
      REFERENCES Thread(thread_id) ON DELETE CASCADE
  )
`;

export const CREATE_THREAD_STATE_INDEX = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_thread_state_thread_id' AND object_id = OBJECT_ID('ThreadState'))
    CREATE INDEX idx_thread_state_thread_id ON ThreadState(thread_id, created_at DESC);
`;

export const CREATE_ASSISTANT_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Assistant')
  CREATE TABLE Assistant (
    assistant_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    graph_id NVARCHAR(255) NOT NULL,
    config NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Assistant_config DEFAULT '{}',
    context NVARCHAR(MAX) NULL,
    created_at DATETIMEOFFSET NOT NULL,
    updated_at DATETIMEOFFSET NOT NULL,
    metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Assistant_metadata DEFAULT '{}',
    version INT NOT NULL CONSTRAINT DF_Assistant_version DEFAULT 1,
    name NVARCHAR(255) NOT NULL,
    description NVARCHAR(MAX) NULL
  )
`;

export const CREATE_ASSISTANT_INDEXES = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_assistant_graph_id' AND object_id = OBJECT_ID('Assistant'))
    CREATE INDEX idx_assistant_graph_id ON Assistant(graph_id);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_assistant_name' AND object_id = OBJECT_ID('Assistant'))
    CREATE INDEX idx_assistant_name ON Assistant(name);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_assistant_created_at' AND object_id = OBJECT_ID('Assistant'))
    CREATE INDEX idx_assistant_created_at ON Assistant(created_at DESC);
`;

export const CREATE_ASSISTANT_VERSION_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AssistantVersion')
  CREATE TABLE AssistantVersion (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    assistant_id NVARCHAR(36) NOT NULL,
    graph_id NVARCHAR(255) NOT NULL,
    config NVARCHAR(MAX) NOT NULL CONSTRAINT DF_AssistantVersion_config DEFAULT '{}',
    context NVARCHAR(MAX) NULL,
    created_at DATETIMEOFFSET NOT NULL,
    updated_at DATETIMEOFFSET NOT NULL,
    metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_AssistantVersion_metadata DEFAULT '{}',
    version INT NOT NULL,
    name NVARCHAR(255) NOT NULL,
    description NVARCHAR(MAX) NULL,
    CONSTRAINT FK_AssistantVersion_Assistant FOREIGN KEY (assistant_id)
      REFERENCES Assistant(assistant_id) ON DELETE CASCADE
  )
`;

export const CREATE_ASSISTANT_VERSION_INDEX = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_assistant_version_assistant_id' AND object_id = OBJECT_ID('AssistantVersion'))
    CREATE INDEX idx_assistant_version_assistant_id ON AssistantVersion(assistant_id, version DESC);
`;

export const CREATE_RUN_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Run')
  CREATE TABLE Run (
    run_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    thread_id NVARCHAR(36) NULL,
    assistant_id NVARCHAR(36) NOT NULL,
    created_at DATETIMEOFFSET NOT NULL,
    updated_at DATETIMEOFFSET NOT NULL,
    status NVARCHAR(20) NOT NULL CONSTRAINT DF_Run_status DEFAULT 'pending',
    metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Run_metadata DEFAULT '{}',
    multitask_strategy NVARCHAR(20) NULL,
    kwargs NVARCHAR(MAX) NULL
  )
`;

export const CREATE_RUN_INDEXES = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_run_thread_id' AND object_id = OBJECT_ID('Run'))
    CREATE INDEX idx_run_thread_id ON Run(thread_id, created_at DESC);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_run_status' AND object_id = OBJECT_ID('Run'))
    CREATE INDEX idx_run_status ON Run(status);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_run_assistant_id' AND object_id = OBJECT_ID('Run'))
    CREATE INDEX idx_run_assistant_id ON Run(assistant_id);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_run_created_at' AND object_id = OBJECT_ID('Run'))
    CREATE INDEX idx_run_created_at ON Run(created_at DESC);
`;

export const CREATE_CRON_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Cron')
  CREATE TABLE Cron (
    cron_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    assistant_id NVARCHAR(36) NOT NULL,
    thread_id NVARCHAR(36) NULL,
    schedule NVARCHAR(255) NOT NULL,
    created_at DATETIMEOFFSET NOT NULL,
    updated_at DATETIMEOFFSET NOT NULL,
    metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_Cron_metadata DEFAULT '{}',
    enabled BIT NOT NULL CONSTRAINT DF_Cron_enabled DEFAULT 1,
    on_run_completed NVARCHAR(20) NULL,
    end_time DATETIMEOFFSET NULL,
    payload NVARCHAR(MAX) NULL,
    user_id NVARCHAR(255) NULL,
    next_run_date DATETIMEOFFSET NULL
  )
`;

export const CREATE_CRON_INDEXES = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_cron_enabled' AND object_id = OBJECT_ID('Cron'))
    CREATE INDEX idx_cron_enabled ON Cron(enabled);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_cron_assistant_id' AND object_id = OBJECT_ID('Cron'))
    CREATE INDEX idx_cron_assistant_id ON Cron(assistant_id);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_cron_thread_id' AND object_id = OBJECT_ID('Cron'))
    CREATE INDEX idx_cron_thread_id ON Cron(thread_id);

  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_cron_next_run_date' AND object_id = OBJECT_ID('Cron'))
    CREATE INDEX idx_cron_next_run_date ON Cron(next_run_date);
`;

export const CREATE_STORE_ITEM_TABLE = `
  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'StoreItem')
  CREATE TABLE StoreItem (
    namespace NVARCHAR(900) NOT NULL,
    [key] NVARCHAR(255) NOT NULL,
    value NVARCHAR(MAX) NOT NULL CONSTRAINT DF_StoreItem_value DEFAULT '{}',
    created_at DATETIMEOFFSET NOT NULL,
    updated_at DATETIMEOFFSET NOT NULL,
    CONSTRAINT PK_StoreItem PRIMARY KEY (namespace, [key])
  )
`;

export const CREATE_STORE_ITEM_INDEXES = `
  IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_store_namespace' AND object_id = OBJECT_ID('StoreItem'))
    CREATE INDEX idx_store_namespace ON StoreItem(namespace);
`;

/**
 * All schema creation statements in dependency order.
 * Each entry is executed as a separate batch.
 */
export const ALL_SCHEMA_STATEMENTS: string[] = [
  CREATE_THREAD_TABLE,
  CREATE_THREAD_INDEXES,
  CREATE_THREAD_STATE_TABLE,
  CREATE_THREAD_STATE_INDEX,
  CREATE_ASSISTANT_TABLE,
  CREATE_ASSISTANT_INDEXES,
  CREATE_ASSISTANT_VERSION_TABLE,
  CREATE_ASSISTANT_VERSION_INDEX,
  CREATE_RUN_TABLE,
  CREATE_RUN_INDEXES,
  CREATE_CRON_TABLE,
  CREATE_CRON_INDEXES,
  CREATE_STORE_ITEM_TABLE,
  CREATE_STORE_ITEM_INDEXES,
];
