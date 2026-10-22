import { mapHeaders } from './excel-columns.js';
import {
  asList,
  categoriesOf,
  followersFor,
  parseChannel,
  parsePublishedAt,
  parseSentimentLabel,
} from './excel-parsers.js';

describe('Zanroo Excel parsers', () => {
  it('joins date, time and +0700 offset into one UTC instant', () => {
    expect(
      parsePublishedAt('2026-09-01', '00:00:07', '+0700').toISOString(),
    ).toBe('2026-08-31T17:00:07.000Z');
  });

  it('accepts real Excel date cells (wall-clock labelled UTC)', () => {
    const date = new Date(Date.UTC(2026, 8, 1));
    expect(parsePublishedAt(date, '08:30', '+0700').toISOString()).toBe(
      '2026-09-01T01:30:00.000Z',
    );
  });

  it('rejects malformed dates', () => {
    expect(() => parsePublishedAt('01/09/2026', '00:00:00', '+0700')).toThrow(
      'invalid date',
    );
  });

  it('maps every channel found in the September export', () => {
    expect(
      [
        'tiktok',
        'X(twitter)',
        'facebook',
        'youtube',
        'instagram',
        'news',
        'blog',
      ].map(parseChannel),
    ).toEqual([
      'TIKTOK',
      'X',
      'FACEBOOK',
      'YOUTUBE',
      'INSTAGRAM',
      'ONLINE_NEWS',
      'BLOG',
    ]);
    expect(() => parseChannel('myspace')).toThrow('unknown channel');
  });

  it('parses sentiment labels case-insensitively', () => {
    expect(parseSentimentLabel('Positive')).toBe('POSITIVE');
    expect(() => parseSentimentLabel('Mixed')).toThrow();
  });

  it('splits comma lists and drops blanks', () => {
    expect(asList('Telkomsel,Telkomsel, IM3 ,')).toEqual([
      'Telkomsel',
      'Telkomsel',
      'IM3',
    ]);
  });

  it('reads followers from the column of the mention channel only', () => {
    expect(followersFor('X', { f_x: '1131764', f_tiktok: '5' })).toBe(1131764);
    expect(
      followersFor('TIKTOK', { f_x: '1131764', f_tiktok: '0' }),
    ).toBeUndefined();
    expect(followersFor('ONLINE_NEWS', { f_x: '9' })).toBeUndefined();
  });

  it('maps the Zanroo header and keeps category labels set to 1', () => {
    const header = [
      undefined,
      'CreatedDate',
      'CreatedTime',
      'Channel',
      'Sentiments',
      'Keyword',
      'MID',
      'NETWORK (Category Label)',
      'PRICING (Category Label)',
    ];
    const h = mapHeaders(header);
    expect(h.missing).toEqual([]);
    expect(h.columns.get('id')).toBe(6);
    expect(
      categoriesOf([undefined, '', '', '', '', '', '', '1', '0'], h.categories),
    ).toEqual(['NETWORK']);
  });

  it('reports missing required columns', () => {
    expect(mapHeaders(['CreatedDate', 'Channel']).missing).toEqual([
      'id',
      'sentiment',
      'keyword',
    ]);
  });
});
