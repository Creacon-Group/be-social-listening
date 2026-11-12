import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { derivedSet } from './mention-sql.js';
import { keywordKey } from '../../common/keywords.js';
import type {
  IngestionContext,
  ResolvedMention,
} from '../ingestion/domain/normalized-mention.js';

/** PORT used by the ingestion core. */
export interface MentionWriter {
  insertMany(
    ctx: IngestionContext,
    items: ResolvedMention[],
  ): Promise<{ inserted: number; skipped: number }>;
  /** Overwrite engagement and sentiment of rows that already exist (sources that send updates). */
  refreshMetrics(projectId: number, items: ResolvedMention[]): Promise<void>;
  remove(projectId: number, externalIds: string[]): Promise<number>;
}
export const MENTION_WRITER = Symbol('MENTION_WRITER');

/** `extra` keys copied onto rows that already exist when the same mention is uploaded again. */
const BACKFILL_KEYS = [
  'preview',
  'gender',
  'hasc',
  'keywords',
  'keywordType',
  'reactions',
] as const;

const backfillPatch = (extra?: Record<string, unknown>) => {
  const patch = Object.fromEntries(
    BACKFILL_KEYS.filter((k) => extra?.[k] !== undefined).map((k) => [
      k,
      extra![k],
    ]),
  );
  return Object.keys(patch).length ? JSON.stringify(patch) : null;
};

/** The raw Zanroo keywords are kept on the row: keyword and campaign breakdowns read them. */
const withKeywords = (m: ResolvedMention['mention']) =>
  m.brandKeywords.length ? { ...m.extra, keywords: m.brandKeywords } : m.extra;

const union = <T>(a?: T[], b?: T[]) =>
  a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;

export function mergeByExternalId(items: ResolvedMention[]) {
  const byId = new Map<string, ResolvedMention>();
  for (const item of items) {
    const first = byId.get(item.mention.externalId);
    if (!first) {
      byId.set(item.mention.externalId, item);
      continue;
    }
    byId.set(item.mention.externalId, {
      brandIds: union(first.brandIds, item.brandIds)!,
      mention: {
        ...first.mention,
        brandKeywords: union(
          first.mention.brandKeywords,
          item.mention.brandKeywords,
        )!,
        tags: union(first.mention.tags, item.mention.tags),
      },
    });
  }
  return [...byId.values()];
}

@Injectable()
export class PrismaMentionWriter implements MentionWriter {
  constructor(private readonly prisma: PrismaService) {}

  async insertMany(ctx: IngestionContext, items: ResolvedMention[]) {
    if (!items.length) return { inserted: 0, skipped: 0 };

    // The same MID can appear several times in one chunk (Zanroo: one row per keyword).
    // Keep one row and merge the brands, keywords and tags of the others into it.
    const unique = mergeByExternalId(items);

    const { count, existing } = await this.prisma.$transaction(
      async (tx) => {
        // skipDuplicates = INSERT IGNORE: an existing (projectId, externalId) is skipped, never overwritten.
        const { count } = await tx.mention.createMany({
          skipDuplicates: true,
          data: unique.map(({ mention: m }) => ({
            projectId: ctx.projectId,
            batchId: ctx.batchId,
            sourceType: ctx.sourceType,
            externalId: m.externalId,
            channel: m.channel,
            postType: m.postType,
            title: m.title,
            content: m.content,
            url: m.url,
            publishedAt: m.publishedAt,
            authorHandle: m.author.handle,
            authorName: m.author.name,
            authorFollowers: m.author.followers,
            authorVerified: m.author.verified ?? false,
            likes: m.engagement.likes,
            shares: m.engagement.shares,
            comments: m.engagement.comments,
            views: m.engagement.views,
            reach: m.engagement.reach,
            engagements: m.engagement.total,
            sentimentLabel: m.sentiment.label,
            sentimentScore: m.sentiment.score,
            location: m.location,
            tags: m.tags as Prisma.InputJsonValue | undefined,
            extra: withKeywords(m) as Prisma.InputJsonValue | undefined,
          })),
        });

        // Link rows created by THIS batch here; rows that already existed get any missing links in syncKeywords (added, never removed).
        const rows = await tx.mention.findMany({
          where: {
            projectId: ctx.projectId,
            batchId: ctx.batchId,
            externalId: { in: unique.map((i) => i.mention.externalId) },
          },
          select: { id: true, externalId: true },
        });
        const idByExternal = new Map(rows.map((r) => [r.externalId, r.id]));

        const links = unique.flatMap(({ mention, brandIds }) => {
          const mentionId = idByExternal.get(mention.externalId);
          return mentionId
            ? brandIds.map((brandId) => ({ mentionId, brandId }))
            : [];
        });
        if (links.length)
          await tx.mentionBrand.createMany({
            data: links,
            skipDuplicates: true,
          });

        return {
          count,
          existing: unique.filter(
            (i) => !idByExternal.has(i.mention.externalId),
          ),
        };
      },
      { timeout: 30_000 }, // remote databases (TiDB Cloud) need more than the 5 s default
    );

    // Outside the transaction: rows that already existed keep their data but get fields added
    // in later versions (preview, gender, region), so re-uploading a file backfills them.
    await this.backfill(ctx.projectId, existing);
    await this.syncKeywords(ctx.projectId, unique, existing);
    await this.syncDerived(
      ctx.projectId,
      unique.map((i) => i.mention.externalId),
    );

    return { inserted: count, skipped: unique.length - count };
  }

  async refreshMetrics(projectId: number, items: ResolvedMention[]) {
    for (let i = 0; i < items.length; i += 25) {
      await Promise.all(
        items.slice(i, i + 25).map(({ mention: m }) =>
          this.prisma.mention.updateMany({
            where: { projectId, externalId: m.externalId },
            data: {
              likes: m.engagement.likes,
              shares: m.engagement.shares,
              comments: m.engagement.comments,
              views: m.engagement.views,
              reach: m.engagement.reach,
              engagements: m.engagement.total,
              sentimentLabel: m.sentiment.label,
            },
          }),
        ),
      );
    }
  }

  async remove(projectId: number, externalIds: string[]) {
    if (!externalIds.length) return 0;
    const { count } = await this.prisma.mention.deleteMany({
      where: { projectId, externalId: { in: externalIds } },
    });
    return count;
  }

  /**
   * Store each mention's Zanroo keywords (new and existing rows) so brand tags can be recomputed
   * later, and add brand links that existing rows are missing. Links are only added here, never
   * removed: BrandTaggingService.retag recomputes them when a brand changes.
   */
  private async syncKeywords(
    projectId: number,
    items: ResolvedMention[],
    existing: ResolvedMention[],
  ) {
    const existingIds = new Set(existing.map((e) => e.mention.externalId));
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500);
      const rows = await this.prisma.mention.findMany({
        where: {
          projectId,
          externalId: { in: part.map((p) => p.mention.externalId) },
        },
        select: { id: true, externalId: true },
      });
      const idOf = new Map(rows.map((r) => [r.externalId, r.id]));
      const keywords = part.flatMap(({ mention: m }) => {
        const mentionId = idOf.get(m.externalId);
        if (!mentionId) return [];
        const seen = new Set<string>();
        return m.brandKeywords.flatMap((label) => {
          const keyword = keywordKey(label);
          if (!keyword || seen.has(keyword)) return [];
          seen.add(keyword);
          return [
            {
              mentionId,
              projectId,
              keyword,
              label: label.trim().slice(0, 191),
            },
          ];
        });
      });
      if (keywords.length)
        await this.prisma.mentionKeyword.createMany({
          data: keywords,
          skipDuplicates: true,
        });
      const links = part
        .filter((p) => existingIds.has(p.mention.externalId))
        .flatMap(({ mention, brandIds }) => {
          const mentionId = idOf.get(mention.externalId);
          return mentionId
            ? brandIds.map((brandId) => ({ mentionId, brandId }))
            : [];
        });
      if (links.length)
        await this.prisma.mentionBrand.createMany({
          data: links,
          skipDuplicates: true,
        });
    }
  }

  /** Fill the derived columns (owned, tier, demographics, reactions) of these rows from tags and extra. */
  private async syncDerived(projectId: number, externalIds: string[]) {
    for (let i = 0; i < externalIds.length; i += 500) {
      await this.prisma.$executeRaw`
        UPDATE mentions m SET ${derivedSet()}
        WHERE m.projectId = ${projectId} AND m.externalId IN (${Prisma.join(externalIds.slice(i, i + 500))})`;
    }
  }

  /**
   * One UPDATE per 100 rows. `externalId IN (...)` with projectId hits the unique index directly;
   * an earlier JOIN on a UNION ALL list made TiDB scan the table and run past the 5 s
   * transaction timeout.
   */
  private async backfill(projectId: number, rows: ResolvedMention[]) {
    const patches = rows
      .map((i) => ({
        id: i.mention.externalId,
        patch: backfillPatch(withKeywords(i.mention)),
      }))
      .filter((i): i is { id: string; patch: string } => i.patch !== null);
    for (let i = 0; i < patches.length; i += 100) {
      const part = patches.slice(i, i + 100);
      const cases = Prisma.join(
        part.map((p) => Prisma.sql`WHEN ${p.id} THEN ${p.patch}`),
        ' ',
      );
      await this.prisma.$executeRaw`
        UPDATE mentions
        SET extra = JSON_MERGE_PATCH(COALESCE(extra, JSON_OBJECT()), CAST(CASE externalId ${cases} END AS JSON))
        WHERE projectId = ${projectId} AND externalId IN (${Prisma.join(part.map((p) => p.id))})`;
    }
  }
}
