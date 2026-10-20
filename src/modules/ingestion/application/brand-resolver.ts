import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';

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
    const brands = await this.prisma.brand.findMany({ where: { projectId } });
    const byKeyword = new Map<string, Set<number>>();
    for (const b of brands) {
      const aliases = Array.isArray(b.aliases)
        ? (b.aliases as unknown[]).filter((a) => typeof a === 'string')
        : [];
      for (const k of [b.name, ...(aliases as string[])]) {
        const key = k.trim().toLowerCase();
        if (!key) continue;
        if (!byKeyword.has(key)) byKeyword.set(key, new Set());
        byKeyword.get(key)!.add(b.id);
      }
    }

    return {
      resolve(keywords) {
        const ids = new Set<number>();
        const unmatched: string[] = [];
        for (const k of keywords) {
          const hit = byKeyword.get(k.trim().toLowerCase());
          if (hit) hit.forEach((id) => ids.add(id));
          else unmatched.push(k);
        }
        return { brandIds: [...ids], unmatched };
      },
    };
  }
}
