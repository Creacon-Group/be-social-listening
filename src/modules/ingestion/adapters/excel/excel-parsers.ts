import { Channel, SentimentLabel } from '../../../../generated/prisma/enums.js';

/** exceljs wraps formula, hyperlink and rich-text cells in objects. */
export function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ('result' in o) return o.result;
    if ('text' in o) return o.text;
    if (Array.isArray(o.richText))
      return (o.richText as { text: string }[]).map((r) => r.text).join('');
  }
  return v;
}

export const asString = (v: unknown) => {
  const s = (v instanceof Date ? v.toISOString() : String(v ?? '')).trim();
  return s ? s : undefined;
};

/** Zanroo stores numbers as text ('1131764'); Number() handles both. */
export const asNumber = (v: unknown) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`bukan angka: ${String(v)}`);
  return n;
};

export const asList = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const CHANNEL_ALIASES: Record<string, Channel> = {
  x: Channel.X,
  twitter: Channel.X,
  'x(twitter)': Channel.X,
  x_twitter: Channel.X,
  tiktok: Channel.TIKTOK,
  instagram: Channel.INSTAGRAM,
  ig: Channel.INSTAGRAM,
  news: Channel.ONLINE_NEWS,
  online_news: Channel.ONLINE_NEWS,
  news_portal: Channel.ONLINE_NEWS,
  facebook: Channel.FACEBOOK,
  youtube: Channel.YOUTUBE,
  blog: Channel.BLOG,
};

export function parseChannel(v: unknown): Channel {
  const ch =
    CHANNEL_ALIASES[
      String(v ?? '')
        .trim()
        .toLowerCase()
        .split(' ')
        .join('_')
    ];
  if (!ch) throw new Error(`unknown channel: ${String(v)}`);
  return ch;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** CreatedDate '2026-09-01' + CreatedTime '00:00:07' + TimeZone '+0700' -> one UTC instant. */
export function parsePublishedAt(
  date: unknown,
  time: unknown,
  tz: unknown,
): Date {
  // A real Excel date cell comes back from exceljs as the wall-clock value labelled UTC.
  const d =
    date instanceof Date
      ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
      : asString(date);
  const t =
    time instanceof Date
      ? `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}:${pad(time.getUTCSeconds())}`
      : (asString(time) ?? '00:00:00');
  const offset = asString(tz) ?? '+0700';
  if (
    !d ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
    !/^\d{2}:\d{2}(:\d{2})?$/.test(t) ||
    !/^[+-]\d{4}$/.test(offset)
  ) {
    throw new Error(`invalid date: ${String(d)} ${t} ${offset}`);
  }
  const parsed = new Date(
    `${d}T${t.length === 5 ? `${t}:00` : t}${offset.slice(0, 3)}:${offset.slice(3)}`,
  );
  if (Number.isNaN(parsed.getTime()))
    throw new Error(`invalid date: ${d} ${t} ${offset}`);
  return parsed;
}

export function parseSentimentLabel(v: unknown): SentimentLabel {
  const label = String(v ?? '')
    .trim()
    .toUpperCase();
  if (!(label in SentimentLabel))
    throw new Error(`unknown sentiment: ${String(v)}`);
  return label as SentimentLabel;
}

const FOLLOWER_KEY: Partial<Record<Channel, string>> = {
  X: 'f_x',
  TIKTOK: 'f_tiktok',
  INSTAGRAM: 'f_instagram',
  FACEBOOK: 'f_facebook',
  YOUTUBE: 'f_youtube',
};

/** Followers live in a per-channel column; 0 means "not reported". */
export const followersFor = (
  channel: Channel,
  raw: Record<string, unknown>,
) => {
  const key = FOLLOWER_KEY[channel];
  const n = key ? asNumber(raw[key]) : undefined;
  return n ? n : undefined;
};

export const categoriesOf = (
  cells: unknown[],
  cats: { label: string; idx: number }[],
) =>
  cats
    .filter((c) => String(unwrap(cells[c.idx]) ?? '').trim() === '1')
    .map((c) => c.label);
