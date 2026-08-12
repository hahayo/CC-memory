import { describe, expect, it } from 'vitest';
import { composeObservationEmbeddingText } from '../../src/utils/embedding.js';

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
