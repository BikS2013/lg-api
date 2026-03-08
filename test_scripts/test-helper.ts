/**
 * Test Helper
 *
 * Provides buildTestApp for full-app integration tests, and buildModuleApp
 * for module-specific tests that need shared repository instances.
 *
 * Works around the duplicate $id schema issue in Fastify's serialization
 * compiler by stripping $id from shared TypeBox schemas at module load time.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '../src/config/env.config.js';
import errorHandlerPlugin from '../src/plugins/error-handler.plugin.js';

// Import all schemas with $id that are reused across routes.
import { CheckpointSchema, ConfigSchema, InterruptSchema, CommandSchema, ErrorResponseSchema, GraphSchemaSchema, StreamPartSchema, MetadataSchema } from '../src/schemas/common.schema.js';
import { ThreadStatusEnum, RunStatusEnum, MultitaskStrategyEnum, StreamModeEnum, IfExistsEnum, OnCompletionEnum, OnDisconnectEnum, SortOrderEnum, DurabilityEnum, PruneStrategyEnum, CancelActionEnum } from '../src/schemas/enums.schema.js';
import { RunSchema } from '../src/schemas/run.schema.js';
import { CronSchema } from '../src/schemas/cron.schema.js';
import { ItemSchema, SearchItemSchema } from '../src/schemas/store.schema.js';
import { ThreadSchema, ThreadStateSchema, ThreadTaskSchema } from '../src/schemas/thread.schema.js';

interface TestAppConfig {
  port: number;
  host: string;
  authEnabled: boolean;
  apiKey: string;
}

// Collect all schemas that carry $id
const schemasWithId: any[] = [
  CheckpointSchema, ConfigSchema, InterruptSchema, CommandSchema,
  ErrorResponseSchema, GraphSchemaSchema, StreamPartSchema, MetadataSchema,
  ThreadStatusEnum, RunStatusEnum, MultitaskStrategyEnum, StreamModeEnum,
  IfExistsEnum, OnCompletionEnum, OnDisconnectEnum, SortOrderEnum,
  DurabilityEnum, PruneStrategyEnum, CancelActionEnum,
  RunSchema, CronSchema, ItemSchema, SearchItemSchema,
  ThreadSchema, ThreadStateSchema, ThreadTaskSchema,
];

// Strip $id from all shared schemas once at module load time.
function deepStripId(obj: any, visited = new Set()): void {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
  visited.add(obj);
  if (obj.$id) delete obj.$id;
  for (const key of Object.keys(obj)) {
    deepStripId(obj[key], visited);
  }
}

for (const schema of schemasWithId) {
  deepStripId(schema);
}

/**
 * Build a full Fastify app for testing (all modules registered).
 * Uses dynamic import of buildApp after schemas are stripped.
 */
export async function buildTestApp(config: TestAppConfig): Promise<FastifyInstance> {
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp(config);
  app.log.level = 'error';
  return app;
}

/**
 * Build a lightweight Fastify app with custom plugins.
 * Bypasses serialization compiler to avoid $id issues.
 * Used when you need to register specific route modules (e.g., for
 * testing runs with shared thread repositories).
 */
export async function buildModuleApp(
  config: TestAppConfig,
  registerPlugins: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.decorate('config', config as AppConfig);

  // Bypass response serialization to avoid any $id conflicts
  app.setSerializerCompiler(() => {
    return (data: any) => JSON.stringify(data);
  });

  await app.register(errorHandlerPlugin);
  await registerPlugins(app);
  await app.ready();
  return app;
}
