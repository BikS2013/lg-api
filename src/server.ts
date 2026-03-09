import { loadConfig } from './config/env.config.js';
import { buildApp } from './app.js';
import { closeStorage } from './repositories/registry.js';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  // Graceful shutdown: close the storage provider on SIGTERM/SIGINT.
  // Fastify's app.close() triggers the onClose hook (which also calls closeStorage),
  // but we register signal handlers as a safety net for abrupt termination.
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
    } catch (err) {
      app.log.error(err, 'Error during Fastify close');
    }
    try {
      await closeStorage();
    } catch (err) {
      app.log.error(err, 'Error closing storage');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
