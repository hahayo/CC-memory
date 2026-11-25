import { describe, expect, it, vi } from 'vitest';

import {
  buildBgeM3UpdateStatement,
  parseBgeM3BackfillArgs,
  runBgeM3Backfill,
  type BgeM3ObservationRow,
  type BgeM3Row,
  type BgeM3BackfillStore,
} from '../../scripts/backfill-bge-m3.js';
import {
  composeEmbeddingText,
  composeObservationEmbeddingText,
  prepareEmbeddingText,
} from '../../src/utils/embedding-text.js';

function observationRow(id: string, narrative: string): BgeM3ObservationRow {
  return {
    id,
    content_hash: `hash-${id}`,
    title: `title ${id}`,
    facts: [`fact ${id}`],
    narrative,
  };
}

function fakeStore(pages: BgeM3Row[][]) {
  const fetchCalls: { target: string; afterId?: string; limit: number }[] = [];
  const updates: { id: string; contentHash: string | null; embedding: number[] }[][] = [];
  let pageIndex = 0;
  const store: BgeM3BackfillStore = {
    async fetchPage({ target, afterId, limit }) {
      fetchCalls.push({ target, afterId, limit });
      const page = pages[pageIndex] ?? [];
      pageIndex += 1;
      return page.slice(0, limit);
    },
    async updateBatch({ rows }) {
      updates.push(rows);
      return rows.length;
    },
  };
  return { store, fetchCalls, updates };
}

function fakeEmbedding(seed = 1): number[] {
  return Array.from({ length: 1024 }, (_, i) => (i % 5 === 0 ? seed : 0.5));
}

const baseOptions = {
  targets: ['observations' as const],
  dryRun: false,
  pageSize: 512,
  batchSize: 32,
  maxConsecutiveFailures: 5,
};

describe('parseBgeM3BackfillArgs', () => {
  it('requires --dsn-file', () => {
    expect(() => parseBgeM3BackfillArgs([])).toThrow('--dsn-file is required');
  });

  it('rejects --batch-size above the service limit', () => {
    expect(() => parseBgeM3BackfillArgs(['--dsn-file', '/tmp/x', '--batch-size', '65']))
      .toThrow('--batch-size must be <= 64');
    expect(() => parseBgeM3BackfillArgs(['--dsn-file=/tmp/x', '--batch-size=64']))
      .not.toThrow();
  });

  it('applies documented defaults and supports --flag=value', () => {
    const parsed = parseBgeM3BackfillArgs(['--dsn-file=/tmp/x'], { EMBEDDING_LOCAL_URL: undefined });
    expect(parsed.dryRun).toBe(true);
    expect(parsed.targets).toEqual(['project_memories', 'observations']);
    expect(parsed.pageSize).toBe(512);
    expect(parsed.batchSize).toBe(32);
    expect(parsed.serviceUrl).toBe('http://127.0.0.1:8790');
    expect(parsed.timeoutMs).toBe(120000);
    expect(parsed.limit).toBeUndefined();
  });

  it('honors --execute, --table, --limit, --service-url, EMBEDDING_LOCAL_URL', () => {
    const parsed = parseBgeM3BackfillArgs(
      ['--dsn-file', '/tmp/x', '--execute', '--table', 'observations',
       '--limit', '7', '--service-url=http://example:9999'],
      { EMBEDDING_LOCAL_URL: 'http://env-url:1' },
    );
    expect(parsed.dryRun).toBe(false);
    expect(parsed.targets).toEqual(['observations']);
    expect(parsed.limit).toBe(7);
    expect(parsed.serviceUrl).toBe('http://example:9999');
    const fromEnv = parseBgeM3BackfillArgs(['--dsn-file', '/tmp/x'], { EMBEDDING_LOCAL_URL: 'http://env-url:1' });
    expect(fromEnv.serviceUrl).toBe('http://env-url:1');
  });
});

describe('buildBgeM3UpdateStatement', () => {
  it('emits one guarded UPDATE with parameterized values only', () => {
    const rows = [
      { id: '11111111-1111-1111-1111-111111111111', contentHash: 'h1', embedding: fakeEmbedding(1) },
      { id: '22222222-2222-2222-2222-222222222222', contentHash: null, embedding: fakeEmbedding(2) },
    ];
    const { text, params } = buildBgeM3UpdateStatement('observations', rows);
    expect(text.trim().startsWith('UPDATE observations AS t')).toBe(true);
    expect(text).toContain('t.embedding_bge_m3 IS NULL');
    expect(text).toContain('t.content_hash IS NOT DISTINCT FROM v.content_hash');
    expect(text).toContain('v.embedding::vector');
    expect((text.match(/;/g) ?? []).length).toBe(0);
    expect(params).toHaveLength(6);
    expect(params[0]).toBe(rows[0].id);
    expect(params[1]).toBe('h1');
    expect(params[2]).toBe(JSON.stringify(rows[0].embedding));
    expect(text).not.toContain(rows[0].id);
    expect(text).not.toContain('h1');
    expect(text).not.toContain('0.5');
  });
});

describe('runBgeM3Backfill', () => {
  it('dry-run scans and counts batches without embed or update calls', async () => {
    const rows = Array.from({ length: 70 }, (_, i) => observationRow(`id-${i}`, `n${i}`));
    const { store } = fakeStore([rows, []]);
    const embed = vi.fn(async () => [fakeEmbedding()]);
    const result = await runBgeM3Backfill(
      { ...baseOptions, dryRun: true, batchSize: 64 },
      { store, embed },
    );
    expect(result.status).toBe('completed');
    expect(result.total.scanned).toBe(70);
    expect(result.total.batches).toBe(2);
    expect(result.total.updated).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('sorts by text length ascending within a page before batching', async () => {
    const rows = [
      observationRow('a-long', 'x'.repeat(400)),
      observationRow('b-short', 'y'.repeat(5)),
      observationRow('c-mid', 'z'.repeat(100)),
    ];
    const { store } = fakeStore([rows, []]);
    const seen: string[][] = [];
    const embed = vi.fn(async (texts: string[]) => {
      seen.push(texts);
      return texts.map(() => fakeEmbedding());
    });
    await runBgeM3Backfill(
      { ...baseOptions, batchSize: 32 },
      { store, embed },
    );
    const lengths = seen[0].map((t) => t.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  it('splits batches on the byte cap as well as batch size', async () => {
    // 每筆 ~0.8 MiB → 兩筆超過 1.5 MiB 上限，應拆成各自的 batch
    const big = 'q'.repeat(800 * 1024);
    const rows = [
      observationRow('r1', big),
      observationRow('r2', big),
      observationRow('r3', 'small'),
    ];
    const { store } = fakeStore([rows, []]);
    const batchSizes: number[] = [];
    const embed = vi.fn(async (texts: string[]) => {
      batchSizes.push(texts.length);
      return texts.map(() => fakeEmbedding());
    });
    const result = await runBgeM3Backfill(
      { ...baseOptions, batchSize: 64 },
      { store, embed },
    );
    expect(result.status).toBe('completed');
    expect(batchSizes).toEqual([2, 1]);
    expect(result.total.updated).toBe(3);
  });

  it('retries once after a 5s sleep and succeeds', async () => {
    const rows = [observationRow('r1', 'n')];
    const { store, updates } = fakeStore([rows, []]);
    const sleeps: number[] = [];
    let calls = 0;
    const embed = vi.fn(async (texts: string[]) => {
      calls += 1;
      if (calls === 1) return null;
      return texts.map(() => fakeEmbedding());
    });
    const result = await runBgeM3Backfill(baseOptions, {
      store,
      embed,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.status).toBe('completed');
    expect(sleeps).toEqual([5000]);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(result.total.updated).toBe(1);
    expect(updates).toHaveLength(1);
  });

  it('counts a failed batch after both attempts and continues', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => observationRow(`id-${i}`, 'n'));
    const { store } = fakeStore([rows, []]);
    let calls = 0;
    const embed = vi.fn(async (texts: string[]) => {
      calls += 1;
      if (calls <= 2) throw new Error('boom');
      return texts.map(() => fakeEmbedding());
    });
    const result = await runBgeM3Backfill(
      { ...baseOptions, batchSize: 2 },
      { store, embed, sleep: async () => {} },
    );
    expect(result.status).toBe('completed');
    expect(result.total.failed_batches).toBe(1);
    expect(result.total.failed_rows).toBe(2);
    expect(result.total.updated).toBe(2);
  });

  it('aborts after 5 consecutive failed batches and stops fetching', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => observationRow(`id-${i}`, 'n'));
    const { store, fetchCalls } = fakeStore([rows, rows, []]);
    const embed = vi.fn(async () => null);
    const result = await runBgeM3Backfill(
      { ...baseOptions, batchSize: 2 },
      { store, embed, sleep: async () => {} },
    );
    expect(result.status).toBe('aborted');
    expect(result.total.failed_batches).toBe(5);
    expect(fetchCalls).toHaveLength(1);
  });

  it('counts skipped_changed when updateBatch writes fewer rows', async () => {
    const rows = [observationRow('r1', 'n'), observationRow('r2', 'n')];
    const { store } = fakeStore([rows, []]);
    const origUpdate = store.updateBatch.bind(store);
    store.updateBatch = async (input) => { await origUpdate(input); return input.rows.length - 1; };
    const embed = vi.fn(async (texts: string[]) => texts.map(() => fakeEmbedding()));
    const result = await runBgeM3Backfill(baseOptions, { store, embed });
    expect(result.total.updated).toBe(1);
    expect(result.total.skipped_changed).toBe(1);
  });

  it('advances afterId to the last id of each page (keyset)', async () => {
    const page1 = [observationRow('id-1', 'n'), observationRow('id-2', 'n')];
    const { store, fetchCalls } = fakeStore([page1, []]);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => fakeEmbedding()));
    await runBgeM3Backfill({ ...baseOptions, pageSize: 2 }, { store, embed });
    expect(fetchCalls[0].afterId).toBeUndefined();
    expect(fetchCalls[1].afterId).toBe('id-2');
  });

  it('respects --limit across pages', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => observationRow(`id-${i}`, 'n'));
    const { store, fetchCalls } = fakeStore([rows, rows, []]);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => fakeEmbedding()));
    const result = await runBgeM3Backfill(
      { ...baseOptions, pageSize: 2, limit: 3 },
      { store, embed },
    );
    expect(result.total.scanned).toBe(3);
    expect(fetchCalls[1].limit).toBe(1);
    expect(fetchCalls).toHaveLength(2);
  });

  it('stops after the current batch when shouldStop fires', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => observationRow(`id-${i}`, 'n'));
    const { store } = fakeStore([rows, rows, []]);
    let calls = 0;
    const embed = vi.fn(async (texts: string[]) => {
      calls += 1;
      return texts.map(() => fakeEmbedding());
    });
    const result = await runBgeM3Backfill(
      { ...baseOptions, batchSize: 2 },
      { store, embed, shouldStop: () => calls >= 1 },
    );
    expect(result.status).toBe('interrupted');
    expect(result.total.updated).toBe(2);
  });

  it('composes text identical to the live paths, with redaction applied', async () => {
    const memoryRow = {
      id: 'm1',
      content_hash: 'h',
      summary: 'architecture summary',
      keywords: null,
      decisions: ['ship it'],
    };
    const obsRow = observationRow('o1', `token sk-${'c'.repeat(32)}`);
    const sent: string[] = [];
    const embed = vi.fn(async (texts: string[]) => {
      sent.push(...texts);
      return texts.map(() => fakeEmbedding());
    });
    const { store: memoryStore } = fakeStore([[memoryRow], []]);
    await runBgeM3Backfill(
      { ...baseOptions, targets: ['project_memories'] },
      { store: memoryStore, embed },
    );
    const { store: obsStore } = fakeStore([[obsRow], []]);
    await runBgeM3Backfill(baseOptions, { store: obsStore, embed });

    const expectedMemory = prepareEmbeddingText(
      composeEmbeddingText('architecture summary', undefined, ['ship it'])).text;
    const expectedObs = prepareEmbeddingText(
      composeObservationEmbeddingText({
        title: obsRow.title,
        facts: obsRow.facts,
        narrative: obsRow.narrative,
      })).text;
    expect(sent).toContain(expectedMemory);
    expect(sent).toContain(expectedObs);
    expect(sent.join(' ')).not.toContain(`sk-${'c'.repeat(32)}`);
  });

  it('report lines carry counters only, never row text', async () => {
    const marker = 'unique-narrative-marker-12345';
    const rows = [observationRow('r1', marker)];
    const { store } = fakeStore([rows, []]);
    const lines: string[] = [];
    const embed = vi.fn(async (texts: string[]) => texts.map(() => fakeEmbedding()));
    await runBgeM3Backfill(baseOptions, {
      store,
      embed,
      report: (line) => lines.push(line),
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('table=observations');
    expect(lines.join('\n')).toContain('scanned=1');
    expect(lines.join('\n')).not.toContain(marker);
    expect(lines.join('\n')).not.toContain('r1');
  });
});
