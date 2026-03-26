/**
 * Request Composer
 *
 * Builds an AgentRequest from the lg-api run context. Gathers conversation
 * history from thread state, new user messages from run input, and optional
 * documents. Returns a complete AgentRequest ready for the CLI connector.
 */

import type { AgentRequest, AgentMessage, AgentDocument } from './types.js';

/**
 * Parameters for composing an agent request.
 */
export interface ComposeRequestParams {
  threadId: string;
  runId: string;
  assistantId: string;
  input: Record<string, unknown>;
  threadState?: Record<string, unknown>;
}

export class RequestComposer {
  /**
   * Build an AgentRequest from a run's context.
   *
   * Message gathering logic:
   * 1. Extract conversation history from threadState.values.messages (if present)
   * 2. Extract new user messages from input.messages
   * 3. Combine history + new messages in chronological order
   * 4. Extract documents from input.documents (if present)
   */
  async composeRequest(params: ComposeRequestParams): Promise<AgentRequest> {
    const { threadId, runId, assistantId, input, threadState } = params;

    const messages: AgentMessage[] = [];

    // 1. Gather conversation history from thread state
    if (threadState) {
      const historyMessages = this.extractMessagesFromState(threadState);
      messages.push(...historyMessages);
    }

    // 2. Gather new messages from run input
    const inputMessages = this.extractMessagesFromInput(input);
    messages.push(...inputMessages);

    // 3. Gather documents from run input
    const documents = this.extractDocumentsFromInput(input);

    // 4. Gather state from thread state and/or input
    const state = this.extractState(input, threadState);

    // 5. Gather metadata from run input
    const metadata = this.extractMetadata(input);

    const request: AgentRequest = {
      thread_id: threadId,
      run_id: runId,
      assistant_id: assistantId,
      messages,
    };

    if (documents.length > 0) {
      request.documents = documents;
    }

    if (state && Object.keys(state).length > 0) {
      request.state = state;
    }

    if (Object.keys(metadata).length > 0) {
      request.metadata = metadata;
    }

    return request;
  }

  /**
   * Extract conversation history messages from thread state.
   *
   * Expects threadState.values.messages to be an array of objects with
   * at least a `type` (or `role`) and `content` field. Maps LangGraph
   * message types to the agent message role format.
   */
  private extractMessagesFromState(threadState: Record<string, unknown>): AgentMessage[] {
    const values = threadState['values'] as Record<string, unknown> | undefined;
    if (!values) {
      return [];
    }

    const rawMessages = values['messages'] as unknown[];
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    return rawMessages
      .map((msg) => this.normalizeMessage(msg))
      .filter((msg): msg is AgentMessage => msg !== null);
  }

  /**
   * Extract new messages from run input.
   *
   * Expects input.messages to be an array of message objects.
   */
  private extractMessagesFromInput(input: Record<string, unknown>): AgentMessage[] {
    const rawMessages = input['messages'] as unknown[];
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    return rawMessages
      .map((msg) => this.normalizeMessage(msg))
      .filter((msg): msg is AgentMessage => msg !== null);
  }

  /**
   * Normalize a raw message object into an AgentMessage.
   *
   * Handles both LangGraph-style messages (type: 'human'/'ai'/'system')
   * and standard role-based messages (role: 'user'/'assistant'/'system').
   */
  private normalizeMessage(raw: unknown): AgentMessage | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const msg = raw as Record<string, unknown>;
    const content = msg['content'];
    if (typeof content !== 'string') {
      return null;
    }

    // Try role-based format first
    const role = msg['role'] as string | undefined;
    if (role === 'user' || role === 'assistant' || role === 'system') {
      return { role, content };
    }

    // Try LangGraph type-based format
    const type = msg['type'] as string | undefined;
    if (type) {
      const mappedRole = this.mapTypeToRole(type);
      if (mappedRole) {
        return { role: mappedRole, content };
      }
    }

    return null;
  }

  /**
   * Map a LangGraph message type to an agent message role.
   */
  private mapTypeToRole(type: string): AgentMessage['role'] | null {
    switch (type.toLowerCase()) {
      case 'human':
      case 'humanmessage':
      case 'humanmessagechunk':
        return 'user';
      case 'ai':
      case 'aimessage':
      case 'aimessagechunk':
        return 'assistant';
      case 'system':
      case 'systemmessage':
        return 'system';
      default:
        return null;
    }
  }

  /**
   * Extract documents from run input.
   *
   * Expects input.documents to be an array of document objects,
   * each with at least an `id` and `content` field.
   */
  private extractDocumentsFromInput(input: Record<string, unknown>): AgentDocument[] {
    const rawDocs = input['documents'] as unknown[];
    if (!Array.isArray(rawDocs)) {
      return [];
    }

    return rawDocs
      .filter((doc): doc is Record<string, unknown> => doc !== null && typeof doc === 'object')
      .filter((doc) => typeof doc['id'] === 'string' && typeof doc['content'] === 'string')
      .map((doc) => {
        const document: AgentDocument = {
          id: doc['id'] as string,
          content: doc['content'] as string,
        };
        if (typeof doc['title'] === 'string') {
          document.title = doc['title'] as string;
        }
        if (doc['metadata'] && typeof doc['metadata'] === 'object') {
          document.metadata = doc['metadata'] as Record<string, unknown>;
        }
        return document;
      });
  }

  /**
   * Extract state to pass to the agent.
   *
   * The lg-api does NOT modify the state object. Only the agent is responsible
   * for maintaining and changing it. The lg-api simply passes the state through:
   *
   * 1. If the thread has a stored state (from a previous agent response), pass it as-is
   * 2. If the run input includes an explicit state, pass it as-is (overrides stored state)
   *
   * No merging, no field extraction, no transformation.
   */
  private extractState(
    input: Record<string, unknown>,
    threadState?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    // Explicit state from input takes priority (passed through untouched)
    const inputState = input['state'] as Record<string, unknown> | undefined;
    if (inputState && typeof inputState === 'object') {
      return inputState;
    }

    // Otherwise, pass the stored state from thread (set by a previous agent response).
    // updateThreadState() spreads agentResponse.state into values, so the stored
    // state lives at threadState.values.state, not threadState.state.
    if (threadState) {
      const values = threadState['values'] as Record<string, unknown> | undefined;
      const storedState = values?.['state'] as Record<string, unknown> | undefined;
      if (storedState && typeof storedState === 'object') {
        return storedState;
      }
    }

    return undefined;
  }

  /**
   * Extract metadata from run input (everything except messages, documents, and state).
   */
  private extractMetadata(input: Record<string, unknown>): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key !== 'messages' && key !== 'documents' && key !== 'state') {
        metadata[key] = value;
      }
    }
    return metadata;
  }
}
