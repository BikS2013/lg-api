/**
 * IAgentConnector Interface
 *
 * Defines the contract that all agent connectors must implement.
 * Each connector type (CLI, API, etc.) provides its own implementation
 * of execute() and stream() methods.
 */

import type { AgentConfig, AgentRequest, AgentResponse, AgentWireEvent, StreamEvent } from '../types.js';

export interface IAgentConnector {
  /**
   * Execute an agent synchronously and return the full response.
   */
  execute(config: AgentConfig, request: AgentRequest): Promise<AgentResponse>;

  /**
   * Execute an agent and stream events as they become available.
   */
  stream(config: AgentConfig, request: AgentRequest): AsyncGenerator<StreamEvent>;

  /**
   * Incremental agent events (progress / token / replace) ending in exactly
   * one `final` carrying the AgentResponse. Used by `/runs/stream` only.
   * Optional — connectors without it are adapted by AgentExecutor.streamAgent
   * (execute() then a single `final`).
   */
  streamAgent?(config: AgentConfig, request: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentWireEvent>;
}
