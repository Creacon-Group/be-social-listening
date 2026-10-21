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
}
export const MENTION_WRITER = Symbol('MENTION_WRITER');

@Injectable()
export class PrismaMentionWriter implements MentionWriter {
  constructor(private readonly prisma: PrismaService) {}

  async insertMany(ctx: IngestionContext, items: ResolvedMention[]) {
    if (!items.length) return { inserted: 0, skipped: 0 };

    // The same MID can appear twice in one chunk; keep the first so counts stay honest.
    const unique = [
      ...new Map(items.map((i) => [i.mention.externalId, i])).values(),
    ];

    return this.prisma.$transaction(async (tx) => {
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
        await tx.mentionBrand.createMany({ data: links, skipDuplicates: true });

      // Rows that already existed keep their data, but get preview fields (images, profile link)
      // added by later exports: re-uploading a file backfills them. One statement per chunk.
      const previews = unique.filter(
        (i) =>
          !idByExternal.has(i.mention.externalId) && i.mention.extra?.preview,
      );
      if (previews.length) {
        const values = Prisma.join(
          previews.map(
            (i) =>
              Prisma.sql`SELECT ${i.mention.externalId} AS externalId, ${JSON.stringify({ preview: i.mention.extra!.preview })} AS patch`,
          ),
          ' UNION ALL ',
        );
        await tx.$executeRaw`
          UPDATE mentions m
          JOIN (${values}) v ON v.externalId = m.externalId
          SET m.extra = JSON_MERGE_PATCH(COALESCE(m.extra, JSON_OBJECT()), CAST(v.patch AS JSON))
          WHERE m.projectId = ${ctx.projectId}`;
      }

      return { inserted: count, skipped: items.length - count };
    });
  }
}
