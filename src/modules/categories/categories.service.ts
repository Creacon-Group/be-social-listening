import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { asStringList, cleanList, ruleCondition } from './category-rules.js';

export interface CategoryInput {
  name: string;
  color?: string | null;
  zanrooTags?: string[];
  keywords?: string[];
}

const SAMPLE_ROWS = 20_000;

/**
 * Topic categories. Rules live on the category; the matches are materialised in
 * mention_categories so every dashboard query can filter and group by them cheaply.
 */
@Injectable()
export class CategoriesService {
  private readonly log = new Logger(CategoriesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: number) {
    const rows = await this.prisma.category.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { mentions: true } } },
    });
    return rows.map(({ _count, zanrooTags, keywords, ...c }) => ({
      ...c,
      zanrooTags: asStringList(zanrooTags),
      keywords: asStringList(keywords),
      mentionCount: _count.mentions,
    }));
  }

  async create(projectId: number, input: CategoryInput) {
    const data = this.clean(input);
    const max = await this.prisma.category.aggregate({
      where: { projectId },
      _max: { sortOrder: true },
    });
    const created = await this.prisma.category
      .create({
        data: { projectId, ...data, sortOrder: (max._max.sortOrder ?? 0) + 1 },
      })
      .catch((e) => this.duplicate(e));
    await this.apply(created.id);
    return this.one(projectId, created.id);
  }

  async update(projectId: number, id: number, input: CategoryInput) {
    await this.find(projectId, id);
    await this.prisma.category
      .update({ where: { id }, data: this.clean(input) })
      .catch((e) => this.duplicate(e));
    await this.apply(id);
    return this.one(projectId, id);
  }

  async remove(projectId: number, id: number) {
    await this.find(projectId, id);
    await this.prisma.category.delete({ where: { id } }); // links cascade
  }

  /** How many mentions a rule would match, with a few examples, before it is saved. */
  async preview(projectId: number, input: Omit<CategoryInput, 'name'>) {
    const cond = ruleCondition({
      zanrooTags: cleanList(input.zanrooTags, 150),
      keywords: cleanList(input.keywords, 60),
    });
    if (!cond) return { total: 0, samples: [] };
    const [count] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM mentions m WHERE m.projectId = ${projectId} AND ${cond}`;
    const samples = await this.prisma.$queryRaw<
      { id: number; channel: string; content: string | null }[]
    >`
      SELECT m.id, m.channel, LEFT(COALESCE(m.content, m.title), 200) AS content
      FROM mentions m WHERE m.projectId = ${projectId} AND ${cond}
      ORDER BY m.publishedAt DESC LIMIT 5`;
    return { total: Number(count.n), samples };
  }

  /**
   * Tag and category names Zanroo put on recent mentions, most used first, so admins pick
   * exact names instead of typing them.
   */
  async zanrooTags(projectId: number) {
    const rows = await this.prisma.$queryRaw<
      { tags: unknown; cats: unknown }[]
    >`
      SELECT m.tags AS tags, JSON_EXTRACT(m.extra, '$.categories') AS cats
      FROM mentions m
      WHERE m.projectId = ${projectId}
        AND (m.tags IS NOT NULL OR JSON_EXTRACT(m.extra, '$.categories') IS NOT NULL)
      ORDER BY m.id DESC
      LIMIT ${SAMPLE_ROWS}`;
    const counts = new Map<
      string,
      { name: string; kind: 'tag' | 'category'; count: number }
    >();
    const add = (v: unknown, kind: 'tag' | 'category') => {
      const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
      for (const name of asStringList(list)) {
        const key = `${kind}:${name}`;
        const hit = counts.get(key);
        if (hit) hit.count++;
        else counts.set(key, { name, kind, count: 1 });
      }
    };
    for (const r of rows) {
      add(r.tags, 'tag');
      add(r.cats, 'category');
    }
    return {
      sampled: rows.length,
      items: [...counts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 400),
    };
  }

  /** Recompute one category over all of its project's mentions. */
  async apply(categoryId: number) {
    const c = await this.prisma.category.findUniqueOrThrow({
      where: { id: categoryId },
    });
    const started = Date.now();
    await this.prisma.mentionCategory.deleteMany({ where: { categoryId } });
    const cond = ruleCondition({
      zanrooTags: asStringList(c.zanrooTags),
      keywords: asStringList(c.keywords),
    });
    if (!cond) return 0;
    const n = await this.prisma.$executeRaw`
      INSERT IGNORE INTO mention_categories (mentionId, categoryId)
      SELECT m.id, ${categoryId} FROM mentions m
      WHERE m.projectId = ${c.projectId} AND ${cond}`;
    this.log.log(
      `Category ${c.name}: ${n} mentions in ${Date.now() - started} ms`,
    );
    return n;
  }

  /** Called by ingestion: tag newly written mentions with every category of the project. */
  async applyToMentions(projectId: number, externalIds: string[]) {
    if (!externalIds.length) return;
    const categories = await this.prisma.category.findMany({
      where: { projectId },
    });
    for (const c of categories) {
      const cond = ruleCondition({
        zanrooTags: asStringList(c.zanrooTags),
        keywords: asStringList(c.keywords),
      });
      if (!cond) continue;
      await this.prisma.$executeRaw`
        INSERT IGNORE INTO mention_categories (mentionId, categoryId)
        SELECT m.id, ${c.id} FROM mentions m
        WHERE m.projectId = ${projectId}
          AND m.externalId IN (${Prisma.join(externalIds)})
          AND ${cond}`;
    }
  }

  private clean(input: CategoryInput) {
    return {
      name: input.name.trim().replace(/\s+/g, ' ').slice(0, 80),
      color: input.color ?? null,
      zanrooTags: cleanList(input.zanrooTags, 150),
      keywords: cleanList(input.keywords, 60),
    };
  }

  private async find(projectId: number, id: number) {
    const c = await this.prisma.category.findFirst({
      where: { id, projectId },
    });
    if (!c) throw new NotFoundException('Category not found');
    return c;
  }

  private async one(projectId: number, id: number) {
    return (await this.list(projectId)).find((c) => c.id === id)!;
  }

  private duplicate(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new ConflictException('A category with this name already exists');
    throw e;
  }
}
