/**
 * Tests for the YAML configuration loader (storage layer).
 *
 * Covers:
 * - Loading config from a temp YAML file
 * - Environment variable substitution
 * - Validation of required fields
 * - Default to memory provider when no config file exists
 * - STORAGE_CONFIG_PATH env var
 * - Invalid provider name
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The loader is the system under test
import { loadStorageConfig } from '../src/storage/yaml-config-loader.js';

function tmpYamlPath(): string {
  return path.join(os.tmpdir(), `test-storage-config-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
}

describe('YAML Config Loader', () => {
  let tmpFile: string | null = null;
  const originalEnv: Record<string, string | undefined> = {};

  /** Save and later restore env vars we may touch. */
  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      originalEnv[k] = process.env[k];
    }
  }

  beforeEach(() => {
    saveEnv('STORAGE_CONFIG_PATH', 'TEST_SQLITE_PATH', 'TEST_MISSING_VAR');
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    // Clean up temp file
    if (tmpFile && existsSync(tmpFile)) {
      unlinkSync(tmpFile);
      tmpFile = null;
    }
  });

  // -----------------------------------------------------------------------
  // Load config from a temp YAML file
  // -----------------------------------------------------------------------
  it('should load a valid sqlite config from a YAML file', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(
      tmpFile,
      `provider: sqlite\nsqlite:\n  path: /tmp/test.db\n  walMode: true\n`,
    );
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    const config = loadStorageConfig();

    expect(config.provider).toBe('sqlite');
    expect(config.sqlite).toBeDefined();
    expect(config.sqlite!.path).toBe('/tmp/test.db');
    expect(config.sqlite!.walMode).toBe(true);
  });

  it('should load a valid memory config from a YAML file', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, `provider: memory\n`);
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    const config = loadStorageConfig();
    expect(config.provider).toBe('memory');
  });

  // -----------------------------------------------------------------------
  // Environment variable substitution
  // -----------------------------------------------------------------------
  it('should substitute ${VAR} references with env var values', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(
      tmpFile,
      `provider: sqlite\nsqlite:\n  path: \${TEST_SQLITE_PATH}\n`,
    );
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;
    process.env['TEST_SQLITE_PATH'] = '/tmp/from-env.db';

    const config = loadStorageConfig();
    expect(config.sqlite!.path).toBe('/tmp/from-env.db');
  });

  it('should throw when a referenced env var is not set', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(
      tmpFile,
      `provider: sqlite\nsqlite:\n  path: \${TEST_MISSING_VAR}\n`,
    );
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;
    delete process.env['TEST_MISSING_VAR'];

    expect(() => loadStorageConfig()).toThrow(/Missing required environment variable.*TEST_MISSING_VAR/);
  });

  // -----------------------------------------------------------------------
  // Validation: missing required fields
  // -----------------------------------------------------------------------
  it('should throw when provider field is missing', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, `sqlite:\n  path: /tmp/test.db\n`);
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/missing required field.*provider/i);
  });

  it('should throw when sqlite section is missing for sqlite provider', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, `provider: sqlite\n`);
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/missing required section.*sqlite/i);
  });

  it('should throw when sqlite.path is missing', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, `provider: sqlite\nsqlite:\n  walMode: true\n`);
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/missing required field.*sqlite\.path/i);
  });

  // -----------------------------------------------------------------------
  // Default to memory provider when no config file exists
  // -----------------------------------------------------------------------
  it('should default to memory provider when no config file is found', () => {
    // Make sure STORAGE_CONFIG_PATH is unset and cwd has no storage-config.yaml
    delete process.env['STORAGE_CONFIG_PATH'];

    // Save cwd and move to temp dir (which has no storage-config.yaml)
    const origCwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const config = loadStorageConfig();
      expect(config.provider).toBe('memory');
    } finally {
      process.chdir(origCwd);
    }
  });

  // -----------------------------------------------------------------------
  // STORAGE_CONFIG_PATH env var pointing to a file
  // -----------------------------------------------------------------------
  it('should use STORAGE_CONFIG_PATH when set', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, `provider: memory\n`);
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    const config = loadStorageConfig();
    expect(config.provider).toBe('memory');
  });

  it('should throw when STORAGE_CONFIG_PATH points to a non-existent file', () => {
    process.env['STORAGE_CONFIG_PATH'] = '/nonexistent/path/storage-config.yaml';
    expect(() => loadStorageConfig()).toThrow(/Storage config file not found/);
  });

  // -----------------------------------------------------------------------
  // Invalid provider name
  // -----------------------------------------------------------------------
  it('should throw for an invalid provider name', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, `provider: postgres\n`);
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/Invalid storage provider.*"postgres"/);
  });
});
