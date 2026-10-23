import { describe, expect, it } from 'vitest';
import {
  MAX_KEYWORD_TERMS,
  escapeLike,
  keywordLikePatterns,
  keywordTerms,
} from '../../src/utils/keyword-like.js';

describe('utils/keyword-like', () => {
  it('splits on whitespace, drops empties, keeps case (ILIKE folds on the DB side)', () => {
    expect(keywordTerms('  Step B  殘餘 1,112 ')).toEqual(['Step', 'B', '殘餘', '1,112']);
    expect(keywordTerms('   ')).toEqual([]);
  });

  it('dedupes repeated terms and caps the count', () => {
    expect(keywordTerms('a b a c b')).toEqual(['a', 'b', 'c']);
    const many = Array.from({ length: MAX_KEYWORD_TERMS + 5 }, (_, i) => `t${i}`).join(' ');
    expect(keywordTerms(many)).toHaveLength(MAX_KEYWORD_TERMS);
  });

  it('escapes LIKE wildcards so user input cannot widen the match', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('produces one %term% pattern per keyword', () => {
    expect(keywordLikePatterns('line-desktop-mcp 50%')).toEqual(['%line-desktop-mcp%', '%50\\%%']);
  });
});
