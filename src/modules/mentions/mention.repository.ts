import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
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
const BACKFILL_KEYS = ['preview', 'gender', 'hasc'] as const;

const backfillPatch = (extra?: Record<string, unknown>) => {
  const patch = Object.fromEntries(
    BACKFILL_KEYS.filter((k) => extra?.[k] !== undefined).map((k) => [
      k,
      extra![k],
    ]),
  );
  return Object.keys(patch).length ? JSON.stringify(patch) : null;
};

@Injectable()
export class PrismaMentionWriter implements MentionWriter {
  constructor(private readonly prisma: PrismaService) {}

  async insertMany(ctx: IngestionContext, items: ResolvedMention[]) {
    if (!items.length) return { inserted: 0, skipped: 0 };

    // The same MID can appear twice in one chunk; keep the first so counts stay honest.
    const unique = [
      ...new Map(items.map((i) => [i.mention.externalId, i])).values(),
    ];

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
            extra: m.extra as Prisma.InputJsonValue | undefined,
          })),
        });

        // Link only rows created by THIS batch, so a skipped duplicate keeps its original brand tags.
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

    return { inserted: count, skipped: items.length - count };
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
   * One UPDATE per 100 rows. `externalId IN (...)` with projectId hits the unique index directly;
   * an earlier JOIN on a UNION ALL list made TiDB scan the table and run past the 5 s
   * transaction timeout.
   */
  private async backfill(projectId: number, rows: ResolvedMention[]) {
    const patches = rows
      .map((i) => ({
        id: i.mention.externalId,
        patch: backfillPatch(i.mention.extra),
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
