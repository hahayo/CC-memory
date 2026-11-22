// tests/utils/embedding-provider.test.ts — EMBEDDING_PROVIDER 解析與 isEmbeddingConfigured
import { describe, expect, it } from 'vitest';

import {
  LOCAL_EMBEDDING_DIMENSIONS,
  embeddingColumnName,
  isEmbeddingConfigured,
  parseEmbeddingLocalTimeoutMs,
  resolveEmbeddingProvider,
} from '../../src/utils/embedding-provider.js';

describe('resolveEmbeddingProvider', () => {
  it('defaults to gemini when unset, empty, or "gemini"', () => {
    expect(resolveEmbeddingProvider({})).toBe('gemini');
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: '' })).toBe('gemini');
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: 'gemini' })).toBe('gemini');
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: '  GEMINI ' })).toBe('gemini');
  });

  it('resolves local case-insensitively with whitespace', () => {
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: 'local' })).toBe('local');
    expect(resolveEmbeddingProvider({ EMBEDDING_PROVIDER: ' LOCAL ' })).toBe('local');
  });

  it('throws on invalid values without echoing the value', () => {
    for (const bad of ['openai', 'bge-m3', '0', 'localx']) {
      expect(() => resolveEmbeddingProvider({ EMBEDDING_PROVIDER: bad })).toThrow(
        'Invalid EMBEDDING_PROVIDER (expected gemini|local)'
      );
      expect(() => resolveEmbeddingProvider({ EMBEDDING_PROVIDER: bad })).toThrowError(
        expect.objectContaining({ message: expect.not.stringContaining(bad) })
      );
    }
  });
});

describe('isEmbeddingConfigured', () => {
  it('is true for local even without a Gemini key', () => {
    expect(isEmbeddingConfigured({ EMBEDDING_PROVIDER: 'local' })).toBe(true);
  });

  it('is false for gemini without a key', () => {
    expect(isEmbeddingConfigured({})).toBe(false);
    expect(isEmbeddingConfigured({ GEMINI_API_KEY: '   ' })).toBe(false);
  });

  it('is true for gemini with a key', () => {
    expect(isEmbeddingConfigured({ GEMINI_API_KEY: 'key' })).toBe(true);
  });
});

describe('embeddingColumnName', () => {
  it('maps providers to the physical column', () => {
    expect(embeddingColumnName('gemini')).toBe('embedding');
    expect(embeddingColumnName('local')).toBe('embedding_bge_m3');
  });

  it('pins the local dimension to the 0014 migration vector width', () => {
    expect(LOCAL_EMBEDDING_DIMENSIONS).toBe(1024);
  });
});

describe('parseEmbeddingLocalTimeoutMs', () => {
  it('returns 30000 for undefined, empty, and malformed values', () => {
    for (const raw of [undefined, '', '30s', '2.5', '-1', ' 100', '1e3', '0x10']) {
      expect(parseEmbeddingLocalTimeoutMs(raw)).toBe(30000);
    }
  });

  it('rejects out-of-range values', () => {
    expect(parseEmbeddingLocalTimeoutMs('0')).toBe(30000);
    expect(parseEmbeddingLocalTimeoutMs('600001')).toBe(30000);
  });

  it('accepts integers in 1..600000', () => {
    expect(parseEmbeddingLocalTimeoutMs('1')).toBe(1);
    expect(parseEmbeddingLocalTimeoutMs('45000')).toBe(45000);
    expect(parseEmbeddingLocalTimeoutMs('600000')).toBe(600000);
  });
});
