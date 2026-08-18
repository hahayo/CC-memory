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
  composeObservationEmbeddingText,
  generateEmbedding,
  generateQueryEmbedding,
  mergeEmbeddingPolicyMetadata,
  prepareEmbeddingText,
} from '../../src/utils/embedding.js';

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

    expect(consoleError).toHaveBeenCalledWith('Failed to generate embedding');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('private request body');
    consoleError.mockRestore();
  });
});
