/**
 * YAML Configuration Loader for Storage
 *
 * Loads storage-config.yaml, resolves the selected profile, substitutes
 * ${ENV_VAR} references, and validates the configuration.
 *
 * The YAML file supports multiple named profiles per provider type:
 *
 *   provider: azure-blob
 *   profile: production
 *   azureBlob:
 *     production:
 *       accountName: ...
 *     staging:
 *       accountName: ...
 *
 * The `profile` field selects which named entry to use. If omitted and
 * the provider section has exactly one entry, that entry is used automatically.
 *
 * Config resolution strategy:
 * 1. If STORAGE_CONFIG_PATH env var is "memory", return in-memory config.
 * 2. If STORAGE_CONFIG_PATH env var is set to a path, load from that path.
 * 3. If not set, check if storage-config.yaml exists at project root.
 * 4. If neither exists, return a memory-provider config.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { StorageConfig, StorageProviderType } from './config.js';

const VALID_PROVIDERS: StorageProviderType[] = ['memory', 'sqlite', 'sqlserver', 'azure-blob'];

/**
 * Provider type -> YAML section key mapping.
 */
const PROVIDER_SECTION_KEY: Record<string, string> = {
  'sqlite': 'sqlite',
  'sqlserver': 'sqlserver',
  'azure-blob': 'azureBlob',
};

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
 * Resolve the selected profile from a provider section (map of named profiles).
 *
 * If `profile` is specified, look up that name.
 * If `profile` is not specified and the section has exactly one entry, use it.
 * Otherwise throw.
 */
function resolveProfile(
  sectionKey: string,
  section: Record<string, unknown>,
  profileName: string | undefined,
): { name: string; config: Record<string, unknown> } {
  const entries = Object.entries(section);

  if (entries.length === 0) {
    throw new Error(
      `Storage config section "${sectionKey}" is empty. At least one named profile is required.`,
    );
  }

  if (profileName) {
    const entry = section[profileName];
    if (!entry || typeof entry !== 'object') {
      const available = entries.map(([k]) => k).join(', ');
      throw new Error(
        `Storage config profile "${profileName}" not found in "${sectionKey}". Available profiles: ${available}`,
      );
    }
    return { name: profileName, config: entry as Record<string, unknown> };
  }

  // No profile specified
  if (entries.length === 1) {
    const [name, config] = entries[0];
    return { name, config: config as Record<string, unknown> };
  }

  const available = entries.map(([k]) => k).join(', ');
  throw new Error(
    `Storage config section "${sectionKey}" has multiple profiles (${available}) but no "profile" field is specified. ` +
    `Set "profile" to one of: ${available}`,
  );
}

/**
 * Validate a resolved SQLite config.
 */
function validateSqlite(profile: Record<string, unknown>, profileName: string): StorageConfig['sqlite'] {
  if (typeof profile['path'] !== 'string' || profile['path'] === '') {
    throw new Error(
      `Storage config for sqlite profile "${profileName}" is missing required field: path`,
    );
  }
  return {
    path: profile['path'] as string,
    walMode: profile['walMode'] !== undefined ? Boolean(profile['walMode']) : undefined,
  };
}

/**
 * Validate a resolved SQL Server config.
 */
function validateSqlServer(profile: Record<string, unknown>, profileName: string): StorageConfig['sqlserver'] {
  const requiredFields = ['server', 'database', 'user', 'password'] as const;
  for (const field of requiredFields) {
    if (typeof profile[field] !== 'string' || profile[field] === '') {
      throw new Error(
        `Storage config for sqlserver profile "${profileName}" is missing required field: ${field}`,
      );
    }
  }
  return {
    server: profile['server'] as string,
    database: profile['database'] as string,
    user: profile['user'] as string,
    password: profile['password'] as string,
    port: profile['port'] !== undefined ? Number(profile['port']) : undefined,
    encrypt: profile['encrypt'] !== undefined ? Boolean(profile['encrypt']) : undefined,
    trustServerCertificate:
      profile['trustServerCertificate'] !== undefined
        ? Boolean(profile['trustServerCertificate'])
        : undefined,
  };
}

/**
 * Validate a resolved Azure Blob config.
 */
function validateAzureBlob(profile: Record<string, unknown>, profileName: string): StorageConfig['azureBlob'] {
  const useManagedIdentity = Boolean(profile['useManagedIdentity']);
  const hasSasToken = typeof profile['sasToken'] === 'string' && profile['sasToken'] !== '';
  const hasConnectionString = typeof profile['connectionString'] === 'string' && profile['connectionString'] !== '';

  if (useManagedIdentity) {
    if (typeof profile['accountName'] !== 'string' || profile['accountName'] === '') {
      throw new Error(
        `Storage config for azure-blob profile "${profileName}" is missing required field: accountName (required when useManagedIdentity is true)`,
      );
    }
  } else if (hasSasToken) {
    if (typeof profile['accountName'] !== 'string' || profile['accountName'] === '') {
      throw new Error(
        `Storage config for azure-blob profile "${profileName}" is missing required field: accountName (required when using sasToken)`,
      );
    }
  } else if (!hasConnectionString) {
    throw new Error(
      `Storage config for azure-blob profile "${profileName}" requires one of: connectionString, sasToken (with accountName), or useManagedIdentity (with accountName)`,
    );
  }

  return {
    connectionString: profile['connectionString'] as string | undefined,
    accountName: profile['accountName'] as string | undefined,
    sasToken: profile['sasToken'] as string | undefined,
    containerPrefix: profile['containerPrefix'] as string | undefined,
    useManagedIdentity,
  };
}

/**
 * Parse the raw YAML, resolve the profile, substitute env vars, and validate.
 */
function parseAndValidate(raw: Record<string, unknown>): StorageConfig {
  const provider = raw['provider'] as string | undefined;
  if (!provider) {
    throw new Error('Storage config is missing required field: provider');
  }
  if (!VALID_PROVIDERS.includes(provider as StorageProviderType)) {
    throw new Error(
      `Invalid storage provider: "${provider}". Valid options: ${VALID_PROVIDERS.join(', ')}`,
    );
  }

  if (provider === 'memory') {
    return { provider: 'memory' };
  }

  const profileName = raw['profile'] as string | undefined;
  const sectionKey = PROVIDER_SECTION_KEY[provider];
  const section = raw[sectionKey] as Record<string, unknown> | undefined;

  if (!section) {
    throw new Error(
      `Storage config for provider "${provider}" is missing required section: ${sectionKey}`,
    );
  }

  // Resolve the named profile
  const resolved = resolveProfile(sectionKey, section, profileName);

  // Substitute env vars only in the selected profile
  const substituted = substituteEnvVarsDeep(resolved.config) as Record<string, unknown>;

  const config: StorageConfig = {
    provider: provider as StorageProviderType,
    profile: resolved.name,
  };

  if (provider === 'sqlite') {
    config.sqlite = validateSqlite(substituted, resolved.name);
  } else if (provider === 'sqlserver') {
    config.sqlserver = validateSqlServer(substituted, resolved.name);
  } else if (provider === 'azure-blob') {
    config.azureBlob = validateAzureBlob(substituted, resolved.name);
  }

  return config;
}

/**
 * Load and parse the storage configuration.
 *
 * Resolution order:
 * 1. STORAGE_CONFIG_PATH=memory -> in-memory provider
 * 2. STORAGE_CONFIG_PATH=<path> -> load from that path
 * 3. Auto-detect storage-config.yaml at project root
 * 4. No config file -> in-memory provider
 */
export function loadStorageConfig(): StorageConfig {
  const explicitPath = process.env['STORAGE_CONFIG_PATH'];

  // Special value: "memory" forces in-memory provider, skipping YAML auto-detection
  if (explicitPath === 'memory') {
    return { provider: 'memory' };
  }

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

  return parseAndValidate(parsed as Record<string, unknown>);
}
