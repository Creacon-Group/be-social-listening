import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { brandKeys, ignoredSet } from '../../common/keywords.js';

export interface KeywordRow {
  keyword: string;
  label: string;
  mentions: number;
  brands: { id: number; name: string }[];
  ignored: boolean;
}

/**
 * Brand tags come from Zanroo keywords. When a brand or its aliases change, recompute its tags
 * from mention_keywords so existing data follows the new mapping without re-uploading.
 * Mentions with no stored keywords (none in mentions.extra) keep their links untouched.
 */
@Injectable()
export class BrandTaggingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recompute links for the given brands (default: every brand of the project). */
  async retag(projectId: number, brandIds?: number[]) {
    const brands = await this.prisma.brand.findMany({
      where: { projectId, ...(brandIds ? { id: { in: brandIds } } : {}) },
      select: { id: true, name: true, aliases: true },
    });
    const result: { brandId: number; mentions: number }[] = [];
    for (const b of brands) {
      const keys = brandKeys(b);
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            DELETE FROM mention_brands
            WHERE brandId = ${b.id}
              AND mentionId IN (SELECT mentionId FROM mention_keywords WHERE projectId = ${projectId})`;
          if (keys.length)
            await tx.$executeRaw`
              INSERT IGNORE INTO mention_brands (mentionId, brandId)
              SELECT DISTINCT mentionId, ${b.id} FROM mention_keywords
              WHERE projectId = ${projectId} AND keyword IN (${Prisma.join(keys)})`;
        },
        { timeout: 120_000 },
      );
      result.push({
        brandId: b.id,
        mentions: await this.prisma.mentionBrand.count({
          where: { brandId: b.id },
        }),
      });
    }
    return result;
  }

  /** Every keyword seen in the project's data, with mention counts and the brands it maps to. */
  async keywords(projectId: number): Promise<KeywordRow[]> {
    const [rows, brands, project] = await Promise.all([
      this.prisma.$queryRaw<
        { keyword: string; label: string; mentions: bigint }[]
      >`
        SELECT keyword, MAX(label) AS label, COUNT(*) AS mentions
        FROM mention_keywords WHERE projectId = ${projectId}
        GROUP BY keyword ORDER BY mentions DESC LIMIT 1000`,
      this.prisma.brand.findMany({
        where: { projectId },
        select: { id: true, name: true, aliases: true },
      }),
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { ignoredKeywords: true },
      }),
    ]);
    const byKey = new Map<string, { id: number; name: string }[]>();
    for (const b of brands)
      for (const k of brandKeys(b))
        byKey.set(k, [...(byKey.get(k) ?? []), { id: b.id, name: b.name }]);
    const ignored = ignoredSet(project?.ignoredKeywords);
    return rows.map((r) => ({
      keyword: r.keyword,
      label: r.label,
      mentions: Number(r.mentions),
      brands: byKey.get(r.keyword) ?? [],
      ignored: ignored.has(r.keyword),
    }));
  }
}
