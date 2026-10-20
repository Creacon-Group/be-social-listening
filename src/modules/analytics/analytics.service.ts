import { Injectable } from '@nestjs/common';
import {
  FilterResolver,
  type MentionFilterDto,
  periodOf,
  toWibYmd,
} from '../mentions/mention-filter.js';
import { AnalyticsRepository, type CountsRow } from './analytics.repository.js';

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
  ) {}

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
}
