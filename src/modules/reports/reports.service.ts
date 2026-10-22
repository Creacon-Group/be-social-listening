import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  FilterResolver,
  type MentionFilterDto,
  toWibYmd,
} from '../mentions/mention-filter.js';
import { CHART_CIDS, renderEmailHtml } from './report-email.js';
import { renderExcel } from './report-excel.js';
import { renderPdf } from './report-pdf.js';
import { ReportDataService } from './report-data.service.js';
import { MailService } from './mail.service.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ReportSettings {
  clientName: string | null;
  recipients: string[];
  monthlyEnabled: boolean;
  monthlyDay: number;
  lastMonthlyReport: string | null;
  emailConfigured: boolean;
}

const slug = (s: string) =>
  s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/** Exports (PDF, Excel), the summary e-mail, its settings and the monthly schedule. */
@Injectable()
export class ReportsService {
  private readonly log = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly data: ReportDataService,
    private readonly mail: MailService,
    private readonly filters: FilterResolver,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private fileName(
    d: { project: { client: string }; period: { from: string; to: string } },
    ext: string,
  ) {
    return `Summary-Report-${slug(d.project.client)}-${d.period.from}_${d.period.to}.${ext}`;
  }

  async pdf(projectId: number, dto: MentionFilterDto) {
    const d = await this.data.build(projectId, dto, 'generate');
    const buffer = await renderPdf(d, await this.data.charts(d));
    return { buffer, fileName: this.fileName(d, 'pdf') };
  }

  async excel(projectId: number, dto: MentionFilterDto) {
    const d = await this.data.build(projectId, dto, 'existing');
    const f = await this.filters.resolve(projectId, dto);
    const buffer = await renderExcel(d, this.prisma, f);
    return { buffer, fileName: this.fileName(d, 'xlsx') };
  }

  /** Summary e-mail: charts in the body, AI analysis, and the full PDF attached. */
  async sendEmail(
    projectId: number,
    dto: MentionFilterDto,
    recipients?: string[],
  ) {
    const settings = await this.settings(projectId);
    const to = (recipients?.length ? recipients : settings.recipients)
      .map((r) => r.trim())
      .filter(Boolean);
    if (!to.length)
      throw new BadRequestException(
        'Belum ada penerima. Isi daftar email penerima di halaman Laporan.',
      );
    const bad = to.filter((r) => !EMAIL.test(r));
    if (bad.length)
      throw new BadRequestException(`Email tidak valid: ${bad.join(', ')}`);
    if (!this.mail.configured)
      // Fail before spending an AI call on a report that cannot be sent.
      throw new BadRequestException(
        'Email belum dikonfigurasi di server (SMTP_*).',
      );

    const d = await this.data.build(projectId, dto, 'generate');
    const charts = await this.data.charts(d);
    const pdf = await renderPdf(d, charts);
    const appUrl = this.config.get('APP_URL', { infer: true });
    const html = renderEmailHtml(
      d,
      appUrl
        ? `${appUrl.replace(/\/$/, '')}/projects/${projectId}/overview`
        : null,
    );
    const text = [
      d.title,
      `Mentions ${d.overview.total}, reach ${d.overview.reach}, net sentiment ${d.overview.netSentiment}.`,
      d.insight
        ? `${d.insight.headline}\n${d.insight.findings.map((f, i) => `${i + 1}. ${f.title}: ${f.body}`).join('\n')}`
        : (d.insightNote ?? ''),
      'Laporan lengkap terlampir (PDF).',
    ].join('\n\n');
    const res = await this.mail.send({
      to,
      subject: d.title,
      html,
      text,
      attachments: [
        ...CHART_CIDS.map((cid) => ({
          filename: `${cid}.png`,
          content: charts[cid],
          cid,
          contentType: 'image/png',
        })),
        {
          filename: this.fileName(d, 'pdf'),
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
    });
    this.log.log(`Report "${d.title}" sent to ${to.length} recipient(s)`);
    return {
      subject: d.title,
      sentTo: to,
      messageId: res.messageId,
      withAnalysis: Boolean(d.insight),
    };
  }

  async settings(projectId: number): Promise<ReportSettings> {
    const p = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        clientName: true,
        reportRecipients: true,
        monthlyReportEnabled: true,
        monthlyReportDay: true,
        lastMonthlyReport: true,
      },
    });
    return {
      clientName: p.clientName,
      recipients: Array.isArray(p.reportRecipients)
        ? (p.reportRecipients as string[])
        : [],
      monthlyEnabled: p.monthlyReportEnabled,
      monthlyDay: p.monthlyReportDay,
      lastMonthlyReport: p.lastMonthlyReport,
      emailConfigured: this.mail.configured,
    };
  }

  async updateSettings(
    projectId: number,
    s: {
      clientName?: string | null;
      recipients: string[];
      monthlyEnabled: boolean;
      monthlyDay: number;
    },
  ) {
    const recipients = [
      ...new Set(
        s.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean),
      ),
    ];
    const bad = recipients.filter((r) => !EMAIL.test(r));
    if (bad.length)
      throw new BadRequestException(`Email tidak valid: ${bad.join(', ')}`);
    if (s.monthlyEnabled && !recipients.length)
      throw new BadRequestException(
        'Isi minimal satu penerima untuk laporan bulanan.',
      );
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        clientName: s.clientName?.trim() || null,
        reportRecipients: recipients,
        monthlyReportEnabled: s.monthlyEnabled,
        monthlyReportDay: s.monthlyDay,
      },
    });
    return this.settings(projectId);
  }

  /**
   * Daily cron: on or after each project's report day, send last month's report once.
   * "Last month" is the previous calendar month in WIB.
   */
  async runMonthly(now = new Date()) {
    const today = toWibYmd(now);
    const [y, m, day] = today.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1));
    const month = prev.toISOString().slice(0, 7);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);

    const projects = await this.prisma.project.findMany({
      where: {
        monthlyReportEnabled: true,
        monthlyReportDay: { lte: day },
        OR: [
          { lastMonthlyReport: null },
          { lastMonthlyReport: { not: month } },
        ],
      },
      select: { id: true, name: true },
    });
    const results: { projectId: number; status: string }[] = [];
    for (const p of projects) {
      try {
        const total = await this.prisma.mention.count({
          where: {
            projectId: p.id,
            publishedAt: {
              gte: new Date(`${from}T00:00:00+07:00`),
              lte: new Date(`${to}T23:59:59.999+07:00`),
            },
          },
        });
        if (!total) {
          // Data for the month is uploaded manually; try again tomorrow.
          results.push({ projectId: p.id, status: `no data for ${month} yet` });
          continue;
        }
        await this.sendEmail(p.id, { range: 'custom', from, to });
        await this.prisma.project.update({
          where: { id: p.id },
          data: { lastMonthlyReport: month },
        });
        results.push({ projectId: p.id, status: `sent ${month}` });
      } catch (e) {
        this.log.error(
          `Monthly report for project ${p.id} failed: ${(e as Error).message}`,
        );
        results.push({
          projectId: p.id,
          status: `failed: ${(e as Error).message}`,
        });
      }
    }
    return { today, month, results };
  }
}
