// tests/db/embedding-column.test.ts — provider → 實體欄位對映（不需要 DB 連線）
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  embeddingColumnSql,
  embeddingFieldKey,
  inactiveEmbeddingColumnSql,
  memoryEmbeddingColumn,
  observationEmbeddingColumn,
} from '../../src/db/embedding-column.js';
import { observations, projectMemories } from '../../src/db/schema.js';

const dialect = new PgDialect();
const sqlText = (s: Parameters<typeof dialect.sqlToQuery>[0]) =>
  dialect.sqlToQuery(s).sql;

describe('memoryEmbeddingColumn / observationEmbeddingColumn', () => {
  it('gemini maps to the existing 1536-dim embedding column', () => {
    expect(memoryEmbeddingColumn('gemini')).toBe(projectMemories.embedding);
    expect(observationEmbeddingColumn('gemini')).toBe(observations.embedding);
  });

  it('local maps to the 1024-dim embedding_bge_m3 column', () => {
    expect(memoryEmbeddingColumn('local')).toBe(projectMemories.embeddingBgeM3);
    expect(observationEmbeddingColumn('local')).toBe(observations.embeddingBgeM3);
  });
});

describe('embeddingFieldKey', () => {
  it('returns the drizzle insert property key', () => {
    expect(embeddingFieldKey('gemini')).toBe('embedding');
    expect(embeddingFieldKey('local')).toBe('embeddingBgeM3');
  });
});

describe('embeddingColumnSql', () => {
  it('renders the physical column identifier for raw SQL writes', () => {
    expect(sqlText(embeddingColumnSql('gemini'))).toBe('"embedding"');
    expect(sqlText(embeddingColumnSql('local'))).toBe('"embedding_bge_m3"');
  });
});

describe('inactiveEmbeddingColumnSql', () => {
  it('renders the other provider column identifier', () => {
    expect(sqlText(inactiveEmbeddingColumnSql('gemini'))).toBe('"embedding_bge_m3"');
    expect(sqlText(inactiveEmbeddingColumnSql('local'))).toBe('"embedding"');
  });

  it('always differs from the active column', () => {
    for (const provider of ['gemini', 'local'] as const) {
      expect(sqlText(inactiveEmbeddingColumnSql(provider))).not.toBe(
        sqlText(embeddingColumnSql(provider))
      );
    }
  });
});
