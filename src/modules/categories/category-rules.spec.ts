import { describe, expect, it } from 'vitest';
import { cleanList, keywordPattern } from './category-rules.js';

describe('category rules', () => {
  it('cleans lists: trims, collapses spaces, drops duplicates in any case', () => {
    expect(
      cleanList(['  Sinyal ', 'sinyal', '', 'no   service', 'Lemot'], 60),
    ).toEqual(['Sinyal', 'no service', 'Lemot']);
  });

  it('builds one whole-word pattern and escapes regex characters', () => {
    expect(keywordPattern([])).toBeNull();
    expect(keywordPattern(['sinyal', 'c++', '#myim3'])).toBe(
      '(^|[^[:alnum:]_])(sinyal|c\\+\\+|#myim3)($|[^[:alnum:]_])',
    );
  });
});
