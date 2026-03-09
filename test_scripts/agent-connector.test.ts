/**
 * Integration test for the CLI Agent Connector.
 *
 * Tests that require LLM API keys are skipped when env vars are not set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import { CliAgentConnector } from '../src/agents/cli-connector.js';
import { RequestComposer } from '../src/agents/request-composer.js';
import type { AgentRequest, AgentStreamEvent } from '../src/agents/types.js';

const hasAzureKeys = !!(
  process.env['AZURE_OPENAI_API_KEY'] &&
  process.env['AZURE_OPENAI_ENDPOINT'] &&
  process.env['AZURE_OPENAI_DEPLOYMENT_NAME']
);

describe('Agent Registry', () => {
  it('should load the agent registry and find the passthrough agent', () => {
    const registry = new AgentRegistry();
    const config = registry.getAgentConfig('passthrough');
    expect(config).not.toBeNull();
    expect(config!.command).toBe('npx');
  });

  it('should return null for unknown graph_id', () => {
    const registry = new AgentRegistry();
    const config = registry.getAgentConfig('nonexistent-agent');
    expect(config).toBeNull();
  });
});

describe('Request Composer', () => {
  it('should compose a request from input and thread state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'Previous message' },
            { role: 'assistant', content: 'Previous response' },
          ],
        },
      },
    });

    expect(request.thread_id).toBe('thread-1');
    expect(request.run_id).toBe('run-1');
    expect(request.messages.length).toBe(3);
    const contents = request.messages.map(m => m.content);
    expect(contents).toContain('Previous message');
    expect(contents).toContain('Previous response');
    expect(contents).toContain('Hello');
  });

  it('should handle input with documents', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'About the doc?' }],
        documents: [
          { id: 'doc-1', title: 'Test', content: 'Test content' },
        ],
      },
    });

    expect(request.documents).toBeDefined();
    expect(request.documents!.length).toBe(1);
    expect(request.documents![0].id).toBe('doc-1');
  });
});

describe('CLI Agent Connector', () => {
  let registry: AgentRegistry;
  let connector: CliAgentConnector;

  beforeAll(() => {
    registry = new AgentRegistry();
    connector = new CliAgentConnector(registry);
  });

  it.skipIf(!hasAzureKeys)(
    'should execute the passthrough agent and get a response',
    async () => {
      const request: AgentRequest = {
        thread_id: 'test-thread',
        run_id: 'test-run',
        assistant_id: 'test-asst',
        messages: [
          { role: 'user', content: 'What is 1+1? Reply with just the number.' },
        ],
      };

      const response = await connector.executeAgent('passthrough', request);

      expect(response).toBeDefined();
      expect(response.thread_id).toBe('test-thread');
      expect(response.run_id).toBe('test-run');
      expect(response.messages).toBeDefined();
      expect(response.messages.length).toBeGreaterThan(0);
      expect(response.messages[0].role).toBe('assistant');
      expect(response.messages[0].content).toBeTruthy();
    },
    30000,
  );

  it.skipIf(!hasAzureKeys)(
    'should stream events from the passthrough agent',
    async () => {
      const request: AgentRequest = {
        thread_id: 'test-thread',
        run_id: 'test-run',
        assistant_id: 'test-asst',
        messages: [
          { role: 'user', content: 'Say hello in one word.' },
        ],
      };

      const events: AgentStreamEvent[] = [];
      for await (const event of connector.streamAgent('passthrough', request)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const eventTypes = events.map(e => e.event);
      expect(eventTypes).toContain('metadata');
      expect(eventTypes).toContain('end');
    },
    30000,
  );

  it('should throw for unknown agent', async () => {
    const request: AgentRequest = {
      thread_id: 'test',
      run_id: 'test',
      assistant_id: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(
      connector.executeAgent('nonexistent-agent', request),
    ).rejects.toThrow();
  });
});
