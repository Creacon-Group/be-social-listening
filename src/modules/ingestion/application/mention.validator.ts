import { Injectable } from '@nestjs/common';
import type { NormalizedMention } from '../domain/normalized-mention.js';

const INT_MAX = 2_147_483_647;
const clampInt = (n: number) =>
  Math.min(Math.max(Math.trunc(n) || 0, 0), INT_MAX);
const cut = (s: string | undefined, max: number) =>
  s && s.length > max ? s.slice(0, max) : s;

/** Business rules shared by every source. Returns a cleaned copy or a reason to reject the row. */
@Injectable()
export class MentionValidator {
  validate(
    m: NormalizedMention,
  ): { ok: true; mention: NormalizedMention } | { ok: false; message: string } {
    if (!m.externalId || m.externalId.length > 100)
      return {
        ok: false,
        message: 'mention id kosong atau lebih dari 100 karakter',
      };
    if (Number.isNaN(m.publishedAt.getTime()))
      return { ok: false, message: 'tanggal tidak valid' };
    if (m.publishedAt.getTime() > Date.now() + 24 * 3_600_000)
      return { ok: false, message: 'tanggal di masa depan' };
    if (
      m.sentiment.score !== undefined &&
      (m.sentiment.score < -1 || m.sentiment.score > 1)
    ) {
      return {
        ok: false,
        message: 'sentiment_score di luar rentang -1 s.d. 1',
      };
    }

    return {
      ok: true,
      mention: {
        ...m,
        postType: cut(m.postType, 20),
        title: cut(m.title, 500),
        content: cut(m.content, 16_000),
        url: m.url && m.url.length <= 1000 ? m.url : undefined,
        author: {
          ...m.author,
          handle: cut(m.author.handle, 150),
          name: cut(m.author.name, 200),
          followers:
            m.author.followers === undefined
              ? undefined
              : clampInt(m.author.followers),
        },
        engagement: {
          likes: clampInt(m.engagement.likes),
          shares: clampInt(m.engagement.shares),
          comments: clampInt(m.engagement.comments),
          views: clampInt(m.engagement.views),
          reach: clampInt(m.engagement.reach),
          total: clampInt(m.engagement.total),
        },
        location: cut(m.location, 200),
      },
    };
  }
}
