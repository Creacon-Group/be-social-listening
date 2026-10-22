import type { SourceRecord } from '../../domain/normalized-mention.js';
import { parseChannel } from '../excel/excel-parsers.js';

/**
 * One message as Zanroo Listening sends it: in the webhook body and in the
 * `/v2.0/arun/listening/template/{id}/messages` pull API (body.messages[]).
 * Only the fields we read are typed.
 */
export interface ZanrooMessage {
  id?: string; // "<account>_<mid>"
  mid?: string; // same id as the MID column of the Excel export
  platform?: string;
  channel?: string;
  topic?: string; // Added | Commented | ...
  desc?: string;
  title?: string;
  link?: string;
  domain?: string;
  hide?: boolean;
  desc_sentiment?: number;
  created_time?: number; // epoch ms
  updated_time?: number;
  info?: {
    likes?: number;
    reactions?: Record<string, number>;
    shares?: number;
    comments?: number;
    views?: number;
    engagement?: number;
    reach?: number;
    followers?: number;
    tags?: string[]; // hashtags without '#'
    from?: { _id?: string; name?: string; gender?: number };
    on?: { _id?: string; name?: string };
    media?: { id?: string; mime_type?: string }[];
  };
  countries?: {
    location?: string[];
    profile?: string[];
    combination?: string[];
  };
  keywords?: { id?: string; name?: string; _tags?: { name?: string }[] }[];
}

/** Accepts the pull API envelope, `{ messages }`, an array, or a single message. */
export function extractMessages(payload: unknown): ZanrooMessage[] {
  if (Array.isArray(payload)) return payload as ZanrooMessage[];
  if (!payload || typeof payload !== 'object') return [];
  const o = payload as Record<string, unknown>;
  const body = o.body as Record<string, unknown> | undefined;
  if (Array.isArray(body?.messages)) return body.messages as ZanrooMessage[];
  if (Array.isArray(o.messages)) return o.messages as ZanrooMessage[];
  if (typeof o.mid === 'string' || typeof o.id === 'string')
    return [o as ZanrooMessage];
  return [];
}

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const uniq = <T>(xs: T[]) => [...new Set(xs)];

// Zanroo labels sentiment as a number. 1 and 0 appear in the sample; -1 is assumed to be negative.
const sentimentOf = (v: unknown) =>
  num(v) > 0 ? 'POSITIVE' : num(v) < 0 ? 'NEGATIVE' : 'NEUTRAL';

// The Excel export calls an original post "Posted"; the API calls it "Added".
const POST_TYPE: Record<string, string> = { Added: 'Posted' };

/** "facebook_155409127999450" -> "155409127999450" */
const handleOf = (id?: string) => id?.replace(/^[a-z]+_/, '') || undefined;

export function zanrooMessageToRecord(m: ZanrooMessage): SourceRecord {
  const externalId = m.mid || m.id;
  const ref = externalId ?? 'message';
  try {
    if (!externalId) throw new Error('mid is empty');
    if (!m.created_time) throw new Error('created_time is empty');
    const info = m.info ?? {};
    const reactions = Object.values(info.reactions ?? {}).reduce(
      (a, b) => a + num(b),
      0,
    );
    const keywords = m.keywords ?? [];
    const tags = uniq(
      keywords.flatMap((k) => (k._tags ?? []).map((t) => t.name ?? '')),
    ).filter(Boolean);
    const images = (info.media ?? [])
      .filter(
        (x) =>
          x.mime_type?.startsWith('image/') && x.id?.startsWith('https://'),
      )
      .map((x) => x.id!)
      .slice(0, 4);
    const country = m.countries?.profile?.[0] ?? m.countries?.combination?.[0];

    return {
      ok: true,
      ref,
      mention: {
        externalId,
        channel: parseChannel(m.channel ?? m.platform),
        postType: m.topic ? (POST_TYPE[m.topic] ?? m.topic) : undefined,
        title: m.title || undefined,
        content: m.desc,
        url: m.link,
        publishedAt: new Date(m.created_time),
        author: {
          handle: handleOf(info.from?._id),
          name: info.from?.name,
          followers: info.followers,
        },
        engagement: {
          likes: num(info.likes) + reactions, // Facebook splits likes and other reactions
          shares: num(info.shares),
          comments: num(info.comments),
          views: num(info.views),
          reach: num(info.reach), // not in the sample payload yet
          total: num(info.engagement),
        },
        sentiment: { label: sentimentOf(m.desc_sentiment) },
        // Brands are matched on the Zanroo keyword name (add it as a brand alias).
        brandKeywords: uniq(
          keywords.map((k) => k.name).filter((k): k is string => !!k),
        ),
        location: m.countries?.location?.[0],
        tags: tags.length ? tags : undefined,
        extra: {
          where: info.on?.name ?? m.domain,
          country,
          hashtags: info.tags?.length ? info.tags : undefined,
          preview: { images },
        },
      },
    };
  } catch (e) {
    return {
      ok: false,
      ref,
      message: (e as Error).message,
      raw: { mid: m.mid, id: m.id, channel: m.channel ?? m.platform },
    };
  }
}
