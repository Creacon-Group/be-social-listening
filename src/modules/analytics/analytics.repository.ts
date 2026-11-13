import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type ResolvedFilter,
  WIB_OFFSET_H,
} from '../mentions/mention-filter.js';
import {
  brandExistsSql,
  mentionSqlWhere,
  ownedSql,
  TIERS,
} from '../mentions/mention-sql.js';

export interface CountsRow {
  total: bigint | number;
  positive: bigint | number | null;
  neutral: bigint | number | null;
  negative: bigint | number | null;
}
export interface OverviewRow extends CountsRow {
  engagements: bigint | number | null;
  reach: bigint | number | null;
}
export interface BrandCountsRow extends CountsRow {
  brandId: number;
  name: string;
  isOwn: number | boolean;
  engagements: unknown;
  reach: unknown;
}
export interface TrendRow extends CountsRow {
  day: Date | string;
  brandId: number;
  engagements?: unknown;
  reach?: unknown;
}

export type Interval = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
export const INTERVALS: Interval[] = [
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
];

const WIB = Prisma.raw(
  `DATE_ADD(m.publishedAt, INTERVAL ${WIB_OFFSET_H} HOUR)`,
);

/** Bucket key per interval, in WIB. Week = the Monday it starts on. Keys match bucketKeys() in the service. */
export const bucketSql = (i: Interval): Prisma.Sql => {
  switch (i) {
    case 'hour':
      return Prisma.sql`DATE_FORMAT(${WIB}, '%Y-%m-%d %H:00')`;
    case 'week':
      return Prisma.sql`DATE_FORMAT(DATE_SUB(DATE(${WIB}), INTERVAL WEEKDAY(${WIB}) DAY), '%Y-%m-%d')`;
    case 'month':
      return Prisma.sql`DATE_FORMAT(${WIB}, '%Y-%m')`;
    case 'quarter':
      return Prisma.sql`CONCAT(YEAR(${WIB}), '-Q', QUARTER(${WIB}))`;
    case 'year':
      return Prisma.sql`DATE_FORMAT(${WIB}, '%Y')`;
    default:
      return Prisma.sql`DATE_FORMAT(${WIB}, '%Y-%m-%d')`;
  }
};

export { TIERS };

/**
 * Account type: an analyst's choice wins; otherwise Brand Voice tag = OFFICIAL, news/blog = MEDIA,
 * a Zanroo influencer tier = KOL, anyone else = OTHER. (m.isOwned also covers accounts marked
 * Official, which the analyst's choice already returns first.)
 */
const ACCOUNT_TYPE = Prisma.sql`COALESCE(MAX(ap.accountType), CASE
  WHEN MAX(m.isOwned) = 1 THEN 'OFFICIAL'
  WHEN m.channel IN ('ONLINE_NEWS', 'BLOG') THEN 'MEDIA'
  WHEN MAX(m.tierRank) > 0 THEN 'KOL'
  ELSE 'OTHER' END)`;

/**
 * For queries that group many rows by author or host: TiDB otherwise picks a full table scan
 * once the period covers a large share of the table (EXPLAIN ANALYZE on production: ~800 ms
 * full scan vs ~400 ms reading the period through this index).
 */
const BY_DATE = Prisma.raw('USE INDEX (mentions_agg_idx)');

/** Read side: aggregate SQL kept in one place. Every query is scoped by projectId and the resolved filter. */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private where(f: ResolvedFilter): Prisma.Sql {
    return mentionSqlWhere(f);
  }

  private brandCond(f: ResolvedFilter): Prisma.Sql {
    return f.brandIds
      ? Prisma.sql`AND mb.brandId IN (${Prisma.join(f.brandIds)})`
      : Prisma.empty;
  }

  /** When brands are filtered, the overview counts only mentions of those brands. */
  private brandExists(f: ResolvedFilter): Prisma.Sql {
    return brandExistsSql(f);
  }

  async overview(f: ResolvedFilter): Promise<OverviewRow> {
    const [r] = await this.prisma.$queryRaw<OverviewRow[]>`
      SELECT COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements,
             CAST(SUM(m.reach) AS SIGNED) AS reach
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}`;
    return r;
  }

  /**
   * Totals for the period and the one before it (same filters, `prev.to` = `f.from`) in one scan,
   * instead of two queries over the same index range.
   */
  async overviewWithPrevious(
    f: ResolvedFilter,
    prev: ResolvedFilter,
  ): Promise<{ now: OverviewRow; prev: OverviewRow }> {
    const cur = Prisma.sql`m.publishedAt >= ${f.from}`;
    const [r] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT CAST(SUM(${cur}) AS SIGNED) AS total,
             CAST(SUM(${cur} AND m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(${cur} AND m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(${cur} AND m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(CASE WHEN ${cur} THEN m.engagements ELSE 0 END) AS SIGNED) AS engagements,
             CAST(SUM(CASE WHEN ${cur} THEN m.reach ELSE 0 END) AS SIGNED) AS reach,
             CAST(SUM(NOT ${cur}) AS SIGNED) AS pTotal,
             CAST(SUM(NOT ${cur} AND m.sentimentLabel = 'POSITIVE') AS SIGNED) AS pPositive,
             CAST(SUM(NOT ${cur} AND m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS pNeutral,
             CAST(SUM(NOT ${cur} AND m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS pNegative,
             CAST(SUM(CASE WHEN ${cur} THEN 0 ELSE m.engagements END) AS SIGNED) AS pEngagements,
             CAST(SUM(CASE WHEN ${cur} THEN 0 ELSE m.reach END) AS SIGNED) AS pReach
      FROM mentions m
      WHERE ${this.where({ ...f, from: prev.from })} ${this.brandExists(f)}`;
    const v = (k: string) => (r?.[k] ?? 0) as bigint | number;
    return {
      now: {
        total: v('total'),
        positive: v('positive'),
        neutral: v('neutral'),
        negative: v('negative'),
        engagements: v('engagements'),
        reach: v('reach'),
      },
      prev: {
        total: v('pTotal'),
        positive: v('pPositive'),
        neutral: v('pNeutral'),
        negative: v('pNegative'),
        engagements: v('pEngagements'),
        reach: v('pReach'),
      },
    };
  }

  /** What engagement is made of, and owned (brand accounts) vs earned. */
  async breakdown(f: ResolvedFilter) {
    const [r] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT CAST(SUM(m.likes) AS SIGNED) AS likes,
             CAST(SUM(m.comments) AS SIGNED) AS comments,
             CAST(SUM(m.shares) AS SIGNED) AS shares,
             CAST(SUM(m.views) AS SIGNED) AS views,
             CAST(SUM(m.bookmarks) AS SIGNED) AS bookmarks,
             CAST(SUM(m.reactLove) AS SIGNED) AS love,
             CAST(SUM(m.reactWow) AS SIGNED) AS wow,
             CAST(SUM(m.reactHaha) AS SIGNED) AS haha,
             CAST(SUM(m.reactSad) AS SIGNED) AS sad,
             CAST(SUM(m.reactAngry) AS SIGNED) AS angry,
             CAST(SUM(m.reactFavorites) AS SIGNED) AS favorites,
             CAST(SUM(${ownedSql()}) AS SIGNED) AS ownedTotal,
             CAST(SUM(CASE WHEN ${ownedSql()} THEN m.engagements ELSE 0 END) AS SIGNED) AS ownedEngagements,
             CAST(SUM(CASE WHEN ${ownedSql()} THEN m.reach ELSE 0 END) AS SIGNED) AS ownedReach
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}`;
    return r ?? {};
  }

  /** Mentions per weekday (0 = Monday) and hour of day, WIB. */
  heatmap(f: ResolvedFilter) {
    return this.prisma.$queryRaw<
      { dow: unknown; hour: unknown; total: unknown; engagements: unknown }[]
    >`
      SELECT WEEKDAY(${WIB}) AS dow, HOUR(${WIB}) AS hour, COUNT(*) AS total,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY dow, hour`;
  }

  /** Raw Zanroo keywords per mention, for the keyword / campaign breakdown (aggregated in code). */
  keywordRows(f: ResolvedFilter, limit = 120_000) {
    return this.prisma.$queryRaw<
      {
        keywords: unknown;
        sentimentLabel: string;
        engagements: unknown;
        reach: unknown;
      }[]
    >`
      SELECT JSON_EXTRACT(m.extra, '$.keywords') AS keywords, m.sentimentLabel, m.engagements, m.reach
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)} AND JSON_EXTRACT(m.extra, '$.keywords') IS NOT NULL
      LIMIT ${limit}`;
  }

  byBrand(f: ResolvedFilter): Promise<BrandCountsRow[]> {
    return this.prisma.$queryRaw<BrandCountsRow[]>`
      SELECT b.id AS brandId, b.name AS name, b.isOwn AS isOwn, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements,
             CAST(SUM(m.reach) AS SIGNED) AS reach
      FROM mention_brands mb
      JOIN mentions m ON m.id = mb.mentionId
      JOIN brands b ON b.id = mb.brandId
      WHERE ${this.where(f)} ${this.brandCond(f)}
      GROUP BY b.id, b.name, b.isOwn`;
  }

  /** Unique mentions: all that name any brand vs those naming at least one own brand (Indosat + Tri counted once). */
  async ownVsAll(f: ResolvedFilter) {
    const [r] = await this.prisma.$queryRaw<
      (CountsRow & {
        allMentions: bigint | number;
        ownMentions: bigint | number;
      })[]
    >`
      SELECT COUNT(DISTINCT mb.mentionId) AS allMentions,
             COUNT(DISTINCT CASE WHEN b.isOwn = 1 THEN mb.mentionId END) AS ownMentions,
             COUNT(DISTINCT CASE WHEN b.isOwn = 1 THEN mb.mentionId END) AS total,
             COUNT(DISTINCT CASE WHEN b.isOwn = 1 AND m.sentimentLabel = 'POSITIVE' THEN mb.mentionId END) AS positive,
             COUNT(DISTINCT CASE WHEN b.isOwn = 1 AND m.sentimentLabel = 'NEUTRAL' THEN mb.mentionId END) AS neutral,
             COUNT(DISTINCT CASE WHEN b.isOwn = 1 AND m.sentimentLabel = 'NEGATIVE' THEN mb.mentionId END) AS negative
      FROM mention_brands mb
      JOIN mentions m ON m.id = mb.mentionId
      JOIN brands b ON b.id = mb.brandId
      WHERE ${this.where(f)}`;
    return r;
  }

  trendByBrand(
    f: ResolvedFilter,
    interval: Interval = 'day',
  ): Promise<TrendRow[]> {
    return this.prisma.$queryRaw<TrendRow[]>`
      SELECT ${bucketSql(interval)} AS day,
             mb.brandId AS brandId, COUNT(*) AS total,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements,
             CAST(SUM(m.reach) AS SIGNED) AS reach,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative
      FROM mention_brands mb
      JOIN mentions m ON m.id = mb.mentionId
      WHERE ${this.where(f)} ${this.brandCond(f)}
      GROUP BY day, mb.brandId
      ORDER BY day, mb.brandId`;
  }

  byChannel(f: ResolvedFilter) {
    return this.prisma.$queryRaw<
      (CountsRow & {
        channel: string;
        engagements: unknown;
        reach: unknown;
        views: unknown;
        owned: unknown;
      })[]
    >`
      SELECT m.channel AS channel, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements,
             CAST(SUM(m.reach) AS SIGNED) AS reach,
             CAST(SUM(m.views) AS SIGNED) AS views,
             CAST(SUM(${ownedSql()}) AS SIGNED) AS owned
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY m.channel
      ORDER BY total DESC, m.channel`;
  }

  /** Totals per time bucket (WIB): mentions, reach, engagement and sentiment. */
  buckets(f: ResolvedFilter, interval: Interval = 'day') {
    return this.prisma.$queryRaw<
      (CountsRow & { day: string; reach: unknown; engagements: unknown })[]
    >`
      SELECT ${bucketSql(interval)} AS day,
             COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.reach) AS SIGNED) AS reach,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY day
      ORDER BY day`;
  }

  /**
   * Authors ranked by reach, engagement or mention count, with their account type, Zanroo tier
   * and paid flag. `types` keeps only authors of those types (applied before the limit).
   */
  influencers(
    f: ResolvedFilter,
    sort: 'reach' | 'engagements' | 'mentions',
    limit: number,
    types?: string[],
  ) {
    const order =
      sort === 'mentions'
        ? Prisma.sql`total DESC, reach DESC`
        : sort === 'engagements'
          ? Prisma.sql`engagements DESC, total DESC`
          : Prisma.sql`reach DESC, total DESC`;
    return this.prisma.$queryRaw<
      (CountsRow & {
        channel: string;
        handle: string;
        name: string | null;
        followers: unknown;
        verified: unknown;
        reach: unknown;
        engagements: unknown;
        userLink: string | null;
        accountType: string;
        manualType: string | null;
        tierRank: unknown;
        isPaid: unknown;
      })[]
    >`
      SELECT m.channel AS channel, m.authorHandle AS handle, MAX(m.authorName) AS name,
             MAX(m.authorFollowers) AS followers, MAX(m.authorVerified) AS verified,
             MAX(JSON_UNQUOTE(JSON_EXTRACT(m.extra, '$.preview.userLink'))) AS userLink,
             COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.reach) AS SIGNED) AS reach,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements,
             ${ACCOUNT_TYPE} AS accountType,
             MAX(ap.accountType) AS manualType,
             MAX(m.tierRank) AS tierRank,
             MAX(ap.isPaid) AS isPaid
      FROM mentions m ${BY_DATE}
      LEFT JOIN account_profiles ap
        ON ap.projectId = m.projectId AND ap.channel = m.channel AND ap.handle = m.authorHandle
      WHERE ${this.where(f)} ${this.brandExists(f)} AND m.authorHandle IS NOT NULL AND m.authorHandle <> ''
      GROUP BY m.channel, m.authorHandle
      ${types?.length ? Prisma.sql`HAVING accountType IN (${Prisma.join(types)})` : Prisma.empty}
      ORDER BY ${order}
      LIMIT ${limit}`;
  }

  /** Sites and platforms, from the host of each mention's link. */
  sources(f: ResolvedFilter, limit: number) {
    return this.prisma.$queryRaw<
      (CountsRow & {
        host: string;
        channel: string;
        reach: unknown;
        engagements: unknown;
      })[]
    >`
      SELECT s.host AS host, MAX(s.channel) AS channel, COUNT(*) AS total,
             CAST(SUM(s.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(s.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(s.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(s.reach) AS SIGNED) AS reach,
             CAST(SUM(s.engagements) AS SIGNED) AS engagements
      FROM (
        SELECT REPLACE(LOWER(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(m.url, '://', -1), '/', 1), '?', 1)), 'www.', '') AS host,
               m.channel, m.sentimentLabel, m.reach, m.engagements
        FROM mentions m ${BY_DATE}
        WHERE ${this.where(f)} ${this.brandExists(f)} AND m.url IS NOT NULL
      ) s
      GROUP BY s.host
      ORDER BY total DESC
      LIMIT ${limit}`;
  }

  /** Counts per value of one demographic dimension stored in mentions.extra. */
  demographic(f: ResolvedFilter, dim: 'gender' | 'province' | 'country') {
    const expr =
      dim === 'gender'
        ? Prisma.sql`m.gender`
        : dim === 'province'
          ? Prisma.sql`m.province`
          : Prisma.sql`m.country`;
    return this.prisma.$queryRaw<
      (CountsRow & { value: string | null; reach: unknown })[]
    >`
      SELECT ${expr} AS value, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.reach) AS SIGNED) AS reach
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY value
      ORDER BY total DESC`;
  }

  /** Texts that contain a '#', for hashtag extraction in code (MySQL has no regex aggregation). */
  hashtagRows(f: ResolvedFilter, limit = 60_000) {
    return this.prisma.$queryRaw<
      {
        id: number;
        content: string;
        sentimentLabel: string;
        engagements: unknown;
        reach: unknown;
        channel: string;
      }[]
    >`
      SELECT m.id, m.content, m.sentimentLabel, m.engagements, m.reach, m.channel
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)} AND m.content LIKE '%#%'
      LIMIT ${limit}`;
  }

  /** Zanroo topic labels (the Tag column) with sentiment, for AI Insights. */
  topicRows(f: ResolvedFilter, limit = 80_000) {
    return this.prisma.$queryRaw<
      { tags: unknown; sentimentLabel: string; reach: unknown }[]
    >`
      SELECT m.tags, m.sentimentLabel, m.reach
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)} AND m.tags IS NOT NULL
      LIMIT ${limit}`;
  }

  /** Volume and sentiment per topic category. A mention in two categories counts for both. */
  byCategory(f: ResolvedFilter) {
    return this.prisma.$queryRaw<
      (CountsRow & { categoryId: number; engagements: unknown })[]
    >`
      SELECT mc.categoryId AS categoryId, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative,
             CAST(SUM(m.engagements) AS SIGNED) AS engagements
      FROM mention_categories mc
      JOIN mentions m ON m.id = mc.mentionId
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY mc.categoryId`;
  }

  /** Mentions in the filter that match no category, and the filter total. */
  async categoryCoverage(f: ResolvedFilter) {
    const [r] = await this.prisma.$queryRaw<
      { total: unknown; uncategorized: unknown }[]
    >`
      SELECT COUNT(*) AS total,
             CAST(SUM(NOT EXISTS (SELECT 1 FROM mention_categories mc WHERE mc.mentionId = m.id)) AS SIGNED) AS uncategorized
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}`;
    return r;
  }

  /** Topic x brand: how each brand is talked about within each topic. */
  categoryByBrand(f: ResolvedFilter) {
    return this.prisma.$queryRaw<
      (CountsRow & { categoryId: number; brandId: number })[]
    >`
      SELECT mc.categoryId AS categoryId, mb.brandId AS brandId, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative
      FROM mention_categories mc
      JOIN mentions m ON m.id = mc.mentionId
      JOIN mention_brands mb ON mb.mentionId = m.id
      WHERE ${this.where(f)} ${this.brandCond(f)}
      GROUP BY mc.categoryId, mb.brandId`;
  }

  /** Daily volume per topic, in WIB days. */
  categoryTrend(f: ResolvedFilter) {
    return this.prisma.$queryRaw<
      { categoryId: number; day: string; total: unknown }[]
    >`
      SELECT mc.categoryId AS categoryId,
             DATE_FORMAT(DATE_ADD(m.publishedAt, INTERVAL ${Prisma.raw(String(WIB_OFFSET_H))} HOUR), '%Y-%m-%d') AS day,
             COUNT(*) AS total
      FROM mention_categories mc
      JOIN mentions m ON m.id = mc.mentionId
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY mc.categoryId, day
      ORDER BY day`;
  }
}
