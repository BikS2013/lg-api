import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type {
  LlmConfig,
  LlmProvider,
  AzureOpenAIConfig,
  OpenAIConfig,
  AnthropicConfig,
  GoogleConfig,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Substitute ${ENV_VAR} references with actual environment variable values.
 * Throws if a referenced environment variable is not set.
 */
function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)}/g, (_match, varName: string) => {
      const envValue = process.env[varName];
      if (envValue === undefined || envValue === '') {
        throw new Error(
          `Environment variable '${varName}' is not set. Required by llm-config.yaml.`
        );
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }
  return value;
}

const VALID_PROVIDERS: LlmProvider[] = ['azure-openai', 'openai', 'anthropic', 'google'];

function validateAzureOpenAIConfig(config: Record<string, unknown>): AzureOpenAIConfig {
  const required = ['apiKey', 'endpoint', 'deploymentName', 'apiVersion', 'temperature', 'maxTokens'] as const;
  for (const field of required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      throw new Error(`Missing required field '${field}' in azure-openai provider config.`);
    }
  }
  return {
    apiKey: config.apiKey as string,
    endpoint: config.endpoint as string,
    deploymentName: config.deploymentName as string,
    apiVersion: config.apiVersion as string,
    temperature: config.temperature as number,
    maxTokens: config.maxTokens as number,
  };
}

function validateOpenAIConfig(config: Record<string, unknown>): OpenAIConfig {
  const required = ['apiKey', 'model', 'temperature', 'maxTokens'] as const;
  for (const field of required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      throw new Error(`Missing required field '${field}' in openai provider config.`);
    }
  }
  return {
    apiKey: config.apiKey as string,
    model: config.model as string,
    temperature: config.temperature as number,
    maxTokens: config.maxTokens as number,
  };
}

function validateAnthropicConfig(config: Record<string, unknown>): AnthropicConfig {
  const required = ['apiKey', 'model', 'temperature', 'maxTokens'] as const;
  for (const field of required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      throw new Error(`Missing required field '${field}' in anthropic provider config.`);
    }
  }
  return {
    apiKey: config.apiKey as string,
    model: config.model as string,
    temperature: config.temperature as number,
    maxTokens: config.maxTokens as number,
  };
}

function validateGoogleConfig(config: Record<string, unknown>): GoogleConfig {
  const required = ['apiKey', 'model', 'temperature', 'maxTokens'] as const;
  for (const field of required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      throw new Error(`Missing required field '${field}' in google provider config.`);
    }
  }
  return {
    apiKey: config.apiKey as string,
    model: config.model as string,
    temperature: config.temperature as number,
    maxTokens: config.maxTokens as number,
  };
}

/**
 * Load and validate the LLM configuration from llm-config.yaml.
 */
export function loadLlmConfig(configPath?: string): LlmConfig {
  const resolvedPath = configPath ?? resolve(__dirname, '..', 'llm-config.yaml');
  let rawContent: string;

  try {
    rawContent = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read LLM config file at '${resolvedPath}': ${(err as Error).message}`);
  }

  const parsed = parseYaml(rawContent) as Record<string, unknown>;

  // Validate provider
  const provider = parsed.provider as string | undefined;
  if (!provider) {
    throw new Error("Missing required field 'provider' in llm-config.yaml.");
  }
  if (!VALID_PROVIDERS.includes(provider as LlmProvider)) {
    throw new Error(
      `Invalid provider '${provider}'. Must be one of: ${VALID_PROVIDERS.join(', ')}.`
    );
  }

  // Resolve profile
  const profile = (parsed.profile as string | undefined) ?? 'default';

  // Get provider section
  const providerSection = parsed[provider] as Record<string, unknown> | undefined;
  if (!providerSection) {
    throw new Error(`Missing provider section '${provider}' in llm-config.yaml.`);
  }

  const profileConfig = providerSection[profile] as Record<string, unknown> | undefined;
  if (!profileConfig) {
    throw new Error(
      `Missing profile '${profile}' under provider '${provider}' in llm-config.yaml.`
    );
  }

  // Substitute env vars in the active profile only
  const resolvedConfig = substituteEnvVars(profileConfig) as Record<string, unknown>;

  // Validate per provider
  let providerConfig: AzureOpenAIConfig | OpenAIConfig | AnthropicConfig | GoogleConfig;

  switch (provider as LlmProvider) {
    case 'azure-openai':
      providerConfig = validateAzureOpenAIConfig(resolvedConfig);
      break;
    case 'openai':
      providerConfig = validateOpenAIConfig(resolvedConfig);
      break;
    case 'anthropic':
      providerConfig = validateAnthropicConfig(resolvedConfig);
      break;
    case 'google':
      providerConfig = validateGoogleConfig(resolvedConfig);
      break;
  }

  return {
    provider: provider as LlmProvider,
    profile,
    providerConfig,
  };
}
