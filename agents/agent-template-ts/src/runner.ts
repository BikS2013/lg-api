import type { AgentHandler, AgentRequest } from './types.js';

// Redirect console.log to stderr so library/agent code that logs
// doesn't pollute the stdout JSON protocol.
console.log = (...args: unknown[]) => console.error(...args);

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

function parseRequest(raw: string): AgentRequest {
  if (!raw.trim()) {
    throw new Error('No input received on stdin. Expected a JSON AgentRequest.');
  }

  let request: AgentRequest;
  try {
    request = JSON.parse(raw) as AgentRequest;
  } catch {
    throw new Error(`Failed to parse stdin as JSON: ${raw.substring(0, 200)}`);
  }

  if (!request.thread_id) throw new Error("Missing required field 'thread_id'.");
  if (!request.run_id) throw new Error("Missing required field 'run_id'.");
  if (!request.assistant_id) throw new Error("Missing required field 'assistant_id'.");
  if (!request.messages || request.messages.length === 0) {
    throw new Error("Missing or empty 'messages'.");
  }

  return request;
}

export function runAgent(handler: AgentHandler): void {
  readStdin()
    .then(parseRequest)
    .then(handler)
    .then((response) => {
      process.stdout.write(JSON.stringify(response), () => {
        process.exit(0);
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exit(1);
    });
}
