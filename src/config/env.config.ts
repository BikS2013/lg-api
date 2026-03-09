export interface AppConfig {
  port: number;
  host: string;
  authEnabled: boolean;
  apiKey: string;
  storageConfigPath?: string;
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

  return {
    port,
    host,
    authEnabled,
    apiKey,
    storageConfigPath,
  };
}
