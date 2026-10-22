import { describe, expect, it } from 'vitest';
import { escapeLike, keywordLikePatterns, keywordTerms } from '../../src/utils/keyword-like.js';

describe('utils/keyword-like', () => {
  it('splits on whitespace, lowercases, drops empties', () => {
    expect(keywordTerms('  Step B  殘餘 1,112 ')).toEqual(['step', 'b', '殘餘', '1,112']);
    expect(keywordTerms('   ')).toEqual([]);
  });

  it('escapes LIKE wildcards so user input cannot widen the match', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('produces one %term% pattern per keyword', () => {
    expect(keywordLikePatterns('line-desktop-mcp 50%')).toEqual(['%line-desktop-mcp%', '%50\\%%']);
  });
});
