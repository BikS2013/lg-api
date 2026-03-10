import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessageLike } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentRequest, AgentResponse, Document, LlmResponseMetadata } from './types.js';

/**
 * Build a context system message from the provided documents.
 */
function buildDocumentsContext(documents: Document[]): string {
  const parts = documents.map((doc) => {
    const title = doc.title ? `[${doc.title}]` : `[Document ${doc.id}]`;
    return `${title}\n${doc.content}`;
  });
  return `Context documents:\n\n${parts.join('\n\n')}`;
}

/**
 * Convert agent messages to LangChain message objects.
 */
function toLangChainMessages(
  request: AgentRequest
): BaseMessageLike[] {
  const messages: BaseMessageLike[] = [];

  // If documents are provided, prepend them as a system message
  if (request.documents && request.documents.length > 0) {
    messages.push(new SystemMessage(buildDocumentsContext(request.documents)));
  }

  // Convert each message to its LangChain equivalent
  for (const msg of request.messages) {
    switch (msg.role) {
      case 'system':
        messages.push(new SystemMessage(msg.content));
        break;
      case 'user':
        messages.push(new HumanMessage(msg.content));
        break;
      case 'assistant':
        messages.push(new AIMessage(msg.content));
        break;
      default:
        throw new Error(`Unsupported message role: ${msg.role}`);
    }
  }

  return messages;
}

/**
 * Run the passthrough agent: send messages to the LLM and return the response.
 */
export async function runAgent(
  model: BaseChatModel,
  request: AgentRequest,
  provider: string,
): Promise<AgentResponse> {
  const langChainMessages = toLangChainMessages(request);

  const startTime = Date.now();
  const result = await model.invoke(langChainMessages);
  const endTime = Date.now();

  const responseContent =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

  // Extract metadata from LangChain AIMessage
  const responseMeta = result.response_metadata as Record<string, unknown> | undefined;
  const usageMeta = result.usage_metadata as Record<string, unknown> | undefined;

  const llmMetadata: LlmResponseMetadata = {
    model: (responseMeta?.['model_name'] ?? responseMeta?.['model']) as string | undefined,
    usage: usageMeta
      ? {
          prompt_tokens: (usageMeta['input_tokens'] as number | undefined),
          completion_tokens: (usageMeta['output_tokens'] as number | undefined),
          total_tokens: (usageMeta['total_tokens'] as number | undefined),
        }
      : undefined,
    finish_reason: (
      responseMeta?.['finish_reason'] ??
      responseMeta?.['stop_reason'] ??
      responseMeta?.['finishReason']
    ) as string | undefined,
    latency_ms: endTime - startTime,
    provider,
    provider_response_id: (responseMeta?.['id'] ?? responseMeta?.['system_fingerprint']) as string | undefined,
  };

  return {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [
      {
        role: 'assistant',
        content: responseContent,
        response_metadata: llmMetadata,
      },
    ],
    state: request.state,
    metadata: request.metadata,
  };
}
