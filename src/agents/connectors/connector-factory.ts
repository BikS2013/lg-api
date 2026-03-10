/**
 * Connector Factory
 *
 * Returns the appropriate IAgentConnector for a given AgentConfig.
 *
 * Uses a switch on config.type with TypeScript exhaustiveness checking.
 * Adding a new agent type requires:
 * 1. New interface in types.ts extending BaseAgentConfig
 * 2. New connector class implementing IAgentConnector
 * 3. New case in this factory's switch statement
 */

import type { AgentConfig } from '../types.js';
import type { IAgentConnector } from './agent-connector.interface.js';
import { CliAgentConnector } from '../cli-connector.js';
import { ApiAgentConnector } from './api-connector.js';

export class ConnectorFactory {
  private cliConnector: CliAgentConnector;
  private apiConnector: ApiAgentConnector;

  constructor() {
    this.cliConnector = new CliAgentConnector();
    this.apiConnector = new ApiAgentConnector();
  }

  /**
   * Select the appropriate connector based on the agent config type.
   *
   * @param config - The agent configuration with type discriminator
   * @returns The matching IAgentConnector implementation
   * @throws Error if config.type is unknown (exhaustiveness check)
   */
  getConnector(config: AgentConfig): IAgentConnector {
    switch (config.type) {
      case 'cli':
        return this.cliConnector;
      case 'api':
        return this.apiConnector;
      default: {
        // TypeScript exhaustiveness check: if a new type is added to the
        // AgentConfig union but not handled here, this line produces a
        // compile-time error.
        const _exhaustive: never = config;
        throw new Error(`Unknown agent type: ${(config as { type: string }).type}`);
      }
    }
  }
}
