import { describe, expect, it } from 'vitest';
import { bucketKeys, metrics } from './analytics.service.js';

const wib = (s: string) => new Date(`${s}+07:00`);

describe('metrics', () => {
  const r = { total: 10, positive: 4, neutral: 4, negative: 2 };
  it('counts neutral in the Net Sentiment base by default', () => {
    expect(metrics(r).netSentiment).toBe(20);
  });
  it('can leave neutral out of the base (positive + negative only)', () => {
    expect(metrics(r, false).netSentiment).toBe(33.3);
  });
});

describe('bucketKeys', () => {
  const from = wib('2026-09-29T00:00:00');
  const to = wib('2026-10-02T00:00:00'); // three WIB days

  it('lists WIB days and hours', () => {
    expect(bucketKeys(from, to, 'day')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ]);
    const hours = bucketKeys(from, to, 'hour');
    expect(hours).toHaveLength(72);
    expect(hours[0]).toBe('2026-09-29 00:00');
    expect(hours.at(-1)).toBe('2026-10-01 23:00');
  });

  it('starts weeks on Monday and groups months, quarters and years', () => {
    expect(bucketKeys(from, to, 'week')).toEqual(['2026-09-28']);
    expect(bucketKeys(from, to, 'month')).toEqual(['2026-09', '2026-10']);
    expect(bucketKeys(from, to, 'quarter')).toEqual(['2026-Q3', '2026-Q4']);
    expect(bucketKeys(from, to, 'year')).toEqual(['2026']);
  });
});
