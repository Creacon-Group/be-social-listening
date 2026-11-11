import type { SourceRecord } from '../../domain/normalized-mention.js';
import { parseChannel } from '../excel/excel-parsers.js';

/**
 * A Zanroo Listening message after another system has flattened it (the "cleaned" shape the
 * CIMB crisis-monitoring backend forwards): ISO dates, `statistics`, `from_user`, and the
 * sentiment per keyword instead of `desc_sentiment`.
 */
export interface CleanedMessage {
  mid?: string;
  channel?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  media_url?: string[] | null;
  post_type?: string | null; // video | photo | text ...
  type?: string | null; // posted | commented | replied ...
  location?: string | null;
  created_time_iso?: string;
  updated_time_iso?: string;
  statistics?: Record<string, number | undefined>;
  from_user?: { id?: string; name?: string } | null;
  on_user?: { id?: string; name?: string } | null;
  keywords?: {
    id?: string;
    name?: string;
    sentiments?: string; // positive | neutral | negative
    tags?: { id?: string; name?: string }[];
  }[];
}

/** Not a type guard on purpose: it would narrow the raw message type to `never` at the call site. */
export const isCleanedMessage = (m: object): boolean =>
  'created_time_iso' in m || 'statistics' in m || 'from_user' in m;

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const text = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v : undefined;

/** "posted" -> "Posted", same wording as the Excel export. */
const postTypeOf = (v?: string | null) =>
  v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : undefined;

/** "youtube_UCoEN..." -> "UCoEN..." */
const handleOf = (id?: string) => id?.replace(/^[a-z]+_/, '') || undefined;

const SENTIMENT = {
  positive: 'POSITIVE',
  negative: 'NEGATIVE',
  neutral: 'NEUTRAL',
} as const;

export function cleanedMessageToRecord(m: CleanedMessage): SourceRecord {
  const externalId = m.mid;
  const ref = externalId ?? 'message';
  try {
    if (!externalId) throw new Error('mid is empty');
    const publishedAt = new Date(m.created_time_iso ?? '');
    if (Number.isNaN(publishedAt.getTime()))
      throw new Error('created_time_iso is empty or invalid');

    const s = m.statistics ?? {};
    const reactions =
      num(s.love) +
      num(s.wow) +
      num(s.sad) +
      num(s.angry) +
      num(s.haha) +
      num(s.scary);
    const likes = num(s.likes) + num(s.favorites) + reactions;
    const shares = num(s.shares) + num(s.retweets) + num(s.quotes);
    const comments = num(s.comments);

    const keywords = m.keywords ?? [];
    // One label per mention: the first keyword that carries one (Zanroo sends one per keyword).
    const label = keywords
      .map((k) => k.sentiments?.toLowerCase())
      .find((v): v is keyof typeof SENTIMENT => !!v && v in SENTIMENT);
    const tags = uniq(
      keywords.flatMap((k) => (k.tags ?? []).map((t) => t.name ?? '')),
    ).filter(Boolean);
    const images = (m.media_url ?? [])
      .filter((u) => typeof u === 'string' && u.startsWith('https://'))
      .slice(0, 4);

    return {
      ok: true,
      ref,
      mention: {
        externalId,
        channel: parseChannel(m.channel),
        postType: postTypeOf(m.type),
        title: text(m.title),
        content: m.description ?? undefined,
        url: text(m.link),
        publishedAt,
        author: {
          handle: handleOf(m.from_user?.id),
          name: text(m.from_user?.name),
        },
        engagement: {
          likes,
          shares,
          comments,
          views: num(s.views),
          reach: num(s.impressions),
          total: likes + shares + comments + num(s.bookmarks),
        },
        sentiment: { label: label ? SENTIMENT[label] : 'NEUTRAL' },
        brandKeywords: uniq(
          keywords.map((k) => k.name).filter((k): k is string => !!k),
        ),
        location: text(m.location),
        tags: tags.length ? tags : undefined,
        extra: {
          where: m.on_user?.name,
          mediaType: m.post_type ?? undefined,
          preview: { images },
        },
      },
    };
  } catch (e) {
    return {
      ok: false,
      ref,
      message: (e as Error).message,
      raw: { mid: m.mid, channel: m.channel },
    };
  }
}
