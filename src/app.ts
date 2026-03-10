import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from './config/env.config.js';
import corsPlugin from './plugins/cors.plugin.js';
import swaggerPlugin from './plugins/swagger.plugin.js';
import authPlugin from './plugins/auth.plugin.js';
import errorHandlerPlugin from './plugins/error-handler.plugin.js';
import assistantsRoutes from './modules/assistants/assistants.routes.js';
import threadsRoutes from './modules/threads/threads.routes.js';
import runsRoutes from './modules/runs/runs.routes.js';
import cronsRoutes from './modules/crons/crons.routes.js';
import storeRoutes from './modules/store/store.routes.js';
import systemRoutes from './modules/system/system.routes.js';
import { initializeStorage, closeStorage, getStorageProvider } from './repositories/registry.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { autoRegisterAssistants } from './agents/auto-register.js';

// Extend Fastify instance with config
declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Decorate with config so plugins can access it
  app.decorate('config', config);

  // Initialize the storage provider before registering routes.
  // This ensures the storage layer is ready when route modules access it.
  await initializeStorage();

  // Auto-register assistants for all agents defined in agent-registry.yaml.
  // This ensures every registered agent has a corresponding assistant record.
  try {
    const agentRegistry = new AgentRegistry();
    await autoRegisterAssistants(agentRegistry, getStorageProvider().assistants);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[app] Agent auto-registration skipped: ${message}`);
  }

  // Register a shutdown hook to close the storage provider gracefully.
  app.addHook('onClose', async () => {
    await closeStorage();
  });

  // Register plugins
  await app.register(corsPlugin);
  await app.register(swaggerPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  // Register route modules
  await app.register(assistantsRoutes);
  await app.register(threadsRoutes);
  await app.register(runsRoutes);
  await app.register(cronsRoutes);
  await app.register(storeRoutes);
  await app.register(systemRoutes);

  return app;
}
