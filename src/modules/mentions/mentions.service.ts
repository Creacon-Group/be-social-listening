import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma as PSql, type Prisma } from '../../generated/prisma/client.js';
import { brandExistsSql, mentionSqlWhere } from './mention-sql.js';
import {
  type MentionFilterDto,
  FilterResolver,
  periodOf,
  type ResolvedFilter,
} from './mention-filter.js';

export type MentionSort = 'latest' | 'engagements' | 'reach';

/** Prisma where for one page of ids picked by the shared SQL filter (see mention-sql.ts). */
export const idsWhere = (ids: number[]): Prisma.MentionWhereInput => ({
  id: { in: ids },
});

const ORDER_SQL: Record<MentionSort, Prisma.Sql> = {
  latest: PSql.sql`m.publishedAt DESC, m.id DESC`,
  engagements: PSql.sql`m.engagements DESC, m.id DESC`,
  reach: PSql.sql`m.reach DESC, m.id DESC`,
};

/** Ids of mentions matching the filter, in order; the same SQL as the dashboard numbers. */
export async function matchingIds(
  prisma: PrismaService,
  f: ResolvedFilter,
  sort: MentionSort,
  limit: number,
  offset = 0,
): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM mentions m
    WHERE ${mentionSqlWhere(f)} ${brandExistsSql(f)}
    ORDER BY ${ORDER_SQL[sort]}
    LIMIT ${limit} OFFSET ${offset}`;
  return rows.map((r) => Number(r.id));
}

export async function countMatching(prisma: PrismaService, f: ResolvedFilter) {
  const [r] = await prisma.$queryRaw<{ n: unknown }[]>`
    SELECT COUNT(*) AS n FROM mentions m WHERE ${mentionSqlWhere(f)} ${brandExistsSql(f)}`;
  return Number(r?.n ?? 0);
}

/** Rows fetched by id come back unordered; put them in the order of `ids`. */
export const inOrder = <T extends { id: number }>(ids: number[], rows: T[]) => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => !!r);
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
  extra: true,
  brands: {
    select: { brand: { select: { id: true, name: true, isOwn: true } } },
  },
  categories: {
    select: { category: { select: { id: true, name: true, color: true } } },
  },
} satisfies Prisma.MentionSelect;

type MentionRow = Prisma.MentionGetPayload<{ select: typeof mentionSelect }>;
type Extra = {
  where?: string;
  preview?: { images?: string[]; userLink?: string; bookmarks?: number };
} | null;

/** Card data for the Mentions page; `where` is the account whose post a comment replies to. */
const toView = ({ brands, categories, extra, ...m }: MentionRow) => {
  const x = extra as Extra;
  return {
    ...m,
    brands: brands.map((b) => b.brand),
    categories: categories.map((c) => c.category),
    preview: {
      where: x?.where ?? null,
      images: x?.preview?.images ?? [],
      userLink: x?.preview?.userLink ?? null,
      bookmarks: x?.preview?.bookmarks ?? 0,
    },
  };
};

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
    const [ids, total] = await Promise.all([
      matchingIds(
        this.prisma,
        f,
        opts.sort,
        opts.pageSize,
        (opts.page - 1) * opts.pageSize,
      ),
      countMatching(this.prisma, f),
    ]);
    const rows = await this.prisma.mention.findMany({
      where: idsWhere(ids),
      select: mentionSelect,
    });
    return {
      period: periodOf(f),
      items: inOrder(ids, rows).map(toView),
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
    const ids = await matchingIds(this.prisma, f, opts.sort, opts.limit);
    const found = await this.prisma.mention.findMany({
      where: idsWhere(ids),
      select: {
        id: true,
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
    const rows = inOrder(ids, found);
    return {
      period: periodOf(f),
      mentions: rows.map(({ brands, content, id: _id, ...r }) => ({
        ...r,
        brands: brands.map((b) => b.brand.name),
        content: (content ?? '').slice(0, 280),
      })),
    };
  }
}
