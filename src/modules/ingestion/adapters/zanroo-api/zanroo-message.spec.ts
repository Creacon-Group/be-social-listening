import { describe, expect, it } from 'vitest';
import { extractMessages, zanrooMessageToRecord } from './zanroo-message.js';

// Shape copied from a Zanroo Listening sample payload; values made up.
const post = {
  id: '460_fb_111_222',
  mid: 'fb_111_222',
  platform: 'facebook',
  channel: 'facebook',
  topic: 'Added',
  desc: 'Promo kuota baru #BrandA',
  link: 'https://www.facebook.com/111/posts/222/',
  domain: 'facebook.com',
  hide: false,
  desc_sentiment: 1,
  created_time: 1758693600000,
  info: {
    likes: 530,
    reactions: { haha: 10, love: 45, sad: 3, wow: 2 },
    shares: 10,
    comments: 3,
    views: 0,
    engagement: 603,
    tags: ['BrandA'],
    from: { _id: 'facebook_111', name: 'Brand A Official', gender: 0 },
    on: { _id: 'facebook_111', name: 'Brand A Official' },
    media: [{ id: 'https://cdn.example/img.jpg', mime_type: 'image/jpeg' }],
  },
  countries: { location: [], profile: ['ID'], combination: ['ID'] },
  keywords: [
    { id: 'k1', name: 'Brand A', _tags: [{ name: '[Topic] Promo' }] },
    { id: 'k2', name: 'Brand A', _tags: [{ name: '[Topic] Promo' }] },
  ],
};

describe('Zanroo Listening messages', () => {
  it('finds messages in every envelope shape', () => {
    expect(extractMessages({ body: { messages: [post] } })).toHaveLength(1);
    expect(extractMessages({ messages: [post, post] })).toHaveLength(2);
    expect(extractMessages([post])).toHaveLength(1);
    expect(extractMessages(post)).toHaveLength(1);
    expect(extractMessages('nope')).toHaveLength(0);
  });

  it('maps a post to a mention', () => {
    const r = zanrooMessageToRecord(post);
    if (!r.ok) throw new Error(r.message);
    const m = r.mention;
    expect(m.externalId).toBe('fb_111_222'); // same id as the Excel MID, so the two sources dedupe
    expect(m.channel).toBe('FACEBOOK');
    expect(m.postType).toBe('Posted');
    expect(m.publishedAt.toISOString()).toBe('2025-09-24T06:00:00.000Z');
    expect(m.author).toMatchObject({ handle: '111', name: 'Brand A Official' });
    expect(m.engagement).toMatchObject({
      likes: 590,
      shares: 10,
      comments: 3,
      total: 603,
    });
    expect(m.sentiment.label).toBe('POSITIVE');
    expect(m.brandKeywords).toEqual(['Brand A']);
    expect(m.tags).toEqual(['[Topic] Promo']);
    expect(m.extra).toMatchObject({ country: 'ID', hashtags: ['BrandA'] });
  });

  it('reads 0 and negative sentiment, and reports bad messages', () => {
    const neutral = zanrooMessageToRecord({ ...post, desc_sentiment: 0 });
    const negative = zanrooMessageToRecord({ ...post, desc_sentiment: -1 });
    expect(neutral.ok && neutral.mention.sentiment.label).toBe('NEUTRAL');
    expect(negative.ok && negative.mention.sentiment.label).toBe('NEGATIVE');
    const bad = zanrooMessageToRecord({
      ...post,
      channel: 'myspace',
      platform: undefined,
    });
    expect(bad.ok).toBe(false);
    expect(
      zanrooMessageToRecord({ ...post, mid: undefined, id: undefined }).ok,
    ).toBe(false);
  });
});
