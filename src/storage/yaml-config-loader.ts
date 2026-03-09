/**
 * YAML Configuration Loader for Storage
 *
 * Loads storage-config.yaml, substitutes ${ENV_VAR} references with process.env values,
 * and validates the configuration. Throws on missing required fields (no fallbacks).
 *
 * Config resolution strategy:
 * 1. If STORAGE_CONFIG_PATH env var is set, load from that path (throw if file missing).
 * 2. If not set, check if storage-config.yaml exists at project root.
 * 3. If the file exists, load it.
 * 4. If neither exists, return a memory-provider config.
 *    (This is file-existence detection, not a config fallback -- see Issues - Pending Items P9.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { StorageConfig, StorageProviderType } from './config.js';

const VALID_PROVIDERS: StorageProviderType[] = ['memory', 'sqlite', 'sqlserver', 'azure-blob'];

/**
 * Substitute ${ENV_VAR} placeholders in a string with process.env values.
 * Throws if a referenced env var is not set.
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined || envValue === '') {
      throw new Error(
        `Missing required environment variable: ${varName} (referenced in storage configuration).`,
      );
    }
    return envValue;
  });
}

/**
 * Recursively walk an object and substitute ${ENV_VAR} in all string values.
 */
function substituteEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteEnvVarsDeep(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Validate the parsed config: ensure required fields are present per provider type.
 * Throws on any missing required field.
 */
function validateConfig(raw: Record<string, unknown>): StorageConfig {
  const provider = raw['provider'] as string | undefined;
  if (!provider) {
    throw new Error('Storage config is missing required field: provider');
  }
  if (!VALID_PROVIDERS.includes(provider as StorageProviderType)) {
    throw new Error(
      `Invalid storage provider: "${provider}". Valid options: ${VALID_PROVIDERS.join(', ')}`,
    );
  }

  const config: StorageConfig = {
    provider: provider as StorageProviderType,
  };

  if (provider === 'sqlite') {
    const sqlite = raw['sqlite'] as Record<string, unknown> | undefined;
    if (!sqlite) {
      throw new Error('Storage config for provider "sqlite" is missing required section: sqlite');
    }
    if (typeof sqlite['path'] !== 'string' || sqlite['path'] === '') {
      throw new Error('Storage config for provider "sqlite" is missing required field: sqlite.path');
    }
    config.sqlite = {
      path: sqlite['path'] as string,
      walMode: sqlite['walMode'] !== undefined ? Boolean(sqlite['walMode']) : undefined,
    };
  }

  if (provider === 'sqlserver') {
    const sqlserver = raw['sqlserver'] as Record<string, unknown> | undefined;
    if (!sqlserver) {
      throw new Error(
        'Storage config for provider "sqlserver" is missing required section: sqlserver',
      );
    }
    const requiredFields = ['server', 'database', 'user', 'password'] as const;
    for (const field of requiredFields) {
      if (typeof sqlserver[field] !== 'string' || sqlserver[field] === '') {
        throw new Error(
          `Storage config for provider "sqlserver" is missing required field: sqlserver.${field}`,
        );
      }
    }
    config.sqlserver = {
      server: sqlserver['server'] as string,
      database: sqlserver['database'] as string,
      user: sqlserver['user'] as string,
      password: sqlserver['password'] as string,
      port: sqlserver['port'] !== undefined ? Number(sqlserver['port']) : undefined,
      encrypt: sqlserver['encrypt'] !== undefined ? Boolean(sqlserver['encrypt']) : undefined,
      trustServerCertificate:
        sqlserver['trustServerCertificate'] !== undefined
          ? Boolean(sqlserver['trustServerCertificate'])
          : undefined,
    };
  }

  if (provider === 'azure-blob') {
    const azureBlob = raw['azureBlob'] as Record<string, unknown> | undefined;
    if (!azureBlob) {
      throw new Error(
        'Storage config for provider "azure-blob" is missing required section: azureBlob',
      );
    }
    const useManagedIdentity = Boolean(azureBlob['useManagedIdentity']);
    if (!useManagedIdentity) {
      // When not using managed identity, connectionString is required
      if (typeof azureBlob['connectionString'] !== 'string' || azureBlob['connectionString'] === '') {
        throw new Error(
          'Storage config for provider "azure-blob" is missing required field: azureBlob.connectionString (required when useManagedIdentity is false)',
        );
      }
    } else {
      // When using managed identity, accountName is required
      if (typeof azureBlob['accountName'] !== 'string' || azureBlob['accountName'] === '') {
        throw new Error(
          'Storage config for provider "azure-blob" is missing required field: azureBlob.accountName (required when useManagedIdentity is true)',
        );
      }
    }
    config.azureBlob = {
      connectionString: azureBlob['connectionString'] as string | undefined,
      accountName: azureBlob['accountName'] as string | undefined,
      containerPrefix: azureBlob['containerPrefix'] as string | undefined,
      useManagedIdentity,
    };
  }

  return config;
}

/**
 * Load and parse the storage configuration.
 *
 * Resolution order:
 * 1. STORAGE_CONFIG_PATH env var (explicit path, must exist)
 * 2. storage-config.yaml at project root (auto-detection)
 * 3. In-memory provider (no config file needed)
 */
export function loadStorageConfig(): StorageConfig {
  const explicitPath = process.env['STORAGE_CONFIG_PATH'];

  let configPath: string | null = null;

  if (explicitPath !== undefined && explicitPath !== '') {
    configPath = resolve(explicitPath);
    if (!existsSync(configPath)) {
      throw new Error(
        `Storage config file not found at STORAGE_CONFIG_PATH: ${configPath}`,
      );
    }
  } else {
    // Auto-detect storage-config.yaml at project root
    const defaultPath = resolve(process.cwd(), 'storage-config.yaml');
    if (existsSync(defaultPath)) {
      configPath = defaultPath;
    }
  }

  // No config file found -- use in-memory provider
  if (configPath === null) {
    return { provider: 'memory' };
  }

  const rawYaml = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(rawYaml);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Storage config file is empty or invalid: ${configPath}`);
  }

  // Only substitute env vars for the active provider section to avoid
  // errors from env vars that belong to unused providers.
  const provider = (parsed as Record<string, unknown>)['provider'] as string | undefined;
  const raw = parsed as Record<string, unknown>;

  // Always substitute provider field
  const result: Record<string, unknown> = { provider: raw['provider'] };

  if (provider === 'sqlite' && raw['sqlite']) {
    result['sqlite'] = substituteEnvVarsDeep(raw['sqlite']);
  } else if (provider === 'sqlserver' && raw['sqlserver']) {
    result['sqlserver'] = substituteEnvVarsDeep(raw['sqlserver']);
  } else if (provider === 'azure-blob' && raw['azureBlob']) {
    result['azureBlob'] = substituteEnvVarsDeep(raw['azureBlob']);
  }

  return validateConfig(result);
}
