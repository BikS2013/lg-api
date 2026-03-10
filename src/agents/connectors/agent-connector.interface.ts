/**
 * IAgentConnector Interface
 *
 * Defines the contract that all agent connectors must implement.
 * Each connector type (CLI, API, etc.) provides its own implementation
 * of execute() and stream() methods.
 */

import type { AgentConfig, AgentRequest, AgentResponse, StreamEvent } from '../types.js';

export interface IAgentConnector {
  /**
   * Execute an agent synchronously and return the full response.
   */
  execute(config: AgentConfig, request: AgentRequest): Promise<AgentResponse>;

  /**
   * Execute an agent and stream events as they become available.
   */
  stream(config: AgentConfig, request: AgentRequest): AsyncGenerator<StreamEvent>;
}
