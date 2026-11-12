import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import { brandKeys, ignoredSet, keywordKey } from '../../../common/keywords.js';

export interface BrandIndex {
  resolve(keywords: string[]): { brandIds: number[]; unmatched: string[] };
}

/**
 * Exact, case-insensitive match between a keyword token and a brand name/alias.
 * Deliberately not substring matching: "tri" would catch unrelated words.
 * One keyword may point at several brands (joint keywords such as IOH or XLSmart).
 */
@Injectable()
export class BrandResolver {
  constructor(private readonly prisma: PrismaService) {}

  async load(projectId: number): Promise<BrandIndex> {
    const [brands, project] = await Promise.all([
      this.prisma.brand.findMany({ where: { projectId } }),
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { ignoredKeywords: true },
      }),
    ]);
    const byKeyword = new Map<string, Set<number>>();
    for (const b of brands) {
      for (const key of brandKeys(b)) {
        if (!byKeyword.has(key)) byKeyword.set(key, new Set());
        byKeyword.get(key)!.add(b.id);
      }
    }
    // Keywords marked "not a brand" are neither matched nor reported as unmatched.
    const ignored = ignoredSet(project?.ignoredKeywords);

    return {
      resolve(keywords) {
        const ids = new Set<number>();
        const unmatched: string[] = [];
        for (const k of keywords) {
          const key = keywordKey(k);
          const hit = byKeyword.get(key);
          if (hit) hit.forEach((id) => ids.add(id));
          else if (!ignored.has(key)) unmatched.push(k);
        }
        return { brandIds: [...ids], unmatched };
      },
    };
  }
}
