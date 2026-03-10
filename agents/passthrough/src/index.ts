import 'dotenv/config';
import { loadLlmConfig } from './config.js';
import { createChatModel } from './llm-factory.js';
import { runAgent } from './agent.js';
import type { AgentRequest } from './types.js';

/**
 * Read all data from stdin as a string.
 */
async function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  // Read JSON request from stdin
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    throw new Error('No input received on stdin. Expected a JSON AgentRequest.');
  }

  let request: AgentRequest;
  try {
    request = JSON.parse(rawInput) as AgentRequest;
  } catch {
    throw new Error(`Failed to parse stdin as JSON: ${rawInput.substring(0, 200)}`);
  }

  // Validate required fields
  if (!request.thread_id) {
    throw new Error("Missing required field 'thread_id' in AgentRequest.");
  }
  if (!request.run_id) {
    throw new Error("Missing required field 'run_id' in AgentRequest.");
  }
  if (!request.assistant_id) {
    throw new Error("Missing required field 'assistant_id' in AgentRequest.");
  }
  if (!request.messages || request.messages.length === 0) {
    throw new Error("Missing or empty 'messages' in AgentRequest.");
  }

  // Load LLM config
  const llmConfig = loadLlmConfig();

  // Create the chat model
  const model = createChatModel(llmConfig);

  // Run the agent
  const response = await runAgent(model, request, llmConfig.provider);

  // Write JSON response to stdout
  process.stdout.write(JSON.stringify(response));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
