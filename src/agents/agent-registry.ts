/**
 * Agent Registry
 *
 * Loads agent definitions from agent-registry.yaml and provides
 * lookup by graph_id. Each entry maps a graph_id to the CLI command,
 * arguments, working directory, and timeout for the agent process.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentConfig } from './types.js';

/**
 * Raw shape of a single agent entry in agent-registry.yaml.
 */
interface RawAgentEntry {
  command: string;
  args?: string[];
  cwd?: string;
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
   */
  private validateAndRegister(
    graphId: string,
    entry: RawAgentEntry,
    configPath: string,
  ): void {
    if (!entry.command || typeof entry.command !== 'string') {
      throw new Error(
        `Agent "${graphId}" in ${configPath} is missing required field: command`,
      );
    }

    const config: AgentConfig = {
      command: entry.command,
      args: entry.args ?? [],
      cwd: entry.cwd ?? '.',
      timeout: entry.timeout ?? 60000,
      description: entry.description,
    };

    this.agents.set(graphId, config);
  }
}
