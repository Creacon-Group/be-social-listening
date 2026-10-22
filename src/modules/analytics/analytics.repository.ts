import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type ResolvedFilter,
  WIB_OFFSET_H,
} from '../mentions/mention-filter.js';

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
}
export interface TrendRow extends CountsRow {
  day: Date | string;
  brandId: number;
}

const escapeLike = (s: string) => s.replace(/[!%_]/g, (c) => `!${c}`);

/** Read side: aggregate SQL kept in one place. Every query is scoped by projectId and the resolved filter. */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private where(f: ResolvedFilter): Prisma.Sql {
    const p: Prisma.Sql[] = [
      Prisma.sql`m.projectId = ${f.projectId}`,
      Prisma.sql`m.publishedAt >= ${f.from}`,
      Prisma.sql`m.publishedAt < ${f.to}`,
    ];
    if (f.channels)
      p.push(Prisma.sql`m.channel IN (${Prisma.join(f.channels)})`);
    if (f.sentiments)
      p.push(Prisma.sql`m.sentimentLabel IN (${Prisma.join(f.sentiments)})`);
    if (f.q)
      p.push(Prisma.sql`m.content LIKE ${`%${escapeLike(f.q)}%`} ESCAPE '!'`);
    return Prisma.join(p, ' AND ');
  }

  private brandCond(f: ResolvedFilter): Prisma.Sql {
    return f.brandIds
      ? Prisma.sql`AND mb.brandId IN (${Prisma.join(f.brandIds)})`
      : Prisma.empty;
  }

  /** When brands are filtered, the overview counts only mentions of those brands. */
  private brandExists(f: ResolvedFilter): Prisma.Sql {
    return f.brandIds
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM mention_brands mb WHERE mb.mentionId = m.id AND mb.brandId IN (${Prisma.join(f.brandIds)}))`
      : Prisma.empty;
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

  byBrand(f: ResolvedFilter): Promise<BrandCountsRow[]> {
    return this.prisma.$queryRaw<BrandCountsRow[]>`
      SELECT b.id AS brandId, b.name AS name, b.isOwn AS isOwn, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative
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

  trendByBrand(f: ResolvedFilter): Promise<TrendRow[]> {
    return this.prisma.$queryRaw<TrendRow[]>`
      SELECT DATE_FORMAT(DATE_ADD(m.publishedAt, INTERVAL ${Prisma.raw(String(WIB_OFFSET_H))} HOUR), '%Y-%m-%d') AS day,
             mb.brandId AS brandId, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative
      FROM mention_brands mb
      JOIN mentions m ON m.id = mb.mentionId
      WHERE ${this.where(f)} ${this.brandCond(f)}
      GROUP BY day, mb.brandId
      ORDER BY day, mb.brandId`;
  }

  byChannel(f: ResolvedFilter): Promise<(CountsRow & { channel: string })[]> {
    return this.prisma.$queryRaw<(CountsRow & { channel: string })[]>`
      SELECT m.channel AS channel, COUNT(*) AS total,
             CAST(SUM(m.sentimentLabel = 'POSITIVE') AS SIGNED) AS positive,
             CAST(SUM(m.sentimentLabel = 'NEUTRAL') AS SIGNED) AS neutral,
             CAST(SUM(m.sentimentLabel = 'NEGATIVE') AS SIGNED) AS negative
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)}
      GROUP BY m.channel
      ORDER BY total DESC`;
  }

  /** Daily totals in WIB days: mentions, reach, engagement and sentiment. */
  daily(f: ResolvedFilter) {
    return this.prisma.$queryRaw<
      (CountsRow & { day: string; reach: unknown; engagements: unknown })[]
    >`
      SELECT DATE_FORMAT(DATE_ADD(m.publishedAt, INTERVAL ${Prisma.raw(String(WIB_OFFSET_H))} HOUR), '%Y-%m-%d') AS day,
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

  /** Authors ranked by reach, engagement or mention count. */
  influencers(
    f: ResolvedFilter,
    sort: 'reach' | 'engagements' | 'mentions',
    limit: number,
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
             CAST(SUM(m.engagements) AS SIGNED) AS engagements
      FROM mentions m
      WHERE ${this.where(f)} ${this.brandExists(f)} AND m.authorHandle IS NOT NULL AND m.authorHandle <> ''
      GROUP BY m.channel, m.authorHandle
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
        FROM mentions m
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
        ? Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(m.extra, '$.gender'))`
        : dim === 'province'
          ? Prisma.sql`SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(m.extra, '$.hasc')), '.', 2)`
          : Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(m.extra, '$.country'))`;
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
}
