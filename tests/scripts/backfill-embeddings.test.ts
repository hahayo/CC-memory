import { mkdtemp, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isolateEmbeddingBackfillEnvironment,
  loadIsolatedEmbeddingGenerator,
  loadEmbeddingBackfillCredential,
  parseEmbeddingBackfillArgs,
  runEmbeddingBackfill,
  type EmbeddingBackfillRecord,
  type EmbeddingBackfillStore,
} from '../../scripts/backfill-embeddings.js';

describe('embedding backfill CLI parsing', () => {
  it('defaults to dry-run and parses execute, all targets, inline values, and a global limit', () => {
    expect(parseEmbeddingBackfillArgs([])).toMatchObject({
      targets: ['project_memories'],
      dryRun: true,
      batchSize: 1000,
      requestsPerMinute: 60,
    });
    expect(parseEmbeddingBackfillArgs([
      '--execute',
      '--key-file=/secure/new-gemini-key',
    ])).toMatchObject({
      dryRun: false,
      batchSize: 10,
      keyFile: '/secure/new-gemini-key',
    });
    expect(parseEmbeddingBackfillArgs([
      '--execute',
      '--table=all',
      '--batch-size=25',
      '--rpm=30',
      '--limit=7',
      '--key-file=/secure/new-gemini-key',
    ])).toMatchObject({
      targets: ['project_memories', 'observations'],
      dryRun: false,
      batchSize: 25,
      requestsPerMinute: 30,
      limit: 7,
    });
  });

  it('rejects invalid targets and non-positive integer options', () => {
    expect(() => parseEmbeddingBackfillArgs(['--table', 'tasks'])).toThrow('--table');
    expect(() => parseEmbeddingBackfillArgs(['--rpm', '0'])).toThrow('--rpm');
  });

  it('requires an explicit key file for execute but not for dry-run', () => {
    expect(parseEmbeddingBackfillArgs([])).toMatchObject({ dryRun: true });
    expect(() => parseEmbeddingBackfillArgs(['--execute'])).toThrow(/--key-file/);
    expect(parseEmbeddingBackfillArgs([
      '--execute',
      '--key-file',
      '/secure/new-gemini-key',
    ])).toMatchObject({
      dryRun: false,
      keyFile: '/secure/new-gemini-key',
    });
  });
});

describe('embedding backfill credential safety', () => {
  it('loads only a mode-0600 regular key file and reports non-secret identity evidence', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cc-memory-backfill-key-'));
    const keyPath = path.join(dir, 'gemini-key');
    await writeFile(keyPath, 'new-secret-key\n', { mode: 0o600 });

    const loaded = await loadEmbeddingBackfillCredential(keyPath, dir);

    expect(loaded.apiKey).toBe('new-secret-key');
    expect(loaded.evidence).toMatchObject({
      source: 'explicit-key-file',
      pathLabel: '~/gemini-key',
      mode: '0600',
    });
    expect(loaded.evidence.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(loaded.evidence)).not.toContain('new-secret-key');
  });

  it('rejects permissive files and symlinks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cc-memory-backfill-key-'));
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    await writeFile(target, 'new-secret-key\n', { mode: 0o600 });
    await chmod(target, 0o644);
    await expect(loadEmbeddingBackfillCredential(target, dir)).rejects.toThrow(/0600/);

    await chmod(target, 0o600);
    await symlink(target, link);
    await expect(loadEmbeddingBackfillCredential(link, dir)).rejects.toThrow(/regular file/);
  });

  it('removes ambient and dotenv key sources before execute', () => {
    const env: NodeJS.ProcessEnv = {
      GEMINI_API_KEY: 'old-exposed-key',
      DOTENV_CONFIG_PATH: '/tmp/untrusted.env',
    };

    isolateEmbeddingBackfillEnvironment(env);

    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.DOTENV_CONFIG_PATH).toBe('/dev/null');
  });

  it('isolates the process environment before importing the embedding module', async () => {
    const env: NodeJS.ProcessEnv = {
      GEMINI_API_KEY: 'old-exposed-key',
      DOTENV_CONFIG_PATH: '/tmp/untrusted.env',
    };
    const importEmbedding = vi.fn(async () => {
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.DOTENV_CONFIG_PATH).toBe('/dev/null');
      return { generateEmbedding: vi.fn() };
    });

    await loadIsolatedEmbeddingGenerator(env, importEmbedding);

    expect(importEmbedding).toHaveBeenCalledTimes(1);
  });
});

function makeStore(records: EmbeddingBackfillRecord[]): EmbeddingBackfillStore {
  return {
    fetchBatch: async ({ target, afterId, limit }) => records
      .filter((record) => record.target === target && (!afterId || record.id > afterId))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit),
    updateEmbedding: vi.fn(async () => {}),
  };
}

describe('embedding backfill runner', () => {
  it('applies limit globally across targets in target order', async () => {
    const store = makeStore([
      {
        target: 'project_memories',
        id: '00000000-0000-0000-0000-000000000001',
        summary: 'rollup first',
        keywords: [],
        decisions: [],
      },
      {
        target: 'observations',
        id: '00000000-0000-0000-0000-000000000002',
        title: 'observation second',
        facts: [],
        narrative: 'detail',
      },
    ]);

    const result = await runEmbeddingBackfill(
      {
        targets: ['project_memories', 'observations'],
        dryRun: true,
        batchSize: 10,
        requestsPerMinute: 60,
        maxConsecutiveFailures: 2,
        limit: 1,
      },
      { store, generateEmbedding: async () => [1, 0] }
    );

    expect(result.scanned).toBe(1);
  });

  it('dry-run scans missing rows without calling Gemini or updating the database', async () => {
    const store = makeStore([
      {
        target: 'project_memories',
        id: '00000000-0000-0000-0000-000000000001',
        summary: 'rollup one',
        keywords: [],
        decisions: [],
      },
      {
        target: 'observations',
        id: '00000000-0000-0000-0000-000000000002',
        title: 'observation two',
        facts: [],
        narrative: 'detail',
      },
    ]);
    const generateEmbedding = vi.fn(async () => [1, 0]);

    const result = await runEmbeddingBackfill(
      {
        targets: ['project_memories', 'observations'],
        dryRun: true,
        batchSize: 1,
        requestsPerMinute: 60,
        maxConsecutiveFailures: 2,
      },
      { store, generateEmbedding, sleep: async () => {} }
    );

    expect(result).toEqual({ scanned: 2, attempted: 0, updated: 0, failed: 0 });
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(store.updateEmbedding).not.toHaveBeenCalled();
  });

  it('uses the capture observation representation and rate-limits keyset batches', async () => {
    const store = makeStore([
      {
        target: 'observations',
        id: '00000000-0000-0000-0000-000000000001',
        title: 'First',
        facts: ['fact one', 'fact two'],
        narrative: 'narrative one',
      },
      {
        target: 'observations',
        id: '00000000-0000-0000-0000-000000000002',
        title: 'Second',
        facts: [],
        narrative: 'narrative two',
      },
    ]);
    const generatedTexts: string[] = [];
    const sleeps: number[] = [];
    const reports: string[] = [];

    const result = await runEmbeddingBackfill(
      {
        targets: ['observations'],
        dryRun: false,
        batchSize: 1,
        requestsPerMinute: 60,
        maxConsecutiveFailures: 2,
      },
      {
        store,
        generateEmbedding: async (text) => {
          generatedTexts.push(text);
          return [1, 0];
        },
        sleep: async (ms) => { sleeps.push(ms); },
        report: (line) => { reports.push(line); },
      }
    );

    expect(result).toEqual({ scanned: 2, attempted: 2, updated: 2, failed: 0 });
    expect(generatedTexts).toEqual([
      'First\nfact one fact two\nnarrative one',
      'Second\n\nnarrative two',
    ]);
    expect(store.updateEmbedding).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
    expect(reports.join('\n')).toContain('progress scanned=2 attempted=2 updated=2 failed=0');
  });

  it('redacts provider input and stores embedding policy evidence without the matched value', async () => {
    const token = `sk-${'d'.repeat(32)}`;
    const store = makeStore([
      {
        target: 'project_memories',
        id: '00000000-0000-0000-0000-000000000001',
        summary: `rotated credential ${token}`,
        keywords: [],
        decisions: [],
      },
    ]);
    const generateEmbedding = vi.fn(async () => [1, 0]);

    await runEmbeddingBackfill(
      {
        targets: ['project_memories'],
        dryRun: false,
        batchSize: 1,
        requestsPerMinute: 60,
        maxConsecutiveFailures: 2,
      },
      { store, generateEmbedding, sleep: async () => {} }
    );

    expect(generateEmbedding).toHaveBeenCalledWith(
      'rotated credential [REDACTED:openai_api_key]'
    );
    expect(store.updateEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      embeddingPolicy: expect.objectContaining({
        redaction_count: 1,
        rule_counts: { openai_api_key: 1 },
        input_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    }));
    expect(JSON.stringify(vi.mocked(store.updateEmbedding).mock.calls)).not.toContain(token);
  });

  it('stops after the configured number of consecutive embedding failures', async () => {
    const store = makeStore([
      {
        target: 'project_memories',
        id: '00000000-0000-0000-0000-000000000001',
        summary: 'first failure',
        keywords: [],
        decisions: [],
      },
      {
        target: 'project_memories',
        id: '00000000-0000-0000-0000-000000000002',
        summary: 'second failure',
        keywords: [],
        decisions: [],
      },
    ]);

    const reports: string[] = [];
    await expect(runEmbeddingBackfill(
      {
        targets: ['project_memories'],
        dryRun: false,
        batchSize: 2,
        requestsPerMinute: 600,
        maxConsecutiveFailures: 2,
      },
      {
        store,
        generateEmbedding: async () => null,
        sleep: async () => {},
        report: (line) => { reports.push(line); },
      }
    )).rejects.toThrow('2 consecutive embedding failures');
    expect(store.updateEmbedding).not.toHaveBeenCalled();
    expect(reports.join('\n')).toContain('target=project_memories');
    expect(reports.join('\n')).toContain('id=00000000-0000-0000-0000-000000000001');
  });

  it('leaves a failed row eligible for a later rerun', async () => {
    const record: EmbeddingBackfillRecord = {
      target: 'project_memories',
      id: '00000000-0000-0000-0000-000000000001',
      summary: 'retry me',
      keywords: [],
      decisions: [],
    };
    let pending = true;
    const store: EmbeddingBackfillStore = {
      fetchBatch: async ({ afterId }) => pending && !afterId ? [record] : [],
      updateEmbedding: vi.fn(async () => { pending = false; }),
    };
    const options = {
      targets: ['project_memories'] as const,
      dryRun: false,
      batchSize: 1,
      requestsPerMinute: 60,
      maxConsecutiveFailures: 2,
    };

    const first = await runEmbeddingBackfill(
      { ...options, targets: [...options.targets] },
      { store, generateEmbedding: async () => null }
    );
    const second = await runEmbeddingBackfill(
      { ...options, targets: [...options.targets] },
      { store, generateEmbedding: async () => [1, 0] }
    );

    expect(first).toMatchObject({ failed: 1, updated: 0 });
    expect(second).toMatchObject({ failed: 0, updated: 1 });
    expect(store.updateEmbedding).toHaveBeenCalledTimes(1);
  });
});
