import { describe, expect, it } from 'vitest';
import { cleanList, keywordPattern, ruleCondition } from './category-rules.js';

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

  it('matches picked Zanroo names on tags, category labels and the Keyword column', () => {
    const sql = ruleCondition({
      zanrooTags: ['Activation Tri'],
      keywords: [],
    })!;
    expect(sql.sql).toContain("'$.categories'");
    expect(sql.sql).toContain("'$.keywords'");
    expect(sql.values).toContain('["Activation Tri"]');
  });
});
