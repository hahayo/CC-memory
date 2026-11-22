import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_EMBEDDING_MAX_BATCH,
  requestLocalEmbeddings,
} from '../../src/utils/local-embedding.js';

function fakeVector(length = 1024, seed = 3): number[] {
  return Array.from({ length }, (_, i) => (i % 7 === 0 ? seed : 1));
}

function stubFetchResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ model: 'BAAI/bge-m3', dimensions: 1024, ...body as Record<string, unknown> }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const options = { url: 'http://127.0.0.1:8790/', timeoutMs: 500 };

describe('requestLocalEmbeddings', () => {
  it('returns one normalized vector per input text', async () => {
    const fetchMock = stubFetchResponse({ embeddings: [fakeVector(), fakeVector(1024, 5)] });
    try {
      const result = await requestLocalEmbeddings(['alpha', 'beta'], options);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      for (const vector of result!) {
        expect(vector).toHaveLength(1024);
        const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
        expect(norm).toBeCloseTo(1, 6);
      }
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
      expect(url).toBe('http://127.0.0.1:8790/embed');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ inputs: ['alpha', 'beta'] });
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns null when embedding count does not match input count', async () => {
    stubFetchResponse({ embeddings: [fakeVector()] });
    try {
      expect(await requestLocalEmbeddings(['a', 'b'], options)).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns null when the response advertises a different model', async () => {
    stubFetchResponse({ model: 'BAAI/bge-small-en-v1.5', embeddings: [fakeVector()] });
    try {
      expect(await requestLocalEmbeddings(['a'], options)).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns null on wrong dimension, NaN, and zero vectors', async () => {
    stubFetchResponse({ embeddings: [fakeVector(1536)] });
    try {
      expect(await requestLocalEmbeddings(['a'], options)).toBeNull();
    } finally { vi.unstubAllGlobals(); }

    const nanVector = fakeVector();
    nanVector[10] = Number.NaN;
    stubFetchResponse({ embeddings: [nanVector] });
    try {
      expect(await requestLocalEmbeddings(['a'], options)).toBeNull();
    } finally { vi.unstubAllGlobals(); }

    stubFetchResponse({ embeddings: [new Array(1024).fill(0)] });
    try {
      expect(await requestLocalEmbeddings(['a'], options)).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns null on HTTP errors without leaking text', async () => {
    stubFetchResponse({ error: 'x' }, { ok: false, status: 500 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await requestLocalEmbeddings(['sensitive payload zzz'], options);
      expect(result).toBeNull();
      const logged = consoleError.mock.calls.flat().join(' ');
      expect(logged).toContain('LocalEmbeddingHttpError status=500');
      expect(logged).not.toContain('sensitive payload zzz');
    } finally { consoleError.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('returns null when fetch throws without leaking text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused sensitive payload zzz');
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await requestLocalEmbeddings(['sensitive payload zzz'], options)).toBeNull();
      const logged = consoleError.mock.calls.flat().join(' ');
      expect(logged).not.toContain('sensitive payload zzz');
      expect(logged).not.toContain('connection refused');
    } finally { consoleError.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('returns null without any HTTP request for empty or oversized batches', async () => {
    const fetchMock = stubFetchResponse({ embeddings: [fakeVector()] });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await requestLocalEmbeddings([], options)).toBeNull();
      const oversized = Array.from({ length: LOCAL_EMBEDDING_MAX_BATCH + 1 }, (_, i) => `t${i}`);
      expect(await requestLocalEmbeddings(oversized, options)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); vi.unstubAllGlobals(); }
  });
});
