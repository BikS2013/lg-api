import { describe, it, expect } from 'vitest';
import { parseSkillContent, resolveSkillPath } from '../agents/skill-agent/src/skill-loader.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_DIR = path.resolve(__dirname, '..', 'agents', 'skill-agent');
const AGENT_ENTRY = path.join(AGENT_DIR, 'src', 'index.ts');

// ---------------------------------------------------------------------------
// skill-loader.ts tests
// ---------------------------------------------------------------------------

describe('skill-loader', () => {
  describe('parseSkillContent', () => {
    it('should parse a valid SKILL.md with frontmatter and content', () => {
      const raw = `---
name: test-skill
description: A test skill
model: claude-sonnet-4-20250514
---
You are a test assistant.
Follow these rules.`;

      const result = parseSkillContent(raw, 'test.md');

      expect(result.name).toBe('test-skill');
      expect(result.description).toBe('A test skill');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.prompt).toBe('You are a test assistant.\nFollow these rules.');
    });

    it('should parse a skill with tools list', () => {
      const raw = `---
name: tool-skill
description: A skill with tools
tools:
  - Read
  - Grep
  - Glob
---
You can use tools.`;

      const result = parseSkillContent(raw, 'test.md');

      expect(result.name).toBe('tool-skill');
      expect(result.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(result.prompt).toBe('You can use tools.');
    });

    it('should throw if frontmatter is missing', () => {
      const raw = 'Just some content without frontmatter';

      expect(() => parseSkillContent(raw, 'bad.md')).toThrow(
        'Invalid skill file format: bad.md'
      );
    });

    it('should throw if name field is missing', () => {
      const raw = `---
description: No name here
---
Some content.`;

      expect(() => parseSkillContent(raw, 'noname.md')).toThrow(
        "Missing required 'name' field"
      );
    });

    it('should throw if description field is missing', () => {
      const raw = `---
name: nodesc
---
Some content.`;

      expect(() => parseSkillContent(raw, 'nodesc.md')).toThrow(
        "Missing required 'description' field"
      );
    });

    it('should throw if prompt body is empty', () => {
      const raw = `---
name: empty-body
description: Has no body
---
`;

      expect(() => parseSkillContent(raw, 'empty.md')).toThrow(
        'Skill file has empty prompt content'
      );
    });

    it('should return undefined for optional model when not present', () => {
      const raw = `---
name: no-model
description: No model specified
---
Some prompt content here.`;

      const result = parseSkillContent(raw, 'test.md');

      expect(result.model).toBeUndefined();
      expect(result.tools).toBeUndefined();
    });
  });

  describe('resolveSkillPath', () => {
    it('should resolve to the skills directory with .md extension', () => {
      const result = resolveSkillPath('code-reviewer');

      expect(result).toContain('agents/skill-agent/skills/code-reviewer.md');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// skill-agent integration tests (stdin/stdout contract)
// ---------------------------------------------------------------------------

describe('skill-agent process', () => {
  /**
   * Helper to spawn the skill agent as a child process and pipe data to stdin.
   * Returns the stdout, stderr, and exit code.
   */
  function runAgent(
    stdinData: string,
    env: Record<string, string> = {},
    args: string[] = ['--skill', 'code-reviewer'],
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      const child = spawn('npx', ['tsx', AGENT_ENTRY, ...args], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          ...env,
          // Ensure NODE_ENV is set for consistent behavior
          NODE_ENV: 'test',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('close', (exitCode) => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode,
        });
      });

      // Write to stdin and close it
      child.stdin.write(stdinData);
      child.stdin.end();
    });
  }

  const validRequest = JSON.stringify({
    thread_id: 'test-thread-1',
    run_id: 'test-run-1',
    assistant_id: 'skill-code-reviewer',
    messages: [
      {
        role: 'user',
        content: 'Review this code:\n```python\ndef add(a, b):\n  return a + b\n```',
      },
    ],
  });

  it('should fail with clear error when ANTHROPIC_API_KEY is missing', async () => {
    const result = await runAgent(validRequest, {
      ANTHROPIC_API_KEY: '',
      MAX_TOKENS: '4096',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ANTHROPIC_API_KEY');
    // stdout must be empty -- errors go to stderr only
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail with clear error when MAX_TOKENS is missing', async () => {
    const result = await runAgent(validRequest, {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('MAX_TOKENS');
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail when --skill argument is missing', async () => {
    const result = await runAgent(validRequest, {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '4096',
      SKILL_NAME: '',
    }, []);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Skill name is required');
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail when skill file does not exist', async () => {
    const result = await runAgent(validRequest, {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '4096',
    }, ['--skill', 'nonexistent-skill']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Skill file not found');
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail on empty stdin', async () => {
    const result = await runAgent('', {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '4096',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No input received on stdin');
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail on invalid JSON stdin', async () => {
    const result = await runAgent('not-json', {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '4096',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Failed to parse stdin as JSON');
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail when thread_id is missing from request', async () => {
    const badRequest = JSON.stringify({
      run_id: 'r1',
      assistant_id: 'a1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const result = await runAgent(badRequest, {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '4096',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('thread_id');
    expect(result.stdout).toBe('');
  }, 30000);

  it('should fail when messages array is empty', async () => {
    const badRequest = JSON.stringify({
      thread_id: 't1',
      run_id: 'r1',
      assistant_id: 'a1',
      messages: [],
    });

    const result = await runAgent(badRequest, {
      ANTHROPIC_API_KEY: 'sk-ant-test-fake-key',
      MAX_TOKENS: '4096',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('messages');
    expect(result.stdout).toBe('');
  }, 30000);

  // NOTE: This test requires a real ANTHROPIC_API_KEY and makes an actual API call.
  // It is skipped by default. Set RUN_LIVE_API_TESTS=true to enable.
  const liveApiTest = process.env.RUN_LIVE_API_TESTS === 'true' ? it : it.skip;

  liveApiTest('should return valid AgentResponse with real API call', async () => {
    const result = await runAgent(validRequest, {
      MAX_TOKENS: '1024',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const response = JSON.parse(result.stdout);

    // Verify AgentResponse contract
    expect(response.thread_id).toBe('test-thread-1');
    expect(response.run_id).toBe('test-run-1');
    expect(response.messages).toHaveLength(1);
    expect(response.messages[0].role).toBe('assistant');
    expect(typeof response.messages[0].content).toBe('string');
    expect(response.messages[0].content.length).toBeGreaterThan(0);

    // Verify response_metadata
    const meta = response.messages[0].response_metadata;
    expect(meta).toBeDefined();
    expect(meta.provider).toBe('anthropic');
    expect(meta.model).toBeDefined();
    expect(meta.usage).toBeDefined();
    expect(meta.usage.prompt_tokens).toBeGreaterThan(0);
    expect(meta.usage.completion_tokens).toBeGreaterThan(0);
    expect(meta.latency_ms).toBeGreaterThan(0);

    // Verify skill metadata
    expect(response.metadata).toBeDefined();
    expect(response.metadata.skill_name).toBe('code-reviewer');
  }, 60000);
});
