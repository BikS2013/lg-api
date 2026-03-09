import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessageLike } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentRequest, AgentResponse, Document } from './types.js';

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
  request: AgentRequest
): Promise<AgentResponse> {
  const langChainMessages = toLangChainMessages(request);
  const result = await model.invoke(langChainMessages);

  const responseContent =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

  return {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [
      {
        role: 'assistant',
        content: responseContent,
      },
    ],
    metadata: request.metadata,
  };
}
