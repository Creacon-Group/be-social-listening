import { Prisma } from '../../generated/prisma/client.js';
import type { ResolvedFilter } from './mention-filter.js';

/** Zanroo tag on posts from a brand's own accounts. */
export const BRAND_VOICE_TAG = 'Brand Voice';

const escapeLike = (s: string) => s.replace(/[!%_]/g, (c) => `!${c}`);

/** Author of mention `m` has a manual profile matching `cond`. Handles compare case-insensitively (column collation). */
const profileExists = (cond: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM account_profiles ap WHERE ap.projectId = m.projectId AND ap.channel = m.channel AND ap.handle = m.authorHandle AND ${cond})`;

/** Zanroo influencer tiers (Tag column), smallest to largest. */
export const TIERS = [
  'Nano Influencer',
  'Micro Influencer',
  'Mid Tier Influencer',
  'Macro Influencer',
  'Mega Influencer',
] as const;

const tagged = (tag: string) =>
  Prisma.sql`COALESCE(JSON_CONTAINS(m.tags, JSON_QUOTE(${tag})), 0) = 1`;

/** Owned media, from the source: Brand Voice tag, or an account an analyst marked Official. */
const ownedSource = () =>
  Prisma.sql`(${tagged(BRAND_VOICE_TAG)} OR ${profileExists(Prisma.sql`ap.accountType = 'OFFICIAL'`)})`;
const paidSource = () => profileExists(Prisma.sql`ap.isPaid = 1`);

/** Whole-number JSON value at `path` in m.extra, 0 when missing or not a number. */
const jsonInt = (path: string) =>
  Prisma.sql`CASE WHEN JSON_TYPE(JSON_EXTRACT(m.extra, ${path})) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE') THEN CAST(JSON_EXTRACT(m.extra, ${path}) AS SIGNED) ELSE 0 END`;
const jsonText = (path: string, max: number) =>
  Prisma.sql`LEFT(JSON_UNQUOTE(JSON_EXTRACT(m.extra, ${path})), ${max})`;

/** Owned / paid columns, recomputed when an analyst re-tags an account. */
export const ownedPaidSet = () =>
  Prisma.sql`m.isOwned = ${ownedSource()}, m.isPaid = ${paidSource()}`;

/**
 * SET list for `UPDATE mentions m`: every derived column from tags, extra and account_profiles.
 * The single definition used by ingestion, account tagging and the backfill script.
 */
export const derivedSet = () => Prisma.sql`${ownedPaidSet()},
  m.tierRank = CASE ${Prisma.join(
    [...TIERS]
      .map((t, i) => Prisma.sql`WHEN ${tagged(t)} THEN ${i + 1}`)
      .reverse(),
    ' ',
  )} ELSE 0 END,
  m.gender = ${jsonText('$.gender', 50)},
  m.province = LEFT(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(m.extra, '$.hasc')), '.', 2), 50),
  m.country = ${jsonText('$.country', 100)},
  m.bookmarks = ${jsonInt('$.preview.bookmarks')},
  m.reactLove = ${jsonInt('$.reactions.love')},
  m.reactWow = ${jsonInt('$.reactions.wow')},
  m.reactHaha = ${jsonInt('$.reactions.haha')},
  m.reactSad = ${jsonInt('$.reactions.sad')},
  m.reactAngry = ${jsonInt('$.reactions.angry')},
  m.reactFavorites = ${jsonInt('$.reactions.favorites')}`;

/** Owned media: posts tagged Brand Voice by Zanroo, or by an account an analyst marked Official. */
export const ownedSql = () => Prisma.sql`m.isOwned = 1`;

export const paidSql = () => Prisma.sql`m.isPaid = 1`;

/**
 * WHERE clause on `mentions m` for every filter except brands (queries that join mention_brands
 * filter brands themselves). One definition for the dashboard, the feed, reports and the assistant.
 */
export function mentionSqlWhere(f: ResolvedFilter): Prisma.Sql {
  const p: Prisma.Sql[] = [
    Prisma.sql`m.projectId = ${f.projectId}`,
    Prisma.sql`m.publishedAt >= ${f.from}`,
    Prisma.sql`m.publishedAt < ${f.to}`,
  ];
  if (f.channels) p.push(Prisma.sql`m.channel IN (${Prisma.join(f.channels)})`);
  if (f.sentiments)
    p.push(Prisma.sql`m.sentimentLabel IN (${Prisma.join(f.sentiments)})`);
  if (f.q)
    p.push(Prisma.sql`m.content LIKE ${`%${escapeLike(f.q)}%`} ESCAPE '!'`);
  if (f.categoryIds) {
    const ids = f.categoryIds.filter((id) => id > 0);
    const any: Prisma.Sql[] = [];
    if (ids.length)
      any.push(
        Prisma.sql`EXISTS (SELECT 1 FROM mention_categories mcf WHERE mcf.mentionId = m.id AND mcf.categoryId IN (${Prisma.join(ids)}))`,
      );
    if (f.categoryIds.includes(0))
      any.push(
        Prisma.sql`NOT EXISTS (SELECT 1 FROM mention_categories mcf WHERE mcf.mentionId = m.id)`,
      );
    if (any.length) p.push(Prisma.sql`(${Prisma.join(any, ' OR ')})`);
  }
  if (f.voice === 'owned') p.push(ownedSql());
  if (f.voice === 'earned') p.push(Prisma.sql`NOT ${ownedSql()}`);
  if (f.paid === 'paid') p.push(paidSql());
  if (f.paid === 'organic') p.push(Prisma.sql`NOT ${paidSql()}`);
  if (f.keywords)
    p.push(
      Prisma.sql`(${Prisma.join(
        f.keywords.map(
          (k) =>
            Prisma.sql`COALESCE(JSON_CONTAINS(m.extra, JSON_QUOTE(${k}), '$.keywords'), 0) = 1`,
        ),
        ' OR ',
      )})`,
    );
  return Prisma.join(p, ' AND ');
}

/** When brands are filtered, count only mentions of those brands. */
export function brandExistsSql(f: ResolvedFilter): Prisma.Sql {
  return f.brandIds
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM mention_brands mb WHERE mb.mentionId = m.id AND mb.brandId IN (${Prisma.join(f.brandIds)}))`
    : Prisma.empty;
}
