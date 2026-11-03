import { Prisma } from '../../generated/prisma/client.js';
import type { ResolvedFilter } from './mention-filter.js';

/** Zanroo tag on posts from a brand's own accounts. */
export const BRAND_VOICE_TAG = 'Brand Voice';

const escapeLike = (s: string) => s.replace(/[!%_]/g, (c) => `!${c}`);

/** Author of mention `m` has a manual profile matching `cond`. Handles compare case-insensitively (column collation). */
const profileExists = (cond: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM account_profiles ap WHERE ap.projectId = m.projectId AND ap.channel = m.channel AND ap.handle = m.authorHandle AND ${cond})`;

/** Owned media: posts tagged Brand Voice by Zanroo, or by an account an analyst marked Official. Never NULL. */
export const ownedSql = () =>
  Prisma.sql`(COALESCE(JSON_CONTAINS(m.tags, JSON_QUOTE(${BRAND_VOICE_TAG})), 0) = 1 OR ${profileExists(Prisma.sql`ap.accountType = 'OFFICIAL'`)})`;

export const paidSql = () => profileExists(Prisma.sql`ap.isPaid = 1`);

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
