import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { BatchConfig } from './geo.service.js';
import { groupKpis, type ResponseRow, topDomains } from './geo-metrics.js';

/** Read side of GEO: KPIs per model x mode, competitors, cited domains and response drill-down. */
@Injectable()
export class GeoAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Valid (succeeded, evaluated) responses of a batch with their latest evaluation. */
  private async rows(batchId: number, filter: { category?: string } = {}) {
    const runs = await this.prisma.geoRun.findMany({
      where: {
        batchId,
        status: 'SUCCEEDED',
        ...(filter.category && {
          promptVersion: { prompt: { category: filter.category as never } },
        }),
      },
      select: {
        id: true,
        model: true,
        mode: true,
        citations: { select: { domain: true, ownedBy: true } },
        evaluations: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { version: true, results: true },
        },
      },
    });
    return runs;
  }

  private toRows(
    runs: Awaited<ReturnType<GeoAnalyticsService['rows']>>,
    config: BatchConfig,
  ): ResponseRow[] {
    return runs
      .filter((r) => r.evaluations.length)
      .map((r) => ({
        runId: r.id,
        model: r.model,
        mode: r.mode,
        citationsSupported: config.combos.some(
          (c) => c.model === r.model && c.mode === r.mode && c.citations,
        ),
        citations: r.citations,
        results: r.evaluations[0].results,
      }));
  }

  private async batchOf(projectId: number, batchId?: number) {
    const b = batchId
      ? await this.prisma.geoBatch.findFirst({
          where: { id: batchId, projectId },
        })
      : // default: the latest monthly run; manual runs are opened explicitly
        ((await this.prisma.geoBatch.findFirst({
          where: { projectId, kind: 'monthly' },
          orderBy: { period: 'desc' },
        })) ??
        (await this.prisma.geoBatch.findFirst({
          where: { projectId },
          orderBy: { startedAt: 'desc' },
        })));
    if (batchId && !b) throw new NotFoundException('Batch not found');
    return b;
  }

  /**
   * KPIs per model x mode (knowledge and search never mixed), with sample sizes, and the previous
   * month for comparison only when prompts, models and evaluation version are the same.
   */
  async overview(projectId: number, batchId?: number, category?: string) {
    const batch = await this.batchOf(projectId, batchId);
    if (!batch) return { batch: null, groups: [], previous: null };
    const config = batch.config as unknown as BatchConfig;
    const rows = this.toRows(await this.rows(batch.id, { category }), config);

    const groups = config.combos.map((c) => {
      const mine = rows.filter((r) => r.model === c.model && r.mode === c.mode);
      return {
        model: c.model,
        key: c.key,
        mode: c.mode,
        citationsSupported: c.citations,
        ...groupKpis(mine),
        domains: c.citations ? topDomains(mine, 15) : [],
      };
    });

    // Month-on-month comparison only between monthly runs.
    const prev =
      batch.kind === 'monthly' && batch.period
        ? await this.prisma.geoBatch.findFirst({
            where: { projectId, kind: 'monthly', period: { lt: batch.period } },
            orderBy: { period: 'desc' },
          })
        : null;
    let previous = null;
    if (prev) {
      const pc = prev.config as unknown as BatchConfig;
      const same = (a: unknown[], b: unknown[]) =>
        JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const comparable =
        same(pc.promptVersionIds, config.promptVersionIds) &&
        same(
          pc.combos.map((c) => `${c.model}:${c.mode}`),
          config.combos.map((c) => `${c.model}:${c.mode}`),
        ) &&
        pc.evaluationVersion === config.evaluationVersion;
      const prows = this.toRows(await this.rows(prev.id, { category }), pc);
      previous = {
        period: prev.period,
        comparable,
        groups: pc.combos.map((c) => {
          const k = groupKpis(
            prows.filter((r) => r.model === c.model && r.mode === c.mode),
          );
          return {
            model: c.model,
            mode: c.mode,
            mentionRate: k.mentionRate,
            recommendationRate: k.recommendationRate,
            sov: k.sov,
            validResponses: k.validResponses,
          };
        }),
      };
    }

    return {
      batch: {
        id: batch.id,
        period: batch.period,
        kind: batch.kind,
        label: batch.label,
        status: batch.status,
        total: batch.total,
        evaluator: config.evaluator,
        evaluationVersion: config.evaluationVersion,
        runsPerPrompt: config.runsPerPrompt,
        prompts: config.promptVersionIds.length,
      },
      groups,
      previous,
    };
  }

  /** Prompt explorer: one row per run with the target's result. */
  async runs(
    projectId: number,
    q: {
      batchId?: number;
      model?: string;
      mode?: string;
      status?: string;
      mentioned?: string;
      page?: number;
    },
  ) {
    const batch = await this.batchOf(projectId, q.batchId);
    if (!batch) return { items: [], total: 0, page: 1, pageSize: 50 };
    const pageSize = 50;
    const page = Math.max(1, q.page ?? 1);
    const where = {
      batchId: batch.id,
      ...(q.model && { model: q.model }),
      ...(q.mode && { mode: q.mode as never }),
      ...(q.status && { status: q.status as never }),
    };
    const runs = await this.prisma.geoRun.findMany({
      where,
      orderBy: [
        { promptVersionId: 'asc' },
        { model: 'asc' },
        { mode: 'asc' },
        { runNo: 'asc' },
      ],
      select: {
        id: true,
        model: true,
        mode: true,
        runNo: true,
        status: true,
        errorType: true,
        errorMessage: true,
        latencyMs: true,
        promptVersion: {
          select: {
            id: true,
            version: true,
            text: true,
            prompt: { select: { id: true, category: true, branded: true } },
          },
        },
        _count: { select: { citations: true } },
        evaluations: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { results: { where: { isTarget: true } } },
        },
      },
    });
    const items = runs
      .map((r) => {
        const t = r.evaluations[0]?.results[0] ?? null;
        return {
          id: r.id,
          model: r.model,
          mode: r.mode,
          runNo: r.runNo,
          status: r.status,
          errorType: r.errorType,
          errorMessage: r.errorMessage,
          latencyMs: r.latencyMs,
          citations: r._count.citations,
          prompt: {
            id: r.promptVersion.prompt.id,
            version: r.promptVersion.version,
            text: r.promptVersion.text,
            category: r.promptVersion.prompt.category,
            branded: r.promptVersion.prompt.branded,
          },
          target: t && {
            mentioned: t.mentioned,
            recommendation: t.recommendation,
            position: t.position,
            listSize: t.listSize,
            sentiment: t.sentiment,
          },
        };
      })
      .filter((r) =>
        q.mentioned === 'yes'
          ? r.target?.mentioned
          : q.mentioned === 'no'
            ? r.target && !r.target.mentioned
            : true,
      );
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize,
    };
  }

  /** Everything behind one run: prompt, raw answer, citations and all evaluation versions. */
  async run(projectId: number, runId: number) {
    const r = await this.prisma.geoRun.findFirst({
      where: { id: runId, projectId },
      include: {
        promptVersion: {
          include: { prompt: { select: { category: true, branded: true } } },
        },
        citations: true,
        evaluations: { orderBy: { id: 'desc' }, include: { results: true } },
      },
    });
    if (!r) throw new NotFoundException('Run not found');
    return r;
  }
}
