// tests/services/codex-sandbox.test.ts
//
// Unit tests for codex-sandbox.ts: input validation, sweep logic, and
// model string validation. These tests do NOT require bwrap or codex CLI
// and run ungated (no CC_SANDBOX_IT needed).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sweepOrphanedSandboxStaging, _testing } from '../../src/services/codex-sandbox.js';

const { validateModel, validatePath, MODEL_PATTERN, UUID_PATTERN } = _testing;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let testRoot: string;

beforeEach(() => {
  testRoot = join(
    process.env.HOME ?? '/tmp',
    '.cache', 'cc-memory', 'codex-sandbox-unit-tests',
    randomUUID(),
  );
  mkdirSync(testRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// validateModel
// ---------------------------------------------------------------------------

describe('validateModel', () => {
  it('accepts valid model strings', () => {
    const valid = [
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'o3',
      'claude-opus-4-6',
      'model_v2.1',
      'a',
      '1model',
      '.hidden-model',
    ];
    for (const m of valid) {
      expect(() => validateModel(m)).not.toThrow();
    }
  });

  it('rejects model strings starting with a dash', () => {
    expect(() => validateModel('--ignore-rules')).toThrow('Invalid model string');
    expect(() => validateModel('-o')).toThrow('Invalid model string');
    expect(() => validateModel('-model')).toThrow('Invalid model string');
  });

  it('rejects model strings with special characters', () => {
    expect(() => validateModel('model;rm -rf /')).toThrow('Invalid model string');
    expect(() => validateModel('model$(evil)')).toThrow('Invalid model string');
    expect(() => validateModel('model name')).toThrow('Invalid model string');
    expect(() => validateModel('model/path')).toThrow('Invalid model string');
    expect(() => validateModel('')).toThrow('Invalid model string');
  });
});

// ---------------------------------------------------------------------------
// validatePath
// ---------------------------------------------------------------------------

describe('validatePath', () => {
  it('rejects paths containing ".." segments', () => {
    expect(() => validatePath('/a/../b', 'test')).toThrow("'..'");
  });

  it('rejects relative paths', () => {
    expect(() => validatePath('relative/path', 'test')).toThrow('absolute path');
  });

  it('accepts valid absolute paths that exist', () => {
    const dir = join(testRoot, 'valid-dir');
    mkdirSync(dir);
    const result = validatePath(dir, 'test');
    expect(result).toBeTruthy();
    expect(result.startsWith('/')).toBe(true);
  });

  it('validates path is under expected root', () => {
    const dir = join(testRoot, 'sub');
    mkdirSync(dir);
    // This should pass — dir is under testRoot
    expect(() => validatePath(dir, 'test', testRoot)).not.toThrow();
  });

  it('rejects path outside expected root', () => {
    expect(() => validatePath('/usr/bin', 'test', testRoot)).toThrow('outside expected root');
  });
});

// ---------------------------------------------------------------------------
// sweepOrphanedSandboxStaging
// ---------------------------------------------------------------------------

describe('sweepOrphanedSandboxStaging', () => {
  it('removes UUID-named directories older than threshold', () => {
    const stagingRoot = join(testRoot, 'staging');
    mkdirSync(stagingRoot);

    // Create two old UUID dirs
    const oldId1 = randomUUID();
    const oldId2 = randomUUID();
    const oldDir1 = join(stagingRoot, oldId1);
    const oldDir2 = join(stagingRoot, oldId2);
    mkdirSync(join(oldDir1, 'codex-home'), { recursive: true });
    mkdirSync(join(oldDir2, 'codex-home'), { recursive: true });
    writeFileSync(join(oldDir1, 'codex-home', 'auth.json'), '{"key":"old1"}');
    writeFileSync(join(oldDir2, 'codex-home', 'auth.json'), '{"key":"old2"}');

    // Backdate mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(oldDir1, twoHoursAgo, twoHoursAgo);
    utimesSync(oldDir2, twoHoursAgo, twoHoursAgo);

    // Create one fresh UUID dir (should NOT be removed)
    const freshId = randomUUID();
    const freshDir = join(stagingRoot, freshId);
    mkdirSync(join(freshDir, 'codex-home'), { recursive: true });
    writeFileSync(join(freshDir, 'codex-home', 'auth.json'), '{"key":"fresh"}');

    const result = sweepOrphanedSandboxStaging(stagingRoot, 60 * 60 * 1000); // 1 hour

    expect(result.removed.sort()).toEqual([oldDir1, oldDir2].sort());
    expect(result.errors).toEqual([]);
    expect(existsSync(oldDir1)).toBe(false);
    expect(existsSync(oldDir2)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  it('ignores non-UUID-named entries', () => {
    const stagingRoot = join(testRoot, 'staging-notuuid');
    mkdirSync(stagingRoot);

    // Create a non-UUID named directory
    const nonUuid = join(stagingRoot, 'not-a-uuid-dir');
    mkdirSync(nonUuid);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(nonUuid, twoHoursAgo, twoHoursAgo);

    // Create a plain file with UUID name
    const fileId = randomUUID();
    writeFileSync(join(stagingRoot, fileId), 'not a directory');

    const result = sweepOrphanedSandboxStaging(stagingRoot, 60 * 60 * 1000);

    expect(result.removed).toEqual([]);
    expect(existsSync(nonUuid)).toBe(true);
  });

  it('returns empty result when stagingRoot does not exist', () => {
    const result = sweepOrphanedSandboxStaging(
      join(testRoot, 'nonexistent'),
      60 * 60 * 1000,
    );
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty result when stagingRoot is empty', () => {
    const stagingRoot = join(testRoot, 'staging-empty');
    mkdirSync(stagingRoot);

    const result = sweepOrphanedSandboxStaging(stagingRoot, 60 * 60 * 1000);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('throws on non-positive olderThanMs', () => {
    expect(() => sweepOrphanedSandboxStaging(testRoot, 0)).toThrow('positive');
    expect(() => sweepOrphanedSandboxStaging(testRoot, -1)).toThrow('positive');
  });

  it('tolerates concurrent removal (ENOENT)', () => {
    const stagingRoot = join(testRoot, 'staging-race');
    mkdirSync(stagingRoot);

    const raceId = randomUUID();
    const raceDir = join(stagingRoot, raceId);
    mkdirSync(raceDir);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(raceDir, twoHoursAgo, twoHoursAgo);

    // Remove it before sweep runs (simulating concurrent removal)
    rmSync(raceDir, { recursive: true });

    const result = sweepOrphanedSandboxStaging(stagingRoot, 60 * 60 * 1000);
    // Should not error — ENOENT is tolerated
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

describe('patterns', () => {
  it('MODEL_PATTERN accepts valid models', () => {
    expect(MODEL_PATTERN.test('gpt-5.6-sol')).toBe(true);
    expect(MODEL_PATTERN.test('o3')).toBe(true);
    expect(MODEL_PATTERN.test('model_v2')).toBe(true);
  });

  it('MODEL_PATTERN rejects invalid models', () => {
    expect(MODEL_PATTERN.test('--ignore-rules')).toBe(false);
    expect(MODEL_PATTERN.test('-o')).toBe(false);
    expect(MODEL_PATTERN.test('')).toBe(false);
    expect(MODEL_PATTERN.test('model name')).toBe(false);
  });

  it('UUID_PATTERN matches UUID v4', () => {
    expect(UUID_PATTERN.test(randomUUID())).toBe(true);
    expect(UUID_PATTERN.test('not-a-uuid')).toBe(false);
    expect(UUID_PATTERN.test('12345678-1234-1234-1234-123456789012')).toBe(false); // wrong version nibble
  });
});

// ---------------------------------------------------------------------------
// stagingRoot validation via buildCodexSandboxCommand
// ---------------------------------------------------------------------------

describe('stagingRoot validation', () => {
  // We can't fully call buildCodexSandboxCommand without bwrap/codex,
  // but we can verify the early validation rejects bad stagingRoot values.
  // Import dynamically to test the validation path only.

  it('rejects /tmp as stagingRoot', async () => {
    const { buildCodexSandboxCommand } = await import('../../src/services/codex-sandbox.js');
    expect(() => buildCodexSandboxCommand({
      codexPackageRoot: '/nonexistent',
      hostCodexHome: '/nonexistent',
      hostOutputDir: '/nonexistent',
      hostCwd: '/nonexistent',
      model: 'gpt-5.6-sol',
      timeoutMs: 30000,
      stagingRoot: '/tmp',
    })).toThrow('/tmp');
  });

  it('rejects /tmp/sub as stagingRoot', async () => {
    const { buildCodexSandboxCommand } = await import('../../src/services/codex-sandbox.js');
    expect(() => buildCodexSandboxCommand({
      codexPackageRoot: '/nonexistent',
      hostCodexHome: '/nonexistent',
      hostOutputDir: '/nonexistent',
      hostCwd: '/nonexistent',
      model: 'gpt-5.6-sol',
      timeoutMs: 30000,
      stagingRoot: '/tmp/sub',
    })).toThrow('/tmp');
  });

  it('rejects relative stagingRoot', async () => {
    const { buildCodexSandboxCommand } = await import('../../src/services/codex-sandbox.js');
    expect(() => buildCodexSandboxCommand({
      codexPackageRoot: '/nonexistent',
      hostCodexHome: '/nonexistent',
      hostOutputDir: '/nonexistent',
      hostCwd: '/nonexistent',
      model: 'gpt-5.6-sol',
      timeoutMs: 30000,
      stagingRoot: 'relative/path',
    })).toThrow('absolute path');
  });

  it('rejects model with leading dash', async () => {
    const { buildCodexSandboxCommand } = await import('../../src/services/codex-sandbox.js');
    expect(() => buildCodexSandboxCommand({
      codexPackageRoot: '/nonexistent',
      hostCodexHome: '/nonexistent',
      hostOutputDir: '/nonexistent',
      hostCwd: '/nonexistent',
      model: '--ignore-rules',
      timeoutMs: 30000,
      stagingRoot: testRoot,
    })).toThrow('Invalid model string');
  });
});
