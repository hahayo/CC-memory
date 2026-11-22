import { beforeEach, describe, expect, it, vi } from 'vitest';

const { embedContent } = vi.hoisted(() => ({
  embedContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { embedContent };
  },
}));

import {
  isEmbeddingEnabled,
  composeObservationEmbeddingText,
  generateEmbedding,
  generateQueryEmbedding,
  mergeEmbeddingPolicyMetadata,
  prepareEmbeddingText,
} from '../../src/utils/embedding.js';
import { config } from '../../src/config.js';

beforeEach(() => {
  embedContent.mockReset();
});

describe('observation embedding text', () => {
  it('uses the same title, facts, and narrative representation for capture and backfill', () => {
    expect(composeObservationEmbeddingText({
      title: 'Fixed capture recovery',
      facts: ['pathless records do not consume the LLM budget', 'checkpoint remains monotonic'],
      narrative: 'The worker drains unrecoverable metadata without losing processable sessions.',
    })).toBe(
      'Fixed capture recovery\n' +
      'pathless records do not consume the LLM budget checkpoint remains monotonic\n' +
      'The worker drains unrecoverable metadata without losing processable sessions.'
    );
  });
});

describe('embedding egress redaction', () => {
  it('is deterministic, idempotent, and leaves clean text unchanged', () => {
    const googleKey = `AIza${'A'.repeat(32)}`;
    const githubToken = `ghp_${'b'.repeat(36)}`;
    const input = `Deploy with ${googleKey}; token ${githubToken}; password=long-secret-value`;

    const first = prepareEmbeddingText(input);
    const second = prepareEmbeddingText(input);
    const repeated = prepareEmbeddingText(first.text);
    const clean = prepareEmbeddingText('ordinary architecture decision');

    expect(first).toEqual(second);
    expect(first.text).not.toContain(googleKey);
    expect(first.text).not.toContain(githubToken);
    expect(first.text).toContain('password=[REDACTED:labeled_secret]');
    expect(first.text).not.toContain('$1$2');
    expect(first.evidence.redaction_count).toBe(3);
    expect(first.evidence.rule_counts).toEqual({
      google_api_key: 1,
      github_token: 1,
      labeled_secret: 1,
    });
    expect(first.evidence.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated.text).toBe(first.text);
    expect(repeated.evidence.redaction_count).toBe(0);
    expect(clean.text).toBe('ordinary architecture decision');
    expect(clean.evidence.redaction_count).toBe(0);
  });

  it('redacts document and query text before the provider sees it', async () => {
    const token = `sk-${'c'.repeat(32)}`;
    embedContent.mockResolvedValue({ embeddings: [{ values: [3, 4] }] });

    await generateEmbedding(`document ${token}`, { apiKey: 'test-key' });
    await generateQueryEmbedding(`find ${token}`, { apiKey: 'test-key' });

    expect(embedContent).toHaveBeenCalledTimes(2);
    expect(embedContent.mock.calls[0][0].contents).not.toContain(token);
    expect(embedContent.mock.calls[0][0].contents).toContain('[REDACTED:openai_api_key]');
    expect(embedContent.mock.calls[0][0].config.taskType).toBe('RETRIEVAL_DOCUMENT');
    expect(embedContent.mock.calls[1][0].contents).not.toContain(token);
    expect(embedContent.mock.calls[1][0].contents).toContain('[REDACTED:openai_api_key]');
    expect(embedContent.mock.calls[1][0].config.taskType).toBe('RETRIEVAL_QUERY');
  });

  it('redacts quoted and JSON labeled secrets idempotently', () => {
    const password = 'hunter2secret99';
    const apiKey = '9f8e7d6c5b4a3210';
    const input = `password: "${password}"\n{"api_key": "${apiKey}"}`;

    const first = prepareEmbeddingText(input);
    const repeated = prepareEmbeddingText(first.text);

    expect(first.text).toBe(
      'password: "[REDACTED:labeled_secret]"\n{"api_key": "[REDACTED:labeled_secret]"}'
    );
    expect(first.text).not.toContain(password);
    expect(first.text).not.toContain(apiKey);
    expect(first.evidence).toMatchObject({
      redaction_count: 2,
      rule_counts: { labeled_secret: 2 },
    });
    expect(repeated.text).toBe(first.text);
    expect(repeated.evidence.redaction_count).toBe(0);
  });

  it('redacts labeled secrets with multi-segment environment prefixes', () => {
    const secret = 'my-secret-password';

    const prepared = prepareEmbeddingText(`MYSQL_ROOT_PASSWORD=${secret}`);

    expect(prepared.text).toBe('MYSQL_ROOT_PASSWORD=[REDACTED:labeled_secret]');
    expect(prepared.text).not.toContain(secret);
    expect(prepared.evidence).toMatchObject({
      redaction_count: 1,
      rule_counts: { labeled_secret: 1 },
    });
  });

  it('merges policy evidence without mutating or replacing existing metadata', () => {
    const original = { capture: { version: '0.5' }, owner: 'operator' };
    const evidence = prepareEmbeddingText('clean input').evidence;

    const merged = mergeEmbeddingPolicyMetadata(original, evidence);

    expect(merged).toEqual({
      capture: { version: '0.5' },
      owner: 'operator',
      embedding_policy: evidence,
    });
    expect(original).toEqual({ capture: { version: '0.5' }, owner: 'operator' });
  });

  it('does not log provider error details that could echo request content', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    embedContent.mockRejectedValue(new Error('provider echoed private request body'));

    await expect(generateEmbedding('safe input', { apiKey: 'test-key' })).resolves.toBeNull();

    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^Failed to generate embedding \(Error\)$/));
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('private request body');
    consoleError.mockRestore();
  });

  it('does not log a provider-controlled error name and only logs a numeric status', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostile = Object.assign(new Error('x'), { name: 'private request body', status: 429 });
    embedContent.mockRejectedValue(hostile);

    await expect(generateEmbedding('safe input', { apiKey: 'test-key' })).resolves.toBeNull();

    expect(consoleError).toHaveBeenCalledWith('Failed to generate embedding (Error status=429)');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('private request body');
    consoleError.mockRestore();
  });
});

describe('local embedding provider (EMBEDDING_PROVIDER=local)', () => {
  const saved = {
    provider: config.embeddingProvider,
    url: config.embeddingLocalUrl,
    timeout: config.embeddingLocalTimeoutMs,
    key: config.geminiApiKey,
  };

  function useLocal(overrides: Partial<typeof config> = {}) {
    config.embeddingProvider = 'local';
    config.embeddingLocalUrl = 'http://127.0.0.1:8790/';
    config.embeddingLocalTimeoutMs = 500;
    config.geminiApiKey = undefined;
    Object.assign(config, overrides);
  }

  function restore() {
    config.embeddingProvider = saved.provider;
    config.embeddingLocalUrl = saved.url;
    config.embeddingLocalTimeoutMs = saved.timeout;
    config.geminiApiKey = saved.key;
    vi.unstubAllGlobals();
  }

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

  it('POSTs redacted text to /embed and returns a normalized 1024-dim vector', async () => {
    useLocal();
    const fetchMock = stubFetchResponse({ embeddings: [fakeVector()] });
    try {
      const googleKey = `AIza${'K'.repeat(32)}`;
      const result = await generateEmbedding(`secret ${googleKey} here`);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(1024);
      const norm = Math.sqrt(result!.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 6);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
      expect(url).toBe('http://127.0.0.1:8790/embed');
      expect(init.method).toBe('POST');
      expect(init.body).toContain('[REDACTED:google_api_key]');
      expect(init.body).not.toContain(googleKey);
    } finally { restore(); }
  });

  it('query variant hits the same endpoint', async () => {
    useLocal();
    const fetchMock = stubFetchResponse({ embeddings: [fakeVector()] });
    try {
      const result = await generateQueryEmbedding('find something');
      expect(result).toHaveLength(1024);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:8790/embed');
    } finally { restore(); }
  });

  it('returns null and logs status on HTTP errors without leaking text', async () => {
    useLocal();
    stubFetchResponse({ error: 'x' }, { ok: false, status: 500 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await generateEmbedding('sensitive payload zzz');
      expect(result).toBeNull();
      const logged = consoleError.mock.calls.flat().join(' ');
      expect(logged).toContain('LocalEmbeddingHttpError status=500');
      expect(logged).not.toContain('sensitive payload zzz');
    } finally { consoleError.mockRestore(); restore(); }
  });

  it('returns null on timeout', async () => {
    useLocal({ embeddingLocalTimeoutMs: 20 });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('The operation timed out', 'TimeoutError')));
      })
    ));
    try {
      const result = await generateEmbedding('anything');
      expect(result).toBeNull();
    } finally { restore(); }
  });

  it('returns null when the response has the wrong dimension', async () => {
    useLocal();
    stubFetchResponse({ embeddings: [fakeVector(1536)] });
    try {
      expect(await generateEmbedding('anything')).toBeNull();
    } finally { restore(); }
  });

  it('returns null when the response advertises a different model', async () => {
    useLocal();
    stubFetchResponse({ model: 'BAAI/bge-small-en-v1.5', embeddings: [fakeVector()] });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await generateEmbedding('anything')).toBeNull();
      expect(consoleError.mock.calls.flat().join(' ')).toContain('LocalEmbeddingInvalidResponse');
    } finally { consoleError.mockRestore(); restore(); }
  });

  it('returns null on an all-zero vector', async () => {
    useLocal();
    stubFetchResponse({ embeddings: [new Array(1024).fill(0)] });
    try {
      expect(await generateEmbedding('anything')).toBeNull();
    } finally { restore(); }
  });

  it('returns null when the vector norm overflows to Infinity', async () => {
    useLocal();
    stubFetchResponse({ embeddings: [new Array(1024).fill(Number.MAX_VALUE)] });
    try {
      expect(await generateEmbedding('anything')).toBeNull();
    } finally { restore(); }
  });

  it('isEmbeddingEnabled is true with local provider and no key', async () => {
    useLocal();
    try {
      expect(isEmbeddingEnabled()).toBe(true);
    } finally { restore(); }
  });
});
