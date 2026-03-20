import 'dotenv/config';
import { loadSkill, resolveSkillPath } from './skill-loader.js';
import { callAnthropic } from './anthropic-client.js';

// ---------------------------------------------------------------------------
// Types -- matching the AgentRequest/AgentResponse contract from lg-api
// ---------------------------------------------------------------------------

interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  response_metadata?: Record<string, unknown>;
}

interface AgentDocument {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: AgentMessage[];
  documents?: AgentDocument[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function getSkillName(): string {
  // Check --skill CLI argument
  const skillArgIndex = process.argv.indexOf('--skill');
  if (skillArgIndex !== -1 && process.argv[skillArgIndex + 1]) {
    return process.argv[skillArgIndex + 1];
  }

  // Check SKILL_NAME env var
  if (process.env.SKILL_NAME) {
    return process.env.SKILL_NAME;
  }

  throw new Error(
    'Skill name is required. Provide it via --skill <name> CLI argument ' +
    'or SKILL_NAME environment variable.'
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Validate required env var -- no fallback
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required. ' +
      'Set it before running the skill agent.'
    );
  }

  // 2. Resolve and load the skill
  const skillName = getSkillName();
  const skillPath = resolveSkillPath(skillName);
  const skill = loadSkill(skillPath);

  // 3. Determine the model -- skill config, then env var, throw if neither
  const model = skill.model || process.env.CLAUDE_MODEL;
  if (!model) {
    throw new Error(
      'No model specified. Either set the "model" field in the skill frontmatter ' +
      'or provide the CLAUDE_MODEL environment variable.'
    );
  }

  // 4. Determine max tokens -- env var required, no fallback
  const maxTokensStr = process.env.MAX_TOKENS;
  if (!maxTokensStr) {
    throw new Error(
      'MAX_TOKENS environment variable is required. ' +
      'Set it to the maximum number of response tokens (e.g., 4096).'
    );
  }
  const maxTokens = parseInt(maxTokensStr, 10);
  if (isNaN(maxTokens) || maxTokens <= 0) {
    throw new Error(
      `MAX_TOKENS must be a positive integer, got: "${maxTokensStr}".`
    );
  }

  // 5. Read and validate stdin
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

  if (!request.thread_id) throw new Error("Missing required field 'thread_id' in AgentRequest.");
  if (!request.run_id) throw new Error("Missing required field 'run_id' in AgentRequest.");
  if (!request.assistant_id) throw new Error("Missing required field 'assistant_id' in AgentRequest.");
  if (!request.messages || request.messages.length === 0) {
    throw new Error("Missing or empty 'messages' in AgentRequest.");
  }

  // 6. Compose system prompt from skill + optional documents
  let systemPrompt = skill.prompt;
  if (request.documents && request.documents.length > 0) {
    const docContext = request.documents
      .map((d) => `[${d.title || d.id}]\n${d.content}`)
      .join('\n\n');
    systemPrompt = `${skill.prompt}\n\n---\nContext Documents:\n\n${docContext}`;
  }

  // 7. Call Anthropic API
  const anthropicMessages = request.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const { content, metadata } = await callAnthropic({
    apiKey,
    model,
    maxTokens,
    systemPrompt,
    messages: anthropicMessages,
  });

  // 8. Build and write AgentResponse
  const response: AgentResponse = {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [
      {
        role: 'assistant',
        content,
        response_metadata: metadata,
      },
    ],
    state: request.state,
    metadata: {
      ...request.metadata,
      skill_name: skill.name,
      skill_description: skill.description,
    },
  };

  process.stdout.write(JSON.stringify(response));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
