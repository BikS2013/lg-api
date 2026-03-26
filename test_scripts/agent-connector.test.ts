/**
 * Integration test for the CLI Agent Connector.
 *
 * Tests that require LLM API keys are skipped when env vars are not set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import { CliAgentConnector } from '../src/agents/cli-connector.js';
import { RequestComposer } from '../src/agents/request-composer.js';
import type { AgentRequest, StreamEvent } from '../src/agents/types.js';

const hasAzureKeys = !!(
    process.env['AZURE_OPENAI_API_KEY'] &&
    process.env['AZURE_OPENAI_ENDPOINT'] &&
    process.env['AZURE_OPENAI_DEPLOYMENT']
);

describe('Agent Registry', () => {
  it('should load the agent registry and find the passthrough agent', () => {
    const registry = new AgentRegistry();
    const config = registry.getAgentConfig('passthrough');
    expect(config).not.toBeNull();
    expect(config!.type).toBe('cli');
    if (config!.type === 'cli') {
      expect(config!.command).toBe('npx');
    }
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

describe('Request Composer - State Round-Trip', () => {
  it('should recover agent state stored inside threadState.values.state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      assistantId: 'asst-1',
      input: {
        messages: [{ role: 'user', content: 'Next turn' }],
      },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'I want a mortgage' },
            { role: 'assistant', content: 'What is your tax ID?' },
          ],
          state: {
            language: 'en',
            tax_id: '123456789',
            memory: { collected: { name: 'John' } },
          },
        },
        checkpoint: { thread_id: 'thread-1', checkpoint_ns: '', checkpoint_id: 'cp-1' },
      },
    });

    expect(request.state).toBeDefined();
    expect(request.state).toEqual({
      language: 'en',
      tax_id: '123456789',
      memory: { collected: { name: 'John' } },
    });
  });

  it('should NOT include messages in recovered state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Previous' }],
          state: { workflow_step: 3 },
        },
      },
    });

    expect(request.state).toEqual({ workflow_step: 3 });
    expect(request.state).not.toHaveProperty('messages');
  });

  it('should return undefined state when values contains only messages', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      },
    });

    expect(request.state).toBeUndefined();
  });

  it('should prefer explicit input state over stored thread state', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: {
        messages: [{ role: 'user', content: 'Hi' }],
        state: { override: true },
      },
      threadState: {
        values: {
          messages: [],
          language: 'en',
        },
      },
    });

    expect(request.state).toEqual({ override: true });
  });

  it('should handle threadState with no values key', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {},
    });

    expect(request.state).toBeUndefined();
  });

  it('should handle multi-turn state persistence', async () => {
    const composer = new RequestComposer();

    // Turn 2: threadState.values.state has agent state from turn 1
    const turn2 = await composer.composeRequest({
      threadId: 't1',
      runId: 'r2',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'My tax ID is 123' }] },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'Start mortgage' },
            { role: 'assistant', content: 'What is your tax ID?' },
          ],
          state: {
            workflow_step: 1,
            collected_fields: ['language'],
          },
        },
      },
    });

    expect(turn2.state).toEqual({
      workflow_step: 1,
      collected_fields: ['language'],
    });

    // Turn 3: threadState.values.state has updated state from turn 2
    const turn3 = await composer.composeRequest({
      threadId: 't1',
      runId: 'r3',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Yes, confirm' }] },
      threadState: {
        values: {
          messages: [
            { role: 'user', content: 'Start mortgage' },
            { role: 'assistant', content: 'What is your tax ID?' },
            { role: 'user', content: 'My tax ID is 123' },
            { role: 'assistant', content: 'Confirm?' },
          ],
          state: {
            workflow_step: 2,
            collected_fields: ['language', 'tax_id'],
            tax_id: '123',
          },
        },
      },
    });

    expect(turn3.state).toEqual({
      workflow_step: 2,
      collected_fields: ['language', 'tax_id'],
      tax_id: '123',
    });
  });
});

/**
 * These tests verify the state boundary: agent state lives at values.state,
 * not spread flat into values. This ensures framework fields in values
 * (like messages) never leak into agent state.
 */
describe('Request Composer - State Boundary Assumptions', () => {
  it('should only read state from values.state, ignoring loose fields in values', async () => {
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Previous' }],
          workflow_step: 2,    // loose field — NOT agent state
          language: 'en',      // loose field — NOT agent state
          state: { step: 3 },  // this IS the agent state
        },
      },
    });

    // Only values.state is returned, loose fields are ignored
    expect(request.state).toEqual({ step: 3 });
  });

  it('should not leak framework fields into agent state', async () => {
    // Framework fields in values (outside state key) are never passed to the agent.
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        values: {
          messages: [{ role: 'user', content: 'Previous' }],
          _checkpoint_ns: 'abc',
          _created_at: '2026-03-24T00:00:00Z',
        },
      },
    });

    // No values.state key → no state passed to agent
    expect(request.state).toBeUndefined();
  });

  it('should read from values.state even when threadState.state exists at root', async () => {
    // updateThreadState writes into values.state, not at the root.
    // values.state is the authoritative source.
    const composer = new RequestComposer();
    const request = await composer.composeRequest({
      threadId: 't1',
      runId: 'r1',
      assistantId: 'a1',
      input: { messages: [{ role: 'user', content: 'Hi' }] },
      threadState: {
        state: { workflow_step: 5 },          // root-level — ignored
        values: {
          messages: [],
          state: { workflow_step: 10 },        // values.state — authoritative
        },
      },
    });

    expect(request.state).toEqual({ workflow_step: 10 });
  });
});

describe('CLI Agent Connector', () => {
  let registry: AgentRegistry;
  let connector: CliAgentConnector;

  beforeAll(() => {
    registry = new AgentRegistry();
    connector = new CliAgentConnector();
  });

  it.skipIf(!hasAzureKeys)(
      'should execute the passthrough agent and get a response',
      async () => {
        const config = registry.getAgentConfig('passthrough')!;
        const request: AgentRequest = {
          thread_id: 'test-thread',
          run_id: 'test-run',
          assistant_id: 'test-asst',
          messages: [
            { role: 'user', content: 'What is 1+1? Reply with just the number.' },
          ],
        };

        const response = await connector.execute(config, request);

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
        const config = registry.getAgentConfig('passthrough')!;
        const request: AgentRequest = {
          thread_id: 'test-thread',
          run_id: 'test-run',
          assistant_id: 'test-asst',
          messages: [
            { role: 'user', content: 'Say hello in one word.' },
          ],
        };

        const events: StreamEvent[] = [];
        for await (const event of connector.stream(config, request)) {
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
    const fakeConfig = { type: 'cli' as const, command: 'nonexistent-cmd-xyz', args: [], cwd: '.', timeout: 5000 };
    const request: AgentRequest = {
      thread_id: 'test',
      run_id: 'test',
      assistant_id: 'test',
      messages: [{ role: 'user', content: 'test' }],
    };

    await expect(
        connector.execute(fakeConfig, request),
    ).rejects.toThrow();
  });
});
