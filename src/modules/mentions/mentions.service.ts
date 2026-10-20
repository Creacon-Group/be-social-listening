import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  type MentionFilterDto,
  FilterResolver,
  periodOf,
  type ResolvedFilter,
} from './mention-filter.js';

export type MentionSort = 'latest' | 'engagements' | 'reach';

export function mentionWhere(f: ResolvedFilter): Prisma.MentionWhereInput {
  return {
    projectId: f.projectId,
    publishedAt: { gte: f.from, lt: f.to },
    ...(f.channels && { channel: { in: f.channels } }),
    ...(f.sentiments && { sentimentLabel: { in: f.sentiments } }),
    ...(f.brandIds && { brands: { some: { brandId: { in: f.brandIds } } } }),
    ...(f.q && { content: { contains: f.q } }),
  };
}

const ORDER: Record<MentionSort, Prisma.MentionOrderByWithRelationInput[]> = {
  latest: [{ publishedAt: 'desc' }, { id: 'desc' }],
  engagements: [{ engagements: 'desc' }, { id: 'desc' }],
  reach: [{ reach: 'desc' }, { id: 'desc' }],
};

const mentionSelect = {
  id: true,
  externalId: true,
  channel: true,
  postType: true,
  title: true,
  content: true,
  url: true,
  publishedAt: true,
  authorHandle: true,
  authorName: true,
  authorFollowers: true,
  authorVerified: true,
  likes: true,
  shares: true,
  comments: true,
  views: true,
  reach: true,
  engagements: true,
  sentimentLabel: true,
  tags: true,
  brands: {
    select: { brand: { select: { id: true, name: true, isOwn: true } } },
  },
} satisfies Prisma.MentionSelect;

type MentionRow = Prisma.MentionGetPayload<{ select: typeof mentionSelect }>;
const toView = ({ brands, ...m }: MentionRow) => ({
  ...m,
  brands: brands.map((b) => b.brand),
});

@Injectable()
export class MentionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filters: FilterResolver,
  ) {}

  async search(
    projectId: number,
    dto: MentionFilterDto,
    opts: { page: number; pageSize: number; sort: MentionSort },
  ) {
    const f = await this.filters.resolve(projectId, dto);
    const where = mentionWhere(f);
    const [rows, total] = await Promise.all([
      this.prisma.mention.findMany({
        where,
        orderBy: ORDER[opts.sort],
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        select: mentionSelect,
      }),
      this.prisma.mention.count({ where }),
    ]);
    return {
      period: periodOf(f),
      items: rows.map(toView),
      page: opts.page,
      pageSize: opts.pageSize,
      total,
    };
  }

  /** Small, token-friendly sample for the AI assistant. */
  async sample(
    projectId: number,
    dto: MentionFilterDto,
    opts: { sort: MentionSort; limit: number },
  ) {
    const f = await this.filters.resolve(projectId, dto);
    const rows = await this.prisma.mention.findMany({
      where: mentionWhere(f),
      orderBy: ORDER[opts.sort],
      take: opts.limit,
      select: {
        externalId: true,
        channel: true,
        publishedAt: true,
        content: true,
        sentimentLabel: true,
        engagements: true,
        reach: true,
        url: true,
        brands: { select: { brand: { select: { name: true } } } },
      },
    });
    return {
      period: periodOf(f),
      mentions: rows.map(({ brands, content, ...r }) => ({
        ...r,
        brands: brands.map((b) => b.brand.name),
        content: (content ?? '').slice(0, 280),
      })),
    };
  }
}
