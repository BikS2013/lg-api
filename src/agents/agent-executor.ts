/**
 * Agent Executor
 *
 * Central orchestrator for agent execution. Takes a graph_id and an
 * AgentRequest, looks up the agent config from the registry, gets the
 * appropriate connector from the factory, and delegates to execute()
 * or stream().
 */

import { AgentRegistry } from './agent-registry.js';
import { ConnectorFactory } from './connectors/connector-factory.js';
import type { AgentRequest, AgentResponse, StreamEvent } from './types.js';
import { ApiError } from '../errors/api-error.js';

export class AgentExecutor {
  private connectorFactory: ConnectorFactory;

  constructor(private registry: AgentRegistry) {
    this.connectorFactory = new ConnectorFactory();
  }

  /**
   * Execute an agent synchronously and return the full response.
   *
   * @param graphId - The graph_id that maps to an agent in the registry
   * @param request - The AgentRequest to send to the agent
   * @returns The AgentResponse from the agent
   * @throws ApiError 404 if no agent is registered for the graph_id
   */
  async execute(graphId: string, request: AgentRequest): Promise<AgentResponse> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(404, `No agent registered for graph_id: ${graphId}`);
    }
    const connector = this.connectorFactory.getConnector(config);
    return connector.execute(config, request);
  }

  /**
   * Execute an agent and stream events as they become available.
   *
   * @param graphId - The graph_id that maps to an agent in the registry
   * @param request - The AgentRequest to send to the agent
   * @yields StreamEvent objects as the agent produces them
   * @throws ApiError 404 if no agent is registered for the graph_id
   */
  async *stream(graphId: string, request: AgentRequest): AsyncGenerator<StreamEvent> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(404, `No agent registered for graph_id: ${graphId}`);
    }
    const connector = this.connectorFactory.getConnector(config);
    yield* connector.stream(config, request);
  }
}
