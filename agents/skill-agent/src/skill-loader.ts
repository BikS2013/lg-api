import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parsed skill definition from a SKILL.md file.
 */
export interface ParsedSkill {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  prompt: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the absolute path to a skill file by name.
 * Looks in the `skills/` directory relative to the agent root.
 *
 * @param skillName - The skill name (without .md extension)
 * @returns Absolute path to the skill .md file
 */
export function resolveSkillPath(skillName: string): string {
  // Validate skill name to prevent path traversal
  if (!skillName || /[/\\]/.test(skillName)) {
    throw new Error(
      `Invalid skill name: "${skillName}". ` +
      `Skill name must not contain path separators (/ or \\).`
    );
  }

  const agentRoot = path.resolve(__dirname, '..');
  const skillsDir = path.join(agentRoot, 'skills');
  const resolved = path.resolve(skillsDir, `${skillName}.md`);

  // Ensure the resolved path is within the skills directory
  if (!resolved.startsWith(skillsDir + path.sep)) {
    throw new Error(
      `Invalid skill name: "${skillName}". ` +
      `Resolved path escapes the skills directory.`
    );
  }

  return resolved;
}

/**
 * Load and parse a SKILL.md file.
 *
 * The file format is:
 * ---
 * name: <skill-name>
 * description: <description>
 * model: <optional model override>
 * ---
 * <markdown body = system prompt>
 *
 * @param skillPath - Absolute path to the SKILL.md file
 * @returns Parsed skill object with metadata and prompt content
 * @throws Error if the file does not exist or cannot be parsed
 */
export function loadSkill(skillPath: string): ParsedSkill {
  if (!fs.existsSync(skillPath)) {
    throw new Error(
      `Skill file not found: ${skillPath}. ` +
      `Ensure the skill .md file exists at the specified path.`
    );
  }

  const raw = fs.readFileSync(skillPath, 'utf-8');
  return parseSkillContent(raw, skillPath);
}

/**
 * Parse raw SKILL.md content into a ParsedSkill object.
 * Exported for testing purposes.
 *
 * @param raw - Raw file content
 * @param sourcePath - Path used in error messages
 * @returns Parsed skill
 */
export function parseSkillContent(raw: string, sourcePath: string = '<unknown>'): ParsedSkill {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    throw new Error(
      `Invalid skill file format: ${sourcePath}. ` +
      `Expected YAML frontmatter between --- markers followed by markdown content.`
    );
  }

  const yamlBlock = frontmatterMatch[1];
  const markdownBody = frontmatterMatch[2].trim();

  if (!markdownBody) {
    throw new Error(
      `Skill file has empty prompt content: ${sourcePath}. ` +
      `The markdown body after the frontmatter must contain the skill's system prompt.`
    );
  }

  const name = extractYamlField(yamlBlock, 'name');
  if (!name) {
    throw new Error(
      `Missing required 'name' field in skill frontmatter: ${sourcePath}.`
    );
  }

  const description = extractYamlField(yamlBlock, 'description');
  if (!description) {
    throw new Error(
      `Missing required 'description' field in skill frontmatter: ${sourcePath}.`
    );
  }

  return {
    name,
    description,
    model: extractYamlField(yamlBlock, 'model'),
    tools: extractYamlList(yamlBlock, 'tools'),
    prompt: markdownBody,
  };
}

/**
 * Extract a simple scalar value from a YAML block.
 */
function extractYamlField(yaml: string, field: string): string | undefined {
  const match = yaml.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

/**
 * Extract a list value from a YAML block (items prefixed with -).
 */
function extractYamlList(yaml: string, field: string): string[] | undefined {
  const fieldIndex = yaml.indexOf(`${field}:`);
  if (fieldIndex === -1) return undefined;

  const lines = yaml.substring(fieldIndex).split('\n').slice(1);
  const items: string[] = [];
  for (const line of lines) {
    const itemMatch = line.match(/^\s+-\s+(.+)$/);
    if (itemMatch) {
      items.push(itemMatch[1].trim());
    } else if (line.trim() && !line.startsWith(' ')) {
      break;
    }
  }
  return items.length > 0 ? items : undefined;
}
