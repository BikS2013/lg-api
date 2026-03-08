import { loadConfig } from './config/env.config.js';
import { buildApp } from './app.js';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
