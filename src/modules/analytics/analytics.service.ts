import { Injectable } from '@nestjs/common';
import {
  FilterResolver,
  type MentionFilterDto,
  periodOf,
  toWibYmd,
} from '../mentions/mention-filter.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  AnalyticsRepository,
  type CountsRow,
  type Interval,
  TIERS,
} from './analytics.repository.js';
import type { ResolvedFilter } from '../mentions/mention-filter.js';
import { PROVINCES } from './regions.js';

export type InfluencerSort = 'reach' | 'engagements' | 'mentions';

const HASHTAG = /#[\p{L}\p{N}_]{2,60}/gu;
const DAY_MS = 86_400_000;

const num = (v: unknown) => Number(v ?? 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) =>
  whole ? round1((part / whole) * 100) : 0;

/**
 * Net Sentiment = (positive - negative) / base x 100, from label counts. The base is all mentions,
 * or positive + negative only when the project leaves neutral out (project setting).
 */
export const metrics = (r: CountsRow, includeNeutral = true) => {
  const total = num(r.total);
  const positive = num(r.positive);
  const negative = num(r.negative);
  return {
    total,
    positive,
    neutral: num(r.neutral),
    negative,
    netSentiment: pct(
      positive - negative,
      includeNeutral ? total : positive + negative,
    ),
  };
};

const HOUR_MS = 3_600_000;
const WIB_MS = 7 * HOUR_MS;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Every bucket key between from (inclusive) and to (exclusive), in the same format as bucketSql,
 * so empty buckets show as zero.
 */
export function bucketKeys(from: Date, to: Date, interval: Interval): string[] {
  const keys: string[] = [];
  const add = (k: string) => {
    if (keys[keys.length - 1] !== k) keys.push(k);
  };
  const w = (t: number) => new Date(t + WIB_MS); // read with getUTC* = WIB wall clock
  const key = (d: Date) => {
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const ymd = `${y}-${pad(mo)}-${pad(d.getUTCDate())}`;
    switch (interval) {
      case 'hour':
        return `${ymd} ${pad(d.getUTCHours())}:00`;
      case 'week': {
        const back = (d.getUTCDay() + 6) % 7; // days since Monday
        const mon = new Date(d.getTime() - back * DAY_MS);
        return `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
      }
      case 'month':
        return `${y}-${pad(mo)}`;
      case 'quarter':
        return `${y}-Q${Math.ceil(mo / 3)}`;
      case 'year':
        return String(y);
      default:
        return ymd;
    }
  };
  const step = interval === 'hour' ? HOUR_MS : DAY_MS;
  for (let t = from.getTime(); t < to.getTime(); t += step) add(key(w(t)));
  return keys;
}

/** Hourly buckets over long periods are unreadable and heavy: fall back to days past 31 days. */
const MAX_HOURLY_DAYS = 31;

const M = (f: ResolvedFilter) => (r: CountsRow) =>
  metrics(r, f.nssIncludeNeutral);

/** Previous period of the same length, for growth figures. */
const previousOf = (f: ResolvedFilter): ResolvedFilter => {
  const span = f.to.getTime() - f.from.getTime();
  return { ...f, from: new Date(f.from.getTime() - span), to: f.from };
};

const growth = (now: number, before: number) =>
  before ? round1(((now - before) / before) * 100) : null;

export type AccountTypeName = 'KOL' | 'MEDIA' | 'OFFICIAL' | 'OTHER';

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
    const mx = M(f);
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
        const m = mx(r ?? { total: 0, positive: 0, neutral: 0, negative: 0 });
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
                ...mx(x ?? { total: 0, positive: 0, neutral: 0, negative: 0 }),
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

  /**
   * Summary numbers: totals with growth against the previous period of the same length, what
   * engagement is made of, owned vs earned, and volume per channel.
   */
  async overview(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
    const [r, prev, b, channels] = await Promise.all([
      this.repo.overview(f),
      this.repo.overview(previousOf(f)),
      this.repo.breakdown(f),
      this.repo.byChannel(f),
    ]);
    const now = {
      ...mx(r),
      engagements: num(r.engagements),
      reach: num(r.reach),
    };
    const before = {
      ...mx(prev),
      engagements: num(prev.engagements),
      reach: num(prev.reach),
    };
    const ownedTotal = num(b.ownedTotal);
    return {
      period: periodOf(f),
      previousPeriod: periodOf(previousOf(f)),
      ...now,
      previous: before,
      growth: {
        total: growth(now.total, before.total),
        positive: growth(now.positive, before.positive),
        neutral: growth(now.neutral, before.neutral),
        negative: growth(now.negative, before.negative),
        engagements: growth(now.engagements, before.engagements),
        reach: growth(now.reach, before.reach),
        netSentiment: before.total
          ? round1(now.netSentiment - before.netSentiment)
          : null, // points, not %
      },
      engagementBreakdown: {
        likes: num(b.likes),
        comments: num(b.comments),
        shares: num(b.shares),
        views: num(b.views),
        bookmarks: num(b.bookmarks),
        reactions: {
          love: num(b.love),
          wow: num(b.wow),
          haha: num(b.haha),
          sad: num(b.sad),
          angry: num(b.angry),
          favorites: num(b.favorites),
        },
      },
      ownedEarned: {
        owned: {
          total: ownedTotal,
          engagements: num(b.ownedEngagements),
          reach: num(b.ownedReach),
        },
        earned: {
          total: now.total - ownedTotal,
          engagements: now.engagements - num(b.ownedEngagements),
          reach: now.reach - num(b.ownedReach),
        },
      },
      channels: channels.map((c) => ({ channel: c.channel, ...mx(c) })),
    };
  }

  /** Channel analysis: volume, sentiment, engagement, reach, views and owned share per channel. */
  async channels(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
    const rows = await this.repo.byChannel(f);
    const channels = rows.map((c) => {
      const total = num(c.total);
      const engagements = num(c.engagements);
      return {
        channel: c.channel,
        ...mx(c),
        engagements,
        reach: num(c.reach),
        views: num(c.views),
        owned: num(c.owned),
        earned: total - num(c.owned),
        engagementPerMention: total ? round1(engagements / total) : 0,
      };
    });
    const total = channels.reduce((s, c) => s + c.total, 0);
    const engagements = channels.reduce((s, c) => s + c.engagements, 0);
    return {
      period: periodOf(f),
      total,
      engagements,
      reach: channels.reduce((s, c) => s + c.reach, 0),
      engagementPerMention: total ? round1(engagements / total) : 0,
      channels: channels.map((c) => ({ ...c, share: pct(c.total, total) })),
    };
  }

  /** When people post: mentions and engagement per weekday x hour (WIB). */
  async heatmap(projectId: number, dto: MentionFilterDto) {
    const f = await this.filters.resolve(projectId, dto);
    const rows = await this.repo.heatmap(f);
    const cells = rows.map((r) => ({
      dow: num(r.dow), // 0 = Monday
      hour: num(r.hour),
      total: num(r.total),
      engagements: num(r.engagements),
    }));
    const peak = cells.reduce<(typeof cells)[number] | null>(
      (best, c) => (!best || c.total > best.total ? c : best),
      null,
    );
    return { period: periodOf(f), cells, peak };
  }

  /**
   * Zanroo keywords (brand names, products and campaign keywords such as "Activation Tri") by
   * volume. A mention with two keywords counts for both.
   */
  async keywords(projectId: number, dto: MentionFilterDto, limit = 100) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
    const rows = await this.repo.keywordRows(f);
    type Agg = {
      total: number;
      positive: number;
      neutral: number;
      negative: number;
      engagements: number;
      reach: number;
    };
    const agg = new Map<string, Agg>();
    for (const r of rows) {
      const list = (
        typeof r.keywords === 'string' ? JSON.parse(r.keywords) : r.keywords
      ) as string[] | null;
      for (const k of new Set(list ?? [])) {
        const a = agg.get(k) ?? {
          total: 0,
          positive: 0,
          neutral: 0,
          negative: 0,
          engagements: 0,
          reach: 0,
        };
        a.total++;
        if (r.sentimentLabel === 'POSITIVE') a.positive++;
        else if (r.sentimentLabel === 'NEGATIVE') a.negative++;
        else a.neutral++;
        a.engagements += num(r.engagements);
        a.reach += num(r.reach);
        agg.set(k, a);
      }
    }
    const total = rows.length;
    return {
      period: periodOf(f),
      mentionsWithKeyword: total,
      keywords: [...agg]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, limit)
        .map(([keyword, a]) => ({
          keyword,
          ...mx(a),
          engagements: a.engagements,
          reach: a.reach,
          share: pct(a.total, total),
        })),
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
    opts: { includeTrend?: boolean; interval?: Interval } = {},
  ) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
    const interval = this.intervalFor(f, opts.interval);
    const [rows, group, trend] = await Promise.all([
      this.repo.byBrand(f),
      this.repo.ownVsAll(f),
      opts.includeTrend === false
        ? Promise.resolve([])
        : this.repo.trendByBrand(f, interval),
    ]);

    const totalMentions = rows.reduce((s, r) => s + num(r.total), 0);
    const totalEngagements = rows.reduce((s, r) => s + num(r.engagements), 0);
    const totalReach = rows.reduce((s, r) => s + num(r.reach), 0);
    const own = mx(group);
    const brands = rows
      .map((r) => ({
        brandId: num(r.brandId),
        name: r.name,
        isOwn: Boolean(Number(r.isOwn)),
        ...mx(r),
        engagements: num(r.engagements),
        reach: num(r.reach),
        sov: pct(num(r.total), totalMentions),
        engagementShare: pct(num(r.engagements), totalEngagements),
        reachShare: pct(num(r.reach), totalReach),
        ratioToOwn: own.total ? round2(num(r.total) / own.total) : null,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      period: periodOf(f),
      interval,
      buckets: bucketKeys(f.from, f.to, interval),
      totalBrandMentions: totalMentions,
      own: { ...own, sov: pct(num(group.ownMentions), num(group.allMentions)) },
      brands,
      trend: trend.map((t) => ({
        day: String(t.day),
        brandId: num(t.brandId),
        ...mx(t),
        engagements: num(t.engagements),
        reach: num(t.reach),
      })),
    };
  }

  private intervalFor(f: ResolvedFilter, wanted?: Interval): Interval {
    const days = (f.to.getTime() - f.from.getTime()) / DAY_MS;
    if (wanted === 'hour' && days > MAX_HOURLY_DAYS) return 'day';
    return wanted ?? 'day';
  }

  /**
   * Mentions, reach, engagement and sentiment per time bucket (hour..year, WIB); empty buckets are
   * zero. `days` keeps its name for older clients; each item's `day` is the bucket key.
   */
  async trend(projectId: number, dto: MentionFilterDto, wanted?: Interval) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
    const interval = this.intervalFor(f, wanted);
    const rows = await this.repo.buckets(f, interval);
    const byKey = new Map(rows.map((r) => [String(r.day), r]));
    return {
      period: periodOf(f),
      interval,
      days: bucketKeys(f.from, f.to, interval).map((day) => {
        const r = byKey.get(day);
        return {
          day,
          ...mx(r ?? { total: 0, positive: 0, neutral: 0, negative: 0 }),
          reach: num(r?.reach),
          engagements: num(r?.engagements),
        };
      }),
    };
  }

  /** Top authors (with account type, tier and paid flag) and top sites/platforms. */
  async influencers(
    projectId: number,
    dto: MentionFilterDto,
    opts: {
      sort?: InfluencerSort;
      limit?: number;
      types?: AccountTypeName[];
    } = {},
  ) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
    const [authors, sources] = await Promise.all([
      this.repo.influencers(
        f,
        opts.sort ?? 'reach',
        opts.limit ?? 50,
        opts.types,
      ),
      this.repo.sources(f, 30),
    ]);
    return {
      period: periodOf(f),
      authors: authors.map((a) => {
        const rank = num(a.tierRank);
        return {
          channel: a.channel,
          handle: a.handle,
          name: a.name,
          followers: num(a.followers),
          verified: Boolean(Number(a.verified)),
          userLink: a.userLink && a.userLink !== 'null' ? a.userLink : null,
          accountType: a.accountType as AccountTypeName,
          typeSource: a.manualType ? ('manual' as const) : ('zanroo' as const),
          tier: rank ? TIERS[rank - 1].replace(' Influencer', '') : null,
          isPaid: a.isPaid === null ? null : Boolean(Number(a.isPaid)),
          ...mx(a),
          reach: num(a.reach),
          engagements: num(a.engagements),
        };
      }),
      sources: sources.map((s) => ({
        host: s.host,
        channel: s.channel,
        ...mx(s),
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
    const mx = M(f);
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
      const m = mx(g);
      genderRows.set(
        label,
        prev
          ? mx({
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
        ...mx(p),
        reach: num(p.reach),
      })),
      countries: country
        .filter((c) => clean(c.value))
        .map((c) => ({ code: c.value!.toUpperCase(), ...mx(c) })),
    };
  }

  /** Hashtags extracted from mention text, with volume, engagement and sentiment. */
  async hashtags(projectId: number, dto: MentionFilterDto, limit = 50) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
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
          ...mx(a),
          topChannel:
            Object.entries(channels).sort((x, y) => y[1] - x[1])[0]?.[0] ??
            null,
        })),
    };
  }

  /** Zanroo topic labels by volume and sentiment (input for AI Insights). */
  async topics(projectId: number, dto: MentionFilterDto, limit = 15) {
    const f = await this.filters.resolve(projectId, dto);
    const mx = M(f);
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
      .map(([topic, a]) => ({ topic, ...mx(a), reach: a.reach }));
  }
}
