import { describe, expect, it } from 'vitest';
import { inheritDate } from './excel-ingestion.source.js';
import { mergeByExternalId } from '../../../mentions/mention.repository.js';
import type { ResolvedMention } from '../../domain/normalized-mention.js';

describe('inheritDate', () => {
  it('fills a blank date from the previous row with the same MID', () => {
    const parent = {};
    inheritDate({ id: 'm1', date: '2026-07-01', time: '10:00:00', tz: '+0700' }, parent);
    const row: Record<string, unknown> = { id: 'm1', date: '' };
    inheritDate(row, parent);
    expect(row).toMatchObject({ date: '2026-07-01', time: '10:00:00', tz: '+0700' });
  });

  it('leaves a blank date alone when the MID differs', () => {
    const parent = {};
    inheritDate({ id: 'm1', date: '2026-07-01', time: '10:00:00', tz: '+0700' }, parent);
    const row: Record<string, unknown> = { id: 'm2', date: '' };
    inheritDate(row, parent);
    expect(row.date).toBe('');
  });
});

describe('mergeByExternalId', () => {
  const item = (id: string, kw: string, brandIds: number[], tags?: string[]) =>
    ({ brandIds, mention: { externalId: id, brandKeywords: [kw], tags } }) as unknown as ResolvedMention;

  it('merges brands, keywords and tags of rows with the same MID', () => {
    const out = mergeByExternalId([
      item('m1', 'PT RAL', [1], ['Nelayan']),
      item('m1', 'ARSR', [1, 2], ['Lingkungan']),
      item('m2', 'PT RAL', [1]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].brandIds).toEqual([1, 2]);
    expect(out[0].mention.brandKeywords).toEqual(['PT RAL', 'ARSR']);
    expect(out[0].mention.tags).toEqual(['Nelayan', 'Lingkungan']);
  });
});
