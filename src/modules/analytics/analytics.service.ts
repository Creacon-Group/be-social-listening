import { Injectable } from '@nestjs/common';
import {
  FilterResolver,
  type MentionFilterDto,
  periodOf,
  toWibYmd,
} from '../mentions/mention-filter.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AnalyticsRepository, type CountsRow } from './analytics.repository.js';
import { PROVINCES } from './regions.js';

export type InfluencerSort = 'reach' | 'engagements' | 'mentions';

const HASHTAG = /#[\p{L}\p{N}_]{2,60}/gu;
const DAY_MS = 86_400_000;

const num = (v: unknown) => Number(v ?? 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) =>
  whole ? round1((part / whole) * 100) : 0;

/** Net Sentiment = (positive - negative) / total x 100, from label counts. */
export const metrics = (r: CountsRow) => {
  const total = num(r.total);
  const positive = num(r.positive);
  const negative = num(r.negative);
  return {
    total,
    positive,
    neutral: num(r.neutral),
    negative,
    netSentiment: pct(positive - negative, total),
  };
};

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly filters: FilterResolver,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Topics: volume, sentiment and change against the previous period of the same length,
   * a brand split per topic, and a daily trend. Share is of all mentions in the filter, so
   * shares can add up to more than 100% (a mention can sit in two topics).
   */
  async categoryTopics(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const span = f.to.getTime() - f.from.getTime();
    const prev = { ...f, from: new Date(f.from.getTime() - span), to: f.from };
    const [categories, brands, rows, prevRows, coverage, byBrand, trend] =
      await Promise.all([
        this.prisma.category.findMany({
          where: { projectId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, color: true },
        }),
        this.prisma.brand.findMany({
          where: { projectId },
          select: { id: true, name: true, isOwn: true, color: true },
        }),
        this.repo.byCategory(f),
        this.repo.byCategory(prev),
        this.repo.categoryCoverage(f),
        this.repo.categoryByBrand(f),
        this.repo.categoryTrend(f),
      ]);
    const total = num(coverage.total);
    const rowOf = new Map(rows.map((r) => [r.categoryId, r]));
    const prevOf = new Map(prevRows.map((r) => [r.categoryId, num(r.total)]));
    const days = this.dayList(f.from, f.to);

    const topics = categories
      .map((c) => {
        const r = rowOf.get(c.id);
        const m = metrics(
          r ?? { total: 0, positive: 0, neutral: 0, negative: 0 },
        );
        const before = prevOf.get(c.id) ?? 0;
        const perDay = new Map(
          trend
            .filter((t) => t.categoryId === c.id)
            .map((t) => [t.day, num(t.total)]),
        );
        return {
          categoryId: c.id,
          name: c.name,
          color: c.color,
          ...m,
          engagements: num(r?.engagements),
          share: pct(m.total, total),
          previousTotal: before,
          change: before ? round1(((m.total - before) / before) * 100) : null,
          days: days.map((day) => ({ day, total: perDay.get(day) ?? 0 })),
          brands: brands
            .map((b) => {
              const x = byBrand.find(
                (y) => y.categoryId === c.id && y.brandId === b.id,
              );
              return {
                brandId: b.id,
                name: b.name,
                isOwn: b.isOwn,
                color: b.color,
                ...metrics(
                  x ?? { total: 0, positive: 0, neutral: 0, negative: 0 },
                ),
              };
            })
            .filter((b) => b.total > 0)
            .sort((a, b) => b.total - a.total),
        };
      })
      .sort((a, b) => b.total - a.total);

    return {
      period: periodOf(f),
      total,
      uncategorized: num(coverage.uncategorized),
      categorized: total - num(coverage.uncategorized),
      topics,
    };
  }

  private dayList(from: Date, to: Date) {
    const out: string[] = [];
    for (let t = from.getTime(); t < to.getTime(); t += DAY_MS)
      out.push(toWibYmd(new Date(t)));
    return out;
  }

  async dataAsOf(projectId: number) {
    const d = await this.filters.dataAsOf(projectId);
    return { dataAsOf: d, dataAsOfWib: d ? toWibYmd(d) : null };
  }

  async overview(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const [r, channels] = await Promise.all([
      this.repo.overview(f),
      this.repo.byChannel(f),
    ]);
    return {
      period: periodOf(f),
      ...metrics(r),
      engagements: num(r.engagements),
      reach: num(r.reach),
      channels: channels.map((c) => ({ channel: c.channel, ...metrics(c) })),
    };
  }

  /**
   * Brand comparison.
   * - volume: mentions naming the brand; a mention naming two brands counts for both.
   * - sov: brand volume / sum of all brand volumes (sums to 100%).
   * - ratioToOwn: brand volume / own-brand unique mentions (Indosat + Tri counted once).
   * - own: own brands as one group, unique mentions; sov here = own / all mentions naming any brand.
   */
  async competitors(
    projectId: number,
    dto: MentionFilterDto,
    opts: { includeTrend?: boolean } = {},
  ) {
    const f = await this.filters.resolve(projectId, dto);
    const [rows, group, trend] = await Promise.all([
      this.repo.byBrand(f),
      this.repo.ownVsAll(f),
      opts.includeTrend === false
        ? Promise.resolve([])
        : this.repo.trendByBrand(f),
    ]);

    const totalMentions = rows.reduce((s, r) => s + num(r.total), 0);
    const own = metrics(group);
    const brands = rows
      .map((r) => ({
        brandId: num(r.brandId),
        name: r.name,
        isOwn: Boolean(Number(r.isOwn)),
        ...metrics(r),
        sov: pct(num(r.total), totalMentions),
        ratioToOwn: own.total ? round2(num(r.total) / own.total) : null,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      period: periodOf(f),
      totalBrandMentions: totalMentions,
      own: { ...own, sov: pct(num(group.ownMentions), num(group.allMentions)) },
      brands,
      trend: trend.map((t) => ({
        day: String(t.day),
        brandId: num(t.brandId),
        ...metrics(t),
      })),
    };
  }

  /** Daily mentions, reach and sentiment; days without mentions are filled with zero. */
  async trend(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const rows = await this.repo.daily(f);
    const byDay = new Map(rows.map((r) => [String(r.day), r]));
    const period = periodOf(f);
    const days: string[] = [];
    for (
      let t = Date.parse(`${period.from}T00:00:00Z`);
      t <= Date.parse(`${period.to}T00:00:00Z`);
      t += DAY_MS
    )
      days.push(new Date(t).toISOString().slice(0, 10));
    return {
      period,
      days: days.map((day) => {
        const r = byDay.get(day);
        return {
          day,
          ...metrics(r ?? { total: 0, positive: 0, neutral: 0, negative: 0 }),
          reach: num(r?.reach),
          engagements: num(r?.engagements),
        };
      }),
    };
  }

  /** Top authors and top sites/platforms. */
  async influencers(
    projectId: number,
    dto: MentionFilterDto,
    opts: { sort?: InfluencerSort; limit?: number } = {},
  ) {
    const f = await this.filters.resolve(projectId, dto);
    const [authors, sources] = await Promise.all([
      this.repo.influencers(f, opts.sort ?? 'reach', opts.limit ?? 50),
      this.repo.sources(f, 30),
    ]);
    return {
      period: periodOf(f),
      authors: authors.map((a) => ({
        channel: a.channel,
        handle: a.handle,
        name: a.name,
        followers: num(a.followers),
        verified: Boolean(Number(a.verified)),
        userLink: a.userLink && a.userLink !== 'null' ? a.userLink : null,
        ...metrics(a),
        reach: num(a.reach),
        engagements: num(a.engagements),
      })),
      sources: sources.map((s) => ({
        host: s.host,
        channel: s.channel,
        ...metrics(s),
        reach: num(s.reach),
        engagements: num(s.engagements),
      })),
    };
  }

  /**
   * What the export holds about authors: gender (mostly unknown), province and country.
   * Age is not in the Zanroo export.
   */
  async demographics(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const [gender, province, country] = await Promise.all([
      this.repo.demographic(f, 'gender'),
      this.repo.demographic(f, 'province'),
      this.repo.demographic(f, 'country'),
    ]);
    const clean = (v: string | null) =>
      v && !['null', 'none', 'unknown'].includes(v.toLowerCase()) ? v : null; // Zanroo writes "none" when it has no location
    const GENDER: Record<string, string> = {
      Male: 'Male',
      Female: 'Female',
    };
    const genderRows = new Map<string, ReturnType<typeof metrics>>();
    for (const g of gender) {
      const label = GENDER[clean(g.value) ?? ''] ?? 'Unknown';
      const prev = genderRows.get(label);
      const m = metrics(g);
      genderRows.set(
        label,
        prev
          ? metrics({
              total: prev.total + m.total,
              positive: prev.positive + m.positive,
              neutral: prev.neutral + m.neutral,
              negative: prev.negative + m.negative,
            })
          : m,
      );
    }
    const total = gender.reduce((s, g) => s + num(g.total), 0);
    const located = province.filter((p) => clean(p.value));
    return {
      period: periodOf(f),
      total,
      gender: [...genderRows].map(([label, m]) => ({ label, ...m })),
      located: located.reduce((s, p) => s + num(p.total), 0),
      provinces: located.map((p) => ({
        code: p.value!,
        name: PROVINCES[p.value!] ?? p.value!,
        ...metrics(p),
        reach: num(p.reach),
      })),
      countries: country
        .filter((c) => clean(c.value))
        .map((c) => ({ code: c.value!.toUpperCase(), ...metrics(c) })),
    };
  }

  /** Hashtags extracted from mention text, with volume, engagement and sentiment. */
  async hashtags(projectId: number, dto: MentionFilterDto, limit = 50) {
    const f = await this.filters.resolve(projectId, dto);
    const rows = await this.repo.hashtagRows(f);
    type Agg = {
      tag: string;
      total: number;
      positive: number;
      neutral: number;
      negative: number;
      engagements: number;
      reach: number;
      channels: Record<string, number>;
    };
    const tags = new Map<string, Agg>();
    let withHashtag = 0;
    for (const r of rows) {
      const found = new Set(
        (r.content.match(HASHTAG) ?? []).map((t) => t.toLowerCase()),
      );
      if (found.size) withHashtag++;
      for (const tag of found) {
        const a =
          tags.get(tag) ??
          ({
            tag,
            total: 0,
            positive: 0,
            neutral: 0,
            negative: 0,
            engagements: 0,
            reach: 0,
            channels: {},
          } satisfies Agg);
        a.total++;
        if (r.sentimentLabel === 'POSITIVE') a.positive++;
        else if (r.sentimentLabel === 'NEGATIVE') a.negative++;
        else a.neutral++;
        a.engagements += num(r.engagements);
        a.reach += num(r.reach);
        a.channels[r.channel] = (a.channels[r.channel] ?? 0) + 1;
        tags.set(tag, a);
      }
    }
    return {
      period: periodOf(f),
      mentionsWithHashtag: withHashtag,
      uniqueHashtags: tags.size,
      hashtags: [...tags.values()]
        .sort((a, b) => b.total - a.total || b.engagements - a.engagements)
        .slice(0, limit)
        .map(({ channels, ...a }) => ({
          ...a,
          ...metrics(a),
          topChannel:
            Object.entries(channels).sort((x, y) => y[1] - x[1])[0]?.[0] ??
            null,
        })),
    };
  }

  /** Zanroo topic labels by volume and sentiment (input for AI Insights). */
  async topics(projectId: number, dto: MentionFilterDto, limit = 15) {
    const f = await this.filters.resolve(projectId, dto);
    const rows = await this.repo.topicRows(f);
    const agg = new Map<
      string,
      {
        total: number;
        positive: number;
        neutral: number;
        negative: number;
        reach: number;
      }
    >();
    for (const r of rows) {
      const list = (
        typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags
      ) as string[] | null;
      for (const t of new Set(list ?? [])) {
        const a = agg.get(t) ?? {
          total: 0,
          positive: 0,
          neutral: 0,
          negative: 0,
          reach: 0,
        };
        a.total++;
        if (r.sentimentLabel === 'POSITIVE') a.positive++;
        else if (r.sentimentLabel === 'NEGATIVE') a.negative++;
        else a.neutral++;
        a.reach += num(r.reach);
        agg.set(t, a);
      }
    }
    return [...agg]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, limit)
      .map(([topic, a]) => ({ topic, ...metrics(a), reach: a.reach }));
  }
}
