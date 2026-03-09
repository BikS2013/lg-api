/**
 * Tests for the YAML configuration loader (storage layer).
 *
 * Covers:
 * - Loading config from a temp YAML file with named profiles
 * - Profile selection (explicit, single-entry auto, multi-entry error)
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

import { loadStorageConfig } from '../src/storage/yaml-config-loader.js';

function tmpYamlPath(): string {
  return path.join(os.tmpdir(), `test-storage-config-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
}

describe('YAML Config Loader', () => {
  let tmpFile: string | null = null;
  const originalEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      originalEnv[k] = process.env[k];
    }
  }

  beforeEach(() => {
    saveEnv('STORAGE_CONFIG_PATH', 'TEST_SQLITE_PATH', 'TEST_MISSING_VAR');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    if (tmpFile && existsSync(tmpFile)) {
      unlinkSync(tmpFile);
      tmpFile = null;
    }
  });

  // -----------------------------------------------------------------------
  // Load config with named profiles
  // -----------------------------------------------------------------------
  it('should load a sqlite config with an explicit profile', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'profile: dev',
      'sqlite:',
      '  dev:',
      '    path: /tmp/dev.db',
      '    walMode: true',
      '  test:',
      '    path: /tmp/test.db',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    const config = loadStorageConfig();
    expect(config.provider).toBe('sqlite');
    expect(config.profile).toBe('dev');
    expect(config.sqlite!.path).toBe('/tmp/dev.db');
    expect(config.sqlite!.walMode).toBe(true);
  });

  it('should auto-select the profile when only one entry exists', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'sqlite:',
      '  only-one:',
      '    path: /tmp/single.db',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    const config = loadStorageConfig();
    expect(config.provider).toBe('sqlite');
    expect(config.profile).toBe('only-one');
    expect(config.sqlite!.path).toBe('/tmp/single.db');
  });

  it('should throw when multiple profiles exist but no profile is specified', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'sqlite:',
      '  dev:',
      '    path: /tmp/dev.db',
      '  test:',
      '    path: /tmp/test.db',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/multiple profiles.*no "profile" field/i);
  });

  it('should throw when the specified profile does not exist', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'profile: nonexistent',
      'sqlite:',
      '  dev:',
      '    path: /tmp/dev.db',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/profile "nonexistent" not found/i);
  });

  // -----------------------------------------------------------------------
  // Memory provider
  // -----------------------------------------------------------------------
  it('should load a valid memory config from a YAML file', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, 'provider: memory\n');
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    const config = loadStorageConfig();
    expect(config.provider).toBe('memory');
  });

  // -----------------------------------------------------------------------
  // Environment variable substitution
  // -----------------------------------------------------------------------
  it('should substitute ${VAR} references within the selected profile', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'sqlite:',
      '  dynamic:',
      '    path: ${TEST_SQLITE_PATH}',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;
    process.env['TEST_SQLITE_PATH'] = '/tmp/from-env.db';

    const config = loadStorageConfig();
    expect(config.sqlite!.path).toBe('/tmp/from-env.db');
  });

  it('should throw when a referenced env var is not set', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'sqlite:',
      '  broken:',
      '    path: ${TEST_MISSING_VAR}',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;
    delete process.env['TEST_MISSING_VAR'];

    expect(() => loadStorageConfig()).toThrow(/Missing required environment variable.*TEST_MISSING_VAR/);
  });

  it('should NOT substitute env vars in non-selected profiles', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'profile: safe',
      'sqlite:',
      '  safe:',
      '    path: /tmp/safe.db',
      '  broken:',
      '    path: ${NONEXISTENT_VAR_THAT_WOULD_THROW}',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    // Should NOT throw because the broken profile is not selected
    const config = loadStorageConfig();
    expect(config.sqlite!.path).toBe('/tmp/safe.db');
  });

  // -----------------------------------------------------------------------
  // Validation: missing required fields
  // -----------------------------------------------------------------------
  it('should throw when provider field is missing', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, 'sqlite:\n  dev:\n    path: /tmp/test.db\n');
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/missing required field.*provider/i);
  });

  it('should throw when the provider section is missing', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, 'provider: sqlite\n');
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/missing required section.*sqlite/i);
  });

  it('should throw when sqlite.path is missing in the profile', () => {
    tmpFile = tmpYamlPath();
    writeFileSync(tmpFile, [
      'provider: sqlite',
      'sqlite:',
      '  bad:',
      '    walMode: true',
    ].join('\n'));
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/missing required field.*path/i);
  });

  // -----------------------------------------------------------------------
  // Default to memory when no config file exists
  // -----------------------------------------------------------------------
  it('should default to memory provider when no config file is found', () => {
    delete process.env['STORAGE_CONFIG_PATH'];
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
  // STORAGE_CONFIG_PATH special values and file paths
  // -----------------------------------------------------------------------
  it('should use STORAGE_CONFIG_PATH=memory to force in-memory', () => {
    process.env['STORAGE_CONFIG_PATH'] = 'memory';
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
    writeFileSync(tmpFile, 'provider: postgres\n');
    process.env['STORAGE_CONFIG_PATH'] = tmpFile;

    expect(() => loadStorageConfig()).toThrow(/Invalid storage provider.*"postgres"/);
  });
});
