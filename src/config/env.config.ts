export interface AppConfig {
  port: number;
  host: string;
  authEnabled: boolean;
  apiKey: string;
  storageConfigPath?: string;
  bodyLimit: number;
}

/**
 * Default maximum request body size: 8 MiB (Fastify's own default is 1 MiB).
 * Optional with a documented default (a deliberate exception to the
 * "no fallback values" rule — see Issues - Pending Items.md,
 * LG-BODY-LIMIT-DEFAULT): making it required would force every existing
 * deployment to change its environment.
 */
export const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;

/**
 * LG_API_BODY_LIMIT — integer > 0, in bytes (default 8 MiB). An invalid value
 * is never silently replaced: it throws at server start.
 */
export function loadBodyLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env['LG_API_BODY_LIMIT'];
  if (raw === undefined || raw === '') return DEFAULT_BODY_LIMIT;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Invalid value for LG_API_BODY_LIMIT: "${raw}". Must be an integer > 0 (bytes).`
    );
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${name}. Please set it before starting the server.`
    );
  }
  return value;
}

export function loadConfig(): AppConfig {
  const portStr = requireEnv('LG_API_PORT');
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid value for LG_API_PORT: "${portStr}". Must be a number between 1 and 65535.`
    );
  }

  const host = requireEnv('LG_API_HOST');

  const authEnabledStr = requireEnv('LG_API_AUTH_ENABLED');
  if (authEnabledStr !== 'true' && authEnabledStr !== 'false') {
    throw new Error(
      `Invalid value for LG_API_AUTH_ENABLED: "${authEnabledStr}". Must be "true" or "false".`
    );
  }
  const authEnabled = authEnabledStr === 'true';

  let apiKey = '';
  if (authEnabled) {
    apiKey = requireEnv('LG_API_KEY');
  }

  // STORAGE_CONFIG_PATH is optional -- when not set, the storage layer
  // auto-detects storage-config.yaml or defaults to in-memory.
  // See "Issues - Pending Items.md" P9 for the documented exception.
  const storageConfigPath = process.env['STORAGE_CONFIG_PATH'] || undefined;

  const bodyLimit = loadBodyLimit();

  return {
    port,
    host,
    authEnabled,
    apiKey,
    storageConfigPath,
    bodyLimit,
  };
}
