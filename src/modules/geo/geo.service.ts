import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  GeoPromptCategory,
  GeoPromptStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { BackgroundRunner } from '../ingestion/application/background-runner.js';
import {
  buildResults,
  type Entity,
  EVALUATION_VERSION,
  evaluatorPrompt,
  findMentions,
  parseEvaluatorJson,
} from './geo-evaluator.js';
import {
  type GeoModeName,
  type GeoModelKey,
  ProviderError,
  SumoPodClient,
} from './sumopod.client.js';

export const MAX_PROMPTS = 50;
const CONCURRENCY = 3;
const STALE_AFTER_MS = 10 * 60_000;
const WIB_MS = 7 * 3_600_000;

/** Calendar month in WIB, e.g. "2026-11". */
export const wibPeriod = (d = new Date()) =>
  new Date(d.getTime() + WIB_MS).toISOString().slice(0, 7);
const wibDay = (d = new Date()) => new Date(d.getTime() + WIB_MS).getUTCDate();

export interface GeoProfile {
  targetName?: string;
  industry?: string;
  market?: string;
  language?: string;
  description?: string;
}

type GeoEntity = Entity & { domains: string[] };

export interface BatchConfig {
  combos: {
    model: string;
    key: GeoModelKey;
    mode: GeoModeName;
    citations: boolean;
  }[];
  runsPerPrompt: number;
  evaluator: string;
  evaluationVersion: string;
  maxTokens: number;
  promptVersionIds: number[];
}

const domainsOf = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((d) => d.toLowerCase().replace(/^www\./, ''))
    : [];
const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const owns = (domain: string, list: string[]) =>
  list.some((d) => domain === d || domain.endsWith(`.${d}`));

@Injectable()
export class GeoService {
  private readonly log = new Logger(GeoService.name);
  private readonly timeBudgetMs: number | undefined;
  private readonly evaluatorKey: GeoModelKey;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: SumoPodClient,
    private readonly background: BackgroundRunner,
    config: ConfigService<Env, true>,
  ) {
    this.timeBudgetMs =
      config.get('GEO_TIME_BUDGET_MS', { infer: true }) ??
      (config.get('VERCEL', { infer: true }) ? 240_000 : undefined);
    this.evaluatorKey = config.get('GEO_EVALUATOR', { infer: true });
  }

  // ───────── Settings ─────────

  async settings(projectId: number) {
    const [p, brands] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          geoEnabled: true,
          geoRunDay: true,
          geoRunsPerPrompt: true,
          geoProfile: true,
        },
      }),
      this.prisma.brand.findMany({
        where: { projectId },
        select: { id: true, name: true, isOwn: true, domains: true },
        orderBy: [{ isOwn: 'desc' }, { name: 'asc' }],
      }),
    ]);
    return {
      enabled: p.geoEnabled,
      runDay: p.geoRunDay,
      runsPerPrompt: p.geoRunsPerPrompt,
      profile: (p.geoProfile ?? {}) as GeoProfile,
      brands: brands.map((b) => ({ ...b, domains: domainsOf(b.domains) })),
      models: this.ai.models(),
      evaluator: this.ai.idOf(this.evaluatorKey),
      maxPrompts: MAX_PROMPTS,
    };
  }

  async updateSettings(
    projectId: number,
    dto: {
      enabled?: boolean;
      runDay?: number;
      runsPerPrompt?: number;
      profile?: GeoProfile;
      brandDomains?: { brandId: number; domains: string[] }[];
    },
  ) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(dto.enabled !== undefined && { geoEnabled: dto.enabled }),
        ...(dto.runDay !== undefined && { geoRunDay: dto.runDay }),
        ...(dto.runsPerPrompt !== undefined && {
          geoRunsPerPrompt: dto.runsPerPrompt,
        }),
        ...(dto.profile && {
          geoProfile: dto.profile as Prisma.InputJsonValue,
        }),
      },
    });
    for (const b of dto.brandDomains ?? []) {
      const domains = [
        ...new Set(
          b.domains
            .map(
              (d) =>
                d
                  .trim()
                  .toLowerCase()
                  .replace(/^https?:\/\//, '')
                  .replace(/^www\./, '')
                  .split('/')[0],
            )
            .filter(Boolean),
        ),
      ];
      await this.prisma.brand.updateMany({
        where: { id: b.brandId, projectId },
        data: { domains },
      });
    }
    return this.settings(projectId);
  }

  // ───────── Prompts ─────────

  async prompts(projectId: number) {
    const rows = await this.prisma.geoPrompt.findMany({
      where: { projectId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: [{ status: 'asc' }, { category: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ versions, ...p }) => ({
      ...p,
      text: versions[0]?.text ?? '',
      version: versions[0]?.version ?? 0,
      versionId: versions[0]?.id ?? null,
    }));
  }

  async createPrompt(
    projectId: number,
    userId: number,
    dto: {
      text: string;
      category: GeoPromptCategory;
      branded?: boolean;
      language?: string;
      status?: GeoPromptStatus;
      source?: string;
    },
  ) {
    if (dto.status === 'APPROVED') await this.assertRoom(projectId);
    const p = await this.prisma.geoPrompt.create({
      data: {
        projectId,
        category: dto.category,
        branded: dto.branded ?? false,
        language: dto.language ?? 'id',
        status: dto.status ?? 'DRAFT',
        source: dto.source ?? 'manual',
        versions: {
          create: { version: 1, text: dto.text.trim(), createdById: userId },
        },
      },
    });
    return p.id;
  }

  /** Text changes add a version; earlier runs keep the version they used. */
  async updatePrompt(
    projectId: number,
    id: number,
    userId: number,
    dto: {
      text?: string;
      category?: GeoPromptCategory;
      branded?: boolean;
      language?: string;
      status?: GeoPromptStatus;
    },
  ) {
    const p = await this.prisma.geoPrompt.findFirst({
      where: { id, projectId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!p) throw new NotFoundException('Prompt not found');
    if (dto.status === 'APPROVED' && p.status !== 'APPROVED')
      await this.assertRoom(projectId);
    const latest = p.versions[0];
    const text = dto.text?.trim();
    await this.prisma.$transaction([
      this.prisma.geoPrompt.update({
        where: { id },
        data: {
          ...(dto.category && { category: dto.category }),
          ...(dto.branded !== undefined && { branded: dto.branded }),
          ...(dto.language && { language: dto.language }),
          ...(dto.status && { status: dto.status }),
        },
      }),
      ...(text && text !== latest?.text
        ? [
            this.prisma.geoPromptVersion.create({
              data: {
                promptId: id,
                version: (latest?.version ?? 0) + 1,
                text,
                createdById: userId,
              },
            }),
          ]
        : []),
    ]);
  }

  private async assertRoom(projectId: number) {
    const n = await this.prisma.geoPrompt.count({
      where: { projectId, status: 'APPROVED' },
    });
    if (n >= MAX_PROMPTS)
      throw new BadRequestException(
        `The benchmark holds at most ${MAX_PROMPTS} approved prompts`,
      );
  }

  /**
   * Draft prompts written by the evaluator model from the brand profile. They are DRAFT and do
   * not run until an analyst approves them.
   */
  async suggestPrompts(projectId: number, userId: number, perCategory = 2) {
    const s = await this.settings(projectId);
    const competitors = s.brands.filter((b) => !b.isOwn).map((b) => b.name);
    const target =
      s.profile.targetName ||
      s.brands
        .filter((b) => b.isOwn)
        .map((b) => b.name)
        .join(' / ');
    const prompt = `Write benchmark questions that real consumers would ask an AI assistant.
Context: industry "${s.profile.industry ?? 'unknown'}", market "${s.profile.market ?? 'Indonesia'}", target brand "${target}", competitors: ${competitors.join(', ') || 'none'}.
Language: ${s.profile.language === 'en' ? 'English' : 'Bahasa Indonesia, casual and natural'}.
Write ${perCategory} questions for each category:
- CATEGORY_DISCOVERY (asks for options in the category, no brand names)
- BRAND_RECOMMENDATION (describes a need and asks what to choose, no brand names)
- PROBLEM_SOLUTION (describes a problem, no brand names)
- BRAND_COMPARISON (compares the target with named competitors)
- BRAND_AWARENESS (asks what is known about the target brand)
- BRAND_REPUTATION (asks how the target brand is seen publicly)
Do not state facts or claims about any brand. Do not lead the answer towards the target brand.
Reply with JSON only: {"prompts":[{"category":"...","text":"...","branded":true|false}]}`;
    const c = await this.ai.complete(
      this.evaluatorKey,
      [{ role: 'user', content: prompt }],
      {
        temperature: 0.7,
      },
    );
    const start = c.text.indexOf('{');
    const end = c.text.lastIndexOf('}');
    let list: { category?: string; text?: string; branded?: boolean }[] = [];
    try {
      list =
        (JSON.parse(c.text.slice(start, end + 1)) as { prompts?: typeof list })
          .prompts ?? [];
    } catch {
      throw new BadRequestException(
        'The model did not return usable suggestions; try again',
      );
    }
    const cats = new Set(Object.values(GeoPromptCategory) as string[]);
    let created = 0;
    for (const p of list) {
      if (!p.text?.trim() || !cats.has(p.category ?? '')) continue;
      await this.createPrompt(projectId, userId, {
        text: p.text.slice(0, 1000),
        category: p.category as GeoPromptCategory,
        branded: !!p.branded,
        language: s.profile.language ?? 'id',
        source: 'suggested',
      });
      created++;
    }
    return { created };
  }

  // ───────── Batches ─────────

  /** What one batch would cost in calls, before running it. */
  async estimate(projectId: number) {
    const s = await this.settings(projectId);
    const prompts = await this.prisma.geoPrompt.count({
      where: { projectId, status: 'APPROVED' },
    });
    const combos = this.combos();
    const generations = prompts * combos.length * s.runsPerPrompt;
    const period = wibPeriod();
    const existing = await this.prisma.geoBatch.findUnique({
      where: { projectId_period: { projectId, period } },
      select: { id: true, status: true },
    });
    return {
      period,
      prompts,
      combos: combos.map(({ model, mode }) => ({ model, mode })),
      runsPerPrompt: s.runsPerPrompt,
      generations,
      evaluationsAtMost: generations, // answers that name no tracked brand skip the evaluator
      maxTokensPerCall: this.ai.maxTokens,
      alreadyRan: existing,
    };
  }

  private combos() {
    return this.ai
      .models()
      .filter((m) => m.configured)
      .flatMap((m) =>
        m.modes.map((mode) => ({
          model: m.id,
          key: m.key,
          mode,
          citations: mode === 'SEARCH' && m.capabilities.citations,
        })),
      );
  }

  /** Start this month's batch. A second batch in the same month is refused (unique project+period). */
  async start(
    projectId: number,
    trigger: 'manual' | 'scheduled',
    userId?: number,
  ) {
    const period = wibPeriod();
    const existing = await this.prisma.geoBatch.findUnique({
      where: { projectId_period: { projectId, period } },
    });
    if (existing)
      throw new ConflictException(
        `GEO already ran for ${period}. The next run is possible next month; failed runs can be retried in this batch.`,
      );
    const s = await this.settings(projectId);
    const combos = this.combos();
    if (!combos.length)
      throw new BadRequestException(
        'No AI model is configured (SumoPod API keys)',
      );
    const prompts = await this.prompts(projectId);
    const approved = prompts.filter(
      (p) => p.status === 'APPROVED' && p.versionId,
    );
    if (!approved.length)
      throw new BadRequestException('Approve at least one prompt first');

    const config: BatchConfig = {
      combos,
      runsPerPrompt: s.runsPerPrompt,
      evaluator: this.ai.idOf(this.evaluatorKey),
      evaluationVersion: EVALUATION_VERSION,
      maxTokens: this.ai.maxTokens,
      promptVersionIds: approved.map((p) => p.versionId!),
    };
    let batchId: number;
    try {
      const batch = await this.prisma.geoBatch.create({
        data: {
          projectId,
          period,
          trigger,
          createdById: userId,
          config: config as unknown as Prisma.InputJsonValue,
          total: approved.length * combos.length * s.runsPerPrompt,
        },
      });
      batchId = batch.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new ConflictException(`GEO already ran for ${period}`);
      throw e;
    }
    await this.prisma.geoRun.createMany({
      skipDuplicates: true,
      data: approved.flatMap((p) =>
        combos.flatMap((c) =>
          Array.from({ length: s.runsPerPrompt }, (_, i) => ({
            batchId,
            projectId,
            promptVersionId: p.versionId!,
            model: c.model,
            mode: c.mode,
            runNo: i + 1,
          })),
        ),
      ),
    });
    this.background.run(this.process(batchId));
    return this.batch(projectId, batchId);
  }

  /** Continue a paused batch (or one whose worker died). */
  async resume(projectId: number, batchId: number) {
    const b = await this.findBatch(projectId, batchId);
    if (await this.claim(b.id)) this.background.run(this.process(b.id));
    return this.batch(projectId, batchId);
  }

  /** Re-run only the failed runs of a batch; no new batch, no new month. */
  async retryFailed(projectId: number, batchId: number) {
    const b = await this.findBatch(projectId, batchId);
    if (b.status === 'RUNNING')
      throw new ConflictException('The batch is still running');
    const { count } = await this.prisma.geoRun.updateMany({
      where: { batchId: b.id, status: 'FAILED' },
      data: { status: 'PENDING', errorType: null, errorMessage: null },
    });
    if (!count) return this.batch(projectId, batchId);
    await this.prisma.geoBatch.update({
      where: { id: b.id },
      data: { status: 'PAUSED', finishedAt: null },
    });
    return this.resume(projectId, batchId);
  }

  /** Re-classify stored answers with the current rules; no new generation calls. */
  async reevaluate(projectId: number, batchId: number) {
    const b = await this.findBatch(projectId, batchId);
    const runs = await this.prisma.geoRun.findMany({
      where: { batchId: b.id, status: 'SUCCEEDED' },
      select: { id: true },
    });
    this.background.run(
      (async () => {
        const entities = await this.entities(projectId);
        for (const r of runs) await this.evaluate(r.id, entities);
      })(),
    );
    return { queued: runs.length };
  }

  async batches(projectId: number) {
    return this.prisma.geoBatch.findMany({
      where: { projectId },
      orderBy: { period: 'desc' },
      select: {
        id: true,
        period: true,
        status: true,
        trigger: true,
        total: true,
        succeeded: true,
        failed: true,
        startedAt: true,
        finishedAt: true,
        updatedAt: true,
      },
    });
  }

  async batch(projectId: number, batchId: number) {
    const b = await this.findBatch(projectId, batchId);
    const counts = await this.prisma.geoRun.groupBy({
      by: ['status'],
      where: { batchId: b.id },
      _count: { _all: true },
    });
    const by = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    const tokens = await this.prisma.geoRun.aggregate({
      where: { batchId: b.id },
      _sum: { promptTokens: true, completionTokens: true },
    });
    return {
      ...b,
      pending: by.PENDING ?? 0,
      succeeded: by.SUCCEEDED ?? 0,
      failed: by.FAILED ?? 0,
      tokens: {
        prompt: tokens._sum.promptTokens ?? 0,
        completion: tokens._sum.completionTokens ?? 0,
      },
    };
  }

  private async findBatch(projectId: number, batchId: number) {
    const b = await this.prisma.geoBatch.findFirst({
      where: { id: batchId, projectId },
    });
    if (!b) throw new NotFoundException('Batch not found');
    return b;
  }

  /** Take a batch for processing: paused, or running but silent for 10 minutes. */
  private async claim(batchId: number) {
    const { count } = await this.prisma.geoBatch.updateMany({
      where: {
        id: batchId,
        OR: [
          { status: 'PAUSED' },
          {
            status: 'RUNNING',
            updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
          },
        ],
      },
      data: { status: 'RUNNING' },
    });
    return count > 0;
  }

  /** Run pending runs with bounded concurrency until done or out of time (then PAUSED). */
  async process(batchId: number) {
    const deadline = this.timeBudgetMs
      ? Date.now() + this.timeBudgetMs
      : Number.POSITIVE_INFINITY;
    const batch = await this.prisma.geoBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    const entities = await this.entities(batch.projectId);
    const config = batch.config as unknown as BatchConfig;
    try {
      for (;;) {
        const pending = await this.prisma.geoRun.findMany({
          where: { batchId, status: 'PENDING' },
          include: { promptVersion: { select: { text: true } } },
          orderBy: { id: 'asc' },
          take: CONCURRENCY,
        });
        if (!pending.length) break;
        await Promise.all(
          pending.map((r) => this.execute(r, config, entities)),
        );
        await this.prisma.geoBatch.update({
          where: { id: batchId },
          data: { updatedAt: new Date() },
        }); // heartbeat
        if (Date.now() > deadline) {
          await this.prisma.geoBatch.update({
            where: { id: batchId },
            data: { status: 'PAUSED' },
          });
          this.log.log(`GEO batch ${batchId} paused`);
          return;
        }
      }
      const [ok, bad] = await Promise.all([
        this.prisma.geoRun.count({ where: { batchId, status: 'SUCCEEDED' } }),
        this.prisma.geoRun.count({ where: { batchId, status: 'FAILED' } }),
      ]);
      await this.prisma.geoBatch.update({
        where: { id: batchId },
        data: {
          succeeded: ok,
          failed: bad,
          status: bad === 0 ? 'COMPLETED' : ok > 0 ? 'PARTIAL' : 'FAILED',
          finishedAt: new Date(),
        },
      });
      this.log.log(`GEO batch ${batchId} done: ${ok} ok, ${bad} failed`);
    } catch (e) {
      this.log.error(`GEO batch ${batchId} stopped`, (e as Error).stack);
      await this.prisma.geoBatch.update({
        where: { id: batchId },
        data: { status: 'PAUSED' },
      });
    }
  }

  private async execute(
    run: {
      id: number;
      model: string;
      mode: 'KNOWLEDGE' | 'SEARCH';
      promptVersion: { text: string };
    },
    config: BatchConfig,
    entities: GeoEntity[],
  ) {
    const combo = config.combos.find(
      (c) => c.model === run.model && c.mode === run.mode,
    );
    await this.prisma.geoRun.update({
      where: { id: run.id },
      data: { attempts: { increment: 1 } },
    });
    try {
      if (!combo)
        throw new ProviderError(
          'not_configured',
          `Model ${run.model} is no longer configured`,
          false,
        );
      const c = await this.ai.complete(
        combo.key,
        [{ role: 'user', content: run.promptVersion.text }],
        {
          mode: run.mode,
          maxTokens: config.maxTokens,
        },
      );
      const owned = entities
        .filter((e) => e.isTarget)
        .flatMap((e) => e.domains);
      const theirs = entities
        .filter((e) => !e.isTarget)
        .flatMap((e) => e.domains);
      await this.prisma.$transaction([
        this.prisma.geoRun.update({
          where: { id: run.id },
          data: {
            status: 'SUCCEEDED',
            text: c.text,
            rawResponse: c.raw as Prisma.InputJsonValue,
            latencyMs: c.latencyMs,
            promptTokens: c.promptTokens,
            completionTokens: c.completionTokens,
            reasoningTokens: c.reasoningTokens,
            requestId: c.requestId?.slice(0, 120),
            executedAt: new Date(),
            errorType: null,
            errorMessage: null,
          },
        }),
        this.prisma.geoCitation.deleteMany({ where: { runId: run.id } }),
        this.prisma.geoCitation.createMany({
          data: c.citations.map((x) => ({
            runId: run.id,
            domain: x.domain.slice(0, 255),
            url: x.url,
            startIndex: x.startIndex,
            endIndex: x.endIndex,
            ownedBy: owns(x.domain, owned)
              ? 'TARGET'
              : owns(x.domain, theirs)
                ? 'COMPETITOR'
                : null,
          })),
        }),
      ]);
      await this.evaluate(run.id, entities);
    } catch (e) {
      const err =
        e instanceof ProviderError
          ? e
          : new ProviderError('provider_error', String(e).slice(0, 200), false);
      await this.prisma.geoRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          errorType: err.type,
          errorMessage: err.message.slice(0, 500),
          executedAt: new Date(),
          ...(err.raw !== undefined && {
            rawResponse: err.raw as Prisma.InputJsonValue,
          }),
        },
      });
    }
  }

  /** Target group (all own brands as one) and each competitor, with aliases and owned domains. */
  async entities(
    projectId: number,
  ): Promise<(Entity & { domains: string[] })[]> {
    const [brands, project] = await Promise.all([
      this.prisma.brand.findMany({ where: { projectId } }),
      this.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { geoProfile: true },
      }),
    ]);
    const own = brands.filter((b) => b.isOwn);
    const profile = (project.geoProfile ?? {}) as GeoProfile;
    return [
      {
        isTarget: true,
        brandId: null,
        name:
          profile.targetName || own.map((b) => b.name).join(' + ') || 'Target',
        aliases: own.flatMap((b) => [b.name, ...stringsOf(b.aliases)]),
        domains: own.flatMap((b) => domainsOf(b.domains)),
      },
      ...brands
        .filter((b) => !b.isOwn)
        .map((b) => ({
          isTarget: false,
          brandId: b.id,
          name: b.name,
          aliases: stringsOf(b.aliases),
          domains: domainsOf(b.domains),
        })),
    ];
  }

  /** Evaluate one stored answer and save a new evaluation row (older ones are kept). */
  async evaluate(runId: number, entities: Entity[]) {
    const run = await this.prisma.geoRun.findUniqueOrThrow({
      where: { id: runId },
      include: { promptVersion: { select: { text: true } } },
    });
    const text = run.text ?? '';
    const mentioned = entities.filter((e) => findMentions(text, e).length);
    let raw: string | null = null;
    let error: string | null = null;
    if (mentioned.length) {
      try {
        const c = await this.ai.complete(
          this.evaluatorKey,
          [
            {
              role: 'user',
              content: evaluatorPrompt(run.promptVersion.text, text, mentioned),
            },
          ],
          { temperature: 0 },
        );
        raw = c.text;
      } catch (e) {
        error = (e as Error).message.slice(0, 500);
      }
    }
    const parsed = raw ? parseEvaluatorJson(raw) : null;
    if (raw && !parsed) error = 'Evaluator reply was not valid JSON';
    const results = buildResults(text, entities, parsed);
    await this.prisma.geoEvaluation.create({
      data: {
        runId,
        version: EVALUATION_VERSION,
        evaluatorModel: mentioned.length
          ? this.ai.idOf(this.evaluatorKey)
          : null,
        status: error ? 'failed' : 'ok',
        error,
        raw: raw === null ? Prisma.JsonNull : { reply: raw },
        results: {
          create: results.map((r) => ({
            isTarget: r.isTarget,
            brandId: r.brandId,
            name: r.name.slice(0, 120),
            mentioned: r.mentioned,
            matches: r.matches,
            recommendation: r.recommendation,
            position: r.position,
            listSize: r.listSize,
            sentiment: r.sentiment,
            evidence: r.evidence?.slice(0, 600) ?? null,
          })),
        },
      },
    });
  }

  /** Analyst correction of one brand result (recommendation or mention). */
  async correct(
    projectId: number,
    resultId: number,
    dto: { mentioned?: boolean; recommendation?: string },
  ) {
    const r = await this.prisma.geoBrandResult.findFirst({
      where: { id: resultId, evaluation: { run: { projectId } } },
    });
    if (!r) throw new NotFoundException('Result not found');
    return this.prisma.geoBrandResult.update({
      where: { id: resultId },
      data: {
        manual: true,
        ...(dto.mentioned !== undefined && { mentioned: dto.mentioned }),
        ...(dto.recommendation && {
          recommendation: dto.recommendation as never,
        }),
      },
    });
  }

  // ───────── Scheduler ─────────

  /** Daily cron: start this month's run on/after each project's run day; resume stuck batches. */
  async cron() {
    const period = wibPeriod();
    const today = wibDay();
    const projects = await this.prisma.project.findMany({
      where: { geoEnabled: true, geoRunDay: { lte: today } },
      select: { id: true },
    });
    const started: number[] = [];
    for (const p of projects) {
      const exists = await this.prisma.geoBatch.findUnique({
        where: { projectId_period: { projectId: p.id, period } },
        select: { id: true },
      });
      if (exists) continue;
      try {
        await this.start(p.id, 'scheduled');
        started.push(p.id);
      } catch (e) {
        this.log.warn(`GEO cron project ${p.id}: ${(e as Error).message}`);
      }
    }
    const stuck = await this.prisma.geoBatch.findMany({
      where: {
        OR: [
          { status: 'PAUSED' },
          {
            status: 'RUNNING',
            updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
          },
        ],
      },
      select: { id: true, projectId: true },
    });
    for (const b of stuck) await this.resume(b.projectId, b.id);
    return { period, started, resumed: stuck.map((b) => b.id) };
  }
}
