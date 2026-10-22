import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { InsightsService } from '../insights/insights.service.js';
import type { MentionFilterDto } from '../mentions/mention-filter.js';
import { barChart, C, lineChart, sentimentChart, toPng } from './charts.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const CHANNEL: Record<string, string> = {
  X: 'X',
  TIKTOK: 'TikTok',
  INSTAGRAM: 'Instagram',
  ONLINE_NEWS: 'Online News',
  FACEBOOK: 'Facebook',
  YOUTUBE: 'YouTube',
  BLOG: 'Blog',
};
export const channelLabel = (c: string) => CHANNEL[c] ?? c;

/** "1–30 September 2026", "28 Agustus – 3 September 2026", "28 Desember 2025 – 3 Januari 2026". */
export function rangeLabel(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (from === to) return `${fd} ${MONTHS[fm - 1]} ${fy}`;
  if (fy === ty && fm === tm) return `${fd}–${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fy === ty)
    return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  return `${fd} ${MONTHS[fm - 1]} ${fy} – ${td} ${MONTHS[tm - 1]} ${ty}`;
}

export type InsightMode = 'none' | 'existing' | 'generate';
export type ReportData = Awaited<ReturnType<ReportDataService['build']>>;

/** Everything a report needs, computed once and shared by the PDF, Excel and e-mail outputs. */
@Injectable()
export class ReportDataService {
  private readonly log = new Logger(ReportDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly insights: InsightsService,
  ) {}

  async build(projectId: number, dto: MentionFilterDto, mode: InsightMode) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, clientName: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const [overview, comp, trend, influencers, hashtags, brands] =
      await Promise.all([
        this.analytics.overview(projectId, dto),
        this.analytics.competitors(projectId, dto, { includeTrend: false }),
        this.analytics.trend(projectId, dto),
        this.analytics.influencers(projectId, dto, {
          sort: 'reach',
          limit: 10,
        }),
        this.analytics.hashtags(projectId, dto, 10),
        this.prisma.brand.findMany({
          where: { projectId },
          select: { id: true, color: true },
        }),
      ]);

    let insight: Awaited<ReturnType<InsightsService['get']>> | null = null;
    let insightNote: string | null = null;
    if (mode !== 'none') {
      try {
        insight = await this.insights.findForPeriod(projectId, dto);
        if (!insight && mode === 'generate' && overview.total)
          insight = await this.insights.generate(projectId, dto);
      } catch (e) {
        // A report without the AI section is still useful; say why it is missing.
        this.log.warn(`Insight unavailable: ${(e as Error).message}`);
        insightNote = `AI analysis unavailable: ${(e as Error).message.slice(0, 200)}`;
      }
      if (!insight && !insightNote)
        insightNote =
          'No AI analysis for this period yet. Generate one on the Insights page first.';
    }

    const client = project.clientName?.trim() || project.name;
    const period = overview.period;
    const label = rangeLabel(period.from, period.to);
    const colorOf = new Map(brands.map((b) => [b.id, b.color]));
    return {
      project: { id: project.id, name: project.name, client },
      title: `Summary Report Social Listening ${client} - ${label}`,
      period,
      periodLabel: label,
      overview,
      competitors: {
        ...comp,
        brands: comp.brands.map((b) => ({
          ...b,
          color: colorOf.get(b.brandId) ?? C.muted,
        })),
      },
      trend: trend.days,
      influencers: influencers.authors,
      sources: influencers.sources.slice(0, 10),
      hashtags: hashtags.hashtags,
      insight,
      insightNote,
    };
  }

  /** PNG charts shared by the PDF and the e-mail body. */
  async charts(d: ReportData) {
    const [mentions, reach, sov, sentiment, channels] = await Promise.all([
      toPng(
        lineChart({
          title: 'Mentions per day',
          points: d.trend.map((t) => ({ day: t.day, value: t.total })),
          color: C.ink,
        }),
        1000,
      ),
      toPng(
        lineChart({
          title: 'Reach per day',
          points: d.trend.map((t) => ({ day: t.day, value: t.reach })),
          color: C.muted,
        }),
        1000,
      ),
      toPng(
        barChart({
          title: 'Share of voice per brand',
          rows: d.competitors.brands.map((b) => ({
            label: b.name,
            value: b.sov,
            color: b.color,
            display: `${b.sov.toLocaleString('en-GB')}%`,
          })),
        }),
        1000,
      ),
      toPng(
        sentimentChart({
          title: 'Sentiment per brand',
          rows: d.competitors.brands.map((b) => ({
            label: b.name,
            positive: b.positive,
            neutral: b.neutral,
            negative: b.negative,
          })),
        }),
        1000,
      ),
      toPng(
        barChart({
          title: 'Volume per channel',
          rows: d.overview.channels.map((c) => ({
            label: channelLabel(c.channel),
            value: c.total,
            color: C.ink,
            display: c.total.toLocaleString('en-GB'),
          })),
        }),
        1000,
      ),
    ]);
    return { mentions, reach, sov, sentiment, channels };
  }
}
