/**
 * Excel header (normalized: lower case, spaces -> "_") -> canonical name.
 * Mapped from the Zanroo export (75 columns). Add aliases here if the export format changes.
 */
export const REQUIRED_COLUMNS = [
  'id',
  'channel',
  'date',
  'sentiment',
  'keyword',
] as const;

export const COLUMN_ALIASES: Record<string, string[]> = {
  id: ['mid', 'mention_id'],
  date: ['createddate'],
  time: ['createdtime'],
  tz: ['timezone'],
  channel: ['channel'],
  post_type: ['topic'],
  title: ['title'],
  content: ['description'],
  url: ['messagelink'],
  image_link: ['imagelink'],
  user_link: ['userlink'],
  bookmarks: ['bookmarks'],
  author_handle: ['username'],
  author_name: ['displayname'],
  verified: ['userverified'],
  likes: ['likes'],
  comments: ['comments'],
  shares: ['shares'],
  views: ['views'],
  reach: ['estimatedreach'],
  total: ['engagements'],
  sentiment: ['sentiments', 'sentiment'],
  keyword: ['keyword'],
  tag: ['tag'],
  location: ['location'],
  source_name: ['where'],
  country: ['country'],
  types: ['types'],
  f_x: ['twitterfollowers'],
  f_tiktok: ['tiktokfollowers'],
  f_instagram: ['instagramfollowers'],
  f_facebook: ['facebookfancount'],
  f_youtube: ['youtubesubscribers'],
};

const CATEGORY_SUFFIX = ' (Category Label)';

export interface ExcelHeader {
  columns: Map<string, number>; // canonical name -> column index
  categories: { label: string; idx: number }[]; // the 0/1 "(Category Label)" columns
  missing: string[];
}

export const normHeader = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .split(' ')
    .join('_');

export function mapHeaders(cells: unknown[]): ExcelHeader {
  const columns = new Map<string, number>();
  const categories: { label: string; idx: number }[] = [];

  cells.forEach((cell, idx) => {
    const text = String(cell ?? '').trim();
    if (text.endsWith(CATEGORY_SUFFIX)) {
      categories.push({ label: text.slice(0, -CATEGORY_SUFFIX.length), idx });
      return;
    }
    const name = normHeader(text);
    const key = Object.keys(COLUMN_ALIASES).find((k) =>
      COLUMN_ALIASES[k].includes(name),
    );
    if (key && !columns.has(key)) columns.set(key, idx);
  });

  return {
    columns,
    categories,
    missing: REQUIRED_COLUMNS.filter((c) => !columns.has(c)),
  };
}
