/**
 * Agent Registry
 *
 * Loads agent definitions from agent-registry.yaml and provides
 * lookup by graph_id. Each entry maps a graph_id to the agent
 * configuration which can be either a CLI command or an API endpoint.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentConfig, CliAgentConfig, ApiAgentConfig } from './types.js';

/**
 * Raw shape of a single agent entry in agent-registry.yaml.
 * Supports both CLI and API agent types.
 */
interface RawAgentEntry {
  type?: string;
  name?: string;
  // CLI fields
  command?: string;
  args?: string[];
  cwd?: string;
  // API fields
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  // Common fields
  timeout?: number;
  description?: string;
}

/**
 * Raw shape of the parsed YAML file.
 */
interface RawRegistryFile {
  agents: Record<string, RawAgentEntry>;
}

/**
 * Environment variable that overrides the default registry file path.
 */
const AGENT_REGISTRY_PATH_ENV = 'AGENT_REGISTRY_PATH';

/**
 * Default filename looked up at the project root.
 */
const DEFAULT_REGISTRY_FILENAME = 'agent-registry.yaml';

export class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();

  /**
   * Create an AgentRegistry and immediately load the configuration file.
   * Throws if the file cannot be found or parsed.
   */
  constructor() {
    this.load();
  }

  /**
   * Look up an agent configuration by its graph_id.
   * Returns null if no agent is registered for the given graph_id.
   */
  getAgentConfig(graphId: string): AgentConfig | null {
    return this.agents.get(graphId) ?? null;
  }

  /**
   * Return all registered graph_ids.
   */
  getRegisteredGraphIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Return a Map of all registered agents keyed by graph_id.
   */
  getRegisteredAgents(): Map<string, AgentConfig> {
    return new Map(this.agents);
  }

  /**
   * Load and parse the agent registry YAML file.
   *
   * Resolution order:
   * 1. AGENT_REGISTRY_PATH env var points to a specific file.
   * 2. Auto-detect agent-registry.yaml at the current working directory.
   *
   * Throws on missing file or invalid content (no fallbacks).
   */
  private load(): void {
    const configPath = this.resolveConfigPath();
    const rawYaml = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(rawYaml) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Agent registry file is empty or invalid: ${configPath}`);
    }

    const raw = parsed as RawRegistryFile;

    if (!raw.agents || typeof raw.agents !== 'object') {
      throw new Error(
        `Agent registry file is missing the required "agents" section: ${configPath}`,
      );
    }

    for (const [graphId, entry] of Object.entries(raw.agents)) {
      this.validateAndRegister(graphId, entry, configPath);
    }
  }

  /**
   * Resolve the path to the agent-registry.yaml file.
   * Throws if no file can be found.
   */
  private resolveConfigPath(): string {
    const explicitPath = process.env[AGENT_REGISTRY_PATH_ENV];

    if (explicitPath !== undefined && explicitPath !== '') {
      const resolved = resolve(explicitPath);
      if (!existsSync(resolved)) {
        throw new Error(
          `Agent registry file not found at ${AGENT_REGISTRY_PATH_ENV}: ${resolved}`,
        );
      }
      return resolved;
    }

    const defaultPath = resolve(process.cwd(), DEFAULT_REGISTRY_FILENAME);
    if (!existsSync(defaultPath)) {
      throw new Error(
        `Agent registry file not found. Provide ${AGENT_REGISTRY_PATH_ENV} env var or ` +
        `place ${DEFAULT_REGISTRY_FILENAME} at the project root (looked in: ${defaultPath}).`,
      );
    }

    return defaultPath;
  }

  /**
   * Validate a raw agent entry and register it.
   * Defaults type to 'cli' if not specified (backward compatibility).
   */
  private validateAndRegister(
    graphId: string,
    entry: RawAgentEntry,
    configPath: string,
  ): void {
    const agentType = entry.type ?? 'cli';

    if (agentType === 'cli') {
      this.validateAndRegisterCli(graphId, entry, configPath);
    } else if (agentType === 'api') {
      this.validateAndRegisterApi(graphId, entry, configPath);
    } else {
      throw new Error(
        `Agent "${graphId}" in ${configPath} has unsupported type: "${agentType}". ` +
        `Supported types: cli, api`,
      );
    }
  }

  /**
   * Validate and register a CLI agent entry.
   */
  private validateAndRegisterCli(
    graphId: string,
    entry: RawAgentEntry,
    configPath: string,
  ): void {
    if (!entry.command || typeof entry.command !== 'string') {
      throw new Error(
        `Agent "${graphId}" in ${configPath} is missing required field: command`,
      );
    }

    const config: CliAgentConfig = {
      type: 'cli',
      name: entry.name,
      command: entry.command,
      args: entry.args ?? [],
      cwd: entry.cwd ?? '.',
      timeout: entry.timeout ?? 60000,
      description: entry.description,
    };

    this.agents.set(graphId, config);
  }

  /**
   * Substitute ${ENV_VAR} patterns in header values with environment variable values.
   * Returns undefined if no headers are provided.
   */
  private substituteEnvVarsInHeaders(
    headers?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!headers) {
      return undefined;
    }

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      result[key] = value.replace(/\$\{(\w+)\}/g, (_match, envVar: string) => {
        const envValue = process.env[envVar];
        if (envValue === undefined) {
          throw new Error(
            `Environment variable "${envVar}" referenced in header "${key}" is not set`,
          );
        }
        return envValue;
      });
    }
    return result;
  }

  /**
   * Validate and register an API agent entry.
   */
  private validateAndRegisterApi(
    graphId: string,
    entry: RawAgentEntry,
    configPath: string,
  ): void {
    if (!entry.url || typeof entry.url !== 'string') {
      throw new Error(
        `Agent "${graphId}" in ${configPath} is missing required field: url`,
      );
    }

    const config: ApiAgentConfig = {
      type: 'api',
      name: entry.name,
      url: entry.url,
      method: entry.method ?? 'POST',
      headers: this.substituteEnvVarsInHeaders(entry.headers),
      timeout: entry.timeout ?? 60000,
      description: entry.description,
    };

    this.agents.set(graphId, config);
  }
}
