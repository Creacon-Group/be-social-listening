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
import type { UserRole } from '../../generated/prisma/enums.js';
import { ChatCreditsService } from '../assistant/chat-credits.service.js';
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
/** Prompts in one manual run; each costs one AI credit. */
export const MAX_ADHOC_PROMPTS = 10;
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
  /** Manual runs: who paid how many credits, on which WIB day, and how many were given back. */
  charge?: { userId: number; credits: number; day: string; refunded?: number };
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
const EN_WORDS = new Set([
  'what',
  'which',
  'the',
  'are',
  'is',
  'for',
  'how',
  'best',
  'does',
  'do',
  'and',
  'with',
  'provide',
  'offer',
  'main',
]);
const ID_WORDS = new Set([
  'apa',
  'yang',
  'mana',
  'untuk',
  'buat',
  'dan',
  'di',
  'saya',
  'paling',
  'bagaimana',
  'kenapa',
  'atau',
  'dengan',
  'sebaiknya',
]);

const languageScore = (text: string) => {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return {
    en: words.filter((w) => EN_WORDS.has(w)).length,
    id: words.filter((w) => ID_WORDS.has(w)).length,
  };
};

/** Rough checks used to drop suggestions that are not in the project's prompt language. */
export function looksEnglish(text: string): boolean {
  const { en, id } = languageScore(text);
  return en >= 2 && en > id;
}

export function looksIndonesian(text: string): boolean {
  const { en, id } = languageScore(text);
  return id >= 2 && id > en;
}

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
    private readonly credits: ChatCreditsService,
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
    const languages: ('id' | 'en')[] =
      s.profile.language === 'both'
        ? ['id', 'en']
        : s.profile.language === 'en'
          ? ['en']
          : ['id'];
    let created = 0;
    let skipped = 0;
    for (const lang of languages) {
      const r = await this.suggestIn(projectId, userId, s, lang, perCategory);
      created += r.created;
      skipped += r.skipped;
    }
    return { created, skipped, languages };
  }

  /** One suggestion call in one language; suggestions in the other language are dropped. */
  private async suggestIn(
    projectId: number,
    userId: number,
    s: Awaited<ReturnType<GeoService['settings']>>,
    lang: 'id' | 'en',
    perCategory: number,
  ) {
    const competitors = s.brands.filter((b) => !b.isOwn).map((b) => b.name);
    const target =
      s.profile.targetName ||
      s.brands
        .filter((b) => b.isOwn)
        .map((b) => b.name)
        .join(' / ');
    const languageRule =
      lang === 'id'
        ? `LANGUAGE: every "text" MUST be in Bahasa Indonesia, casual and natural, the way people in Indonesia type to an AI assistant (e.g. "Operator seluler apa yang paling stabil buat main game online?"). Do NOT write any question in English. Only the "category" values stay in English.`
        : 'LANGUAGE: every "text" MUST be in English (e.g. "Which mobile operator is most reliable for online gaming?"). Do NOT write any question in Bahasa Indonesia.';
    const prompt = `${languageRule}

Write benchmark questions that real consumers would ask an AI assistant.
Context: industry "${s.profile.industry ?? 'unknown'}", market "${s.profile.market ?? 'Indonesia'}", target brand "${target}", competitors: ${competitors.join(', ') || 'none'}.
Write ${perCategory} questions for each category:
- CATEGORY_DISCOVERY (asks for options in the category, no brand names)
- BRAND_RECOMMENDATION (describes a need and asks what to choose, no brand names)
- PROBLEM_SOLUTION (describes a problem, no brand names)
- BRAND_COMPARISON (compares the target with named competitors)
- BRAND_AWARENESS (asks what is known about the target brand)
- BRAND_REPUTATION (asks how the target brand is seen publicly)
Do not state facts or claims about any brand. Do not lead the answer towards the target brand.
${languageRule}
Reply with JSON only: {"prompts":[{"category":"...","text":"...","branded":true|false}]}`;
    const c = await this.ai.complete(
      this.evaluatorKey,
      [{ role: 'user', content: prompt }],
      { temperature: 0.7 },
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
    let skipped = 0;
    for (const p of list) {
      if (!p.text?.trim() || !cats.has(p.category ?? '')) continue;
      if (lang === 'id' ? looksEnglish(p.text) : looksIndonesian(p.text)) {
        skipped++;
        continue;
      }
      await this.createPrompt(projectId, userId, {
        text: p.text.slice(0, 1000),
        category: p.category as GeoPromptCategory,
        branded: !!p.branded,
        language: lang,
        source: 'suggested',
      });
      created++;
    }
    return { created, skipped };
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

  /**
   * Manual run outside the monthly schedule, paid with the user's daily AI credits: one credit per
   * prompt (each prompt runs on every configured model and mode, once). New prompts are saved as
   * drafts so they can join the benchmark later. Results stay separate from the monthly runs.
   */
  async startAdhoc(
    projectId: number,
    user: { id: number; role: UserRole },
    dto: {
      promptIds?: number[];
      newPrompts?: {
        text: string;
        category: GeoPromptCategory;
        branded?: boolean;
        language?: string;
      }[];
    },
  ) {
    const combos = this.combos();
    if (!combos.length)
      throw new BadRequestException(
        'No AI model is configured (SumoPod API keys)',
      );
    const ids = [...new Set(dto.promptIds ?? [])];
    const count = ids.length + (dto.newPrompts?.length ?? 0);
    if (!count)
      throw new BadRequestException('Pick or write at least one prompt');
    if (count > MAX_ADHOC_PROMPTS)
      throw new BadRequestException(
        `A manual run takes at most ${MAX_ADHOC_PROMPTS} prompts`,
      );
    const existing = ids.length
      ? await this.prisma.geoPrompt.findMany({
          where: { id: { in: ids }, projectId, status: { not: 'ARCHIVED' } },
          select: { id: true },
        })
      : [];
    if (existing.length !== ids.length)
      throw new BadRequestException(
        'Some prompts were not found or are archived',
      );

    // Pay first, in one conditional update: fails with 429 when the credits do not cover it.
    const day = new Date(Date.now() + WIB_MS).toISOString().slice(0, 10);
    const charged = await this.credits.reserve(user.id, user.role, count);
    try {
      const newIds: number[] = [];
      for (const p of dto.newPrompts ?? [])
        newIds.push(
          await this.createPrompt(projectId, user.id, {
            ...p,
            source: 'adhoc',
            status: 'DRAFT',
          }),
        );
      const versions = await this.prisma.geoPromptVersion.findMany({
        where: { promptId: { in: [...ids, ...newIds] } },
        orderBy: { version: 'desc' },
        select: { id: true, promptId: true },
      });
      // newest version first, so the first id kept per prompt is its current version
      const current = new Map<number, number>();
      for (const v of versions)
        if (!current.has(v.promptId)) current.set(v.promptId, v.id);
      const versionIds = [...current.values()];
      const config: BatchConfig = {
        combos,
        runsPerPrompt: 1,
        evaluator: this.ai.idOf(this.evaluatorKey),
        evaluationVersion: EVALUATION_VERSION,
        maxTokens: this.ai.maxTokens,
        promptVersionIds: versionIds,
        ...(charged && { charge: { userId: user.id, credits: count, day } }),
      };
      const stamp = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jakarta',
      }).format(new Date());
      const batch = await this.prisma.geoBatch.create({
        data: {
          projectId,
          period: null,
          kind: 'adhoc',
          label: `Manual run, ${stamp} WIB (${count} prompt${count > 1 ? 's' : ''})`,
          trigger: 'manual',
          createdById: user.id,
          config: config as unknown as Prisma.InputJsonValue,
          total: versionIds.length * combos.length,
        },
      });
      await this.prisma.geoRun.createMany({
        skipDuplicates: true,
        data: versionIds.flatMap((promptVersionId) =>
          combos.map((c) => ({
            batchId: batch.id,
            projectId,
            promptVersionId,
            model: c.model,
            mode: c.mode,
            runNo: 1,
          })),
        ),
      });
      this.background.run(this.process(batch.id));
      return {
        ...(await this.batch(projectId, batch.id)),
        creditsCharged: charged ? count : 0,
      };
    } catch (e) {
      if (charged) await this.credits.release(user.id, count);
      throw e;
    }
  }

  /** Manual runs: give back one credit for each prompt that produced no answer at all. Runs once. */
  private async refundFailedPrompts(batchId: number) {
    const b = await this.prisma.geoBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    const config = b.config as unknown as BatchConfig;
    if (
      b.kind !== 'adhoc' ||
      !config.charge ||
      config.charge.refunded !== undefined
    )
      return;
    const ok = await this.prisma.geoRun.groupBy({
      by: ['promptVersionId'],
      where: { batchId, status: 'SUCCEEDED' },
    });
    const refund = Math.max(0, config.promptVersionIds.length - ok.length);
    await this.prisma.geoBatch.update({
      where: { id: batchId },
      data: {
        config: {
          ...config,
          charge: { ...config.charge, refunded: refund },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (refund)
      await this.credits.release(
        config.charge.userId,
        refund,
        new Date(`${config.charge.day}T00:00:00Z`),
      );
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
    if (b.kind === 'adhoc')
      throw new ConflictException(
        'Manual runs are not retried; credits for prompts that failed completely were given back. Start a new manual run instead.',
      );
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
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        period: true,
        kind: true,
        label: true,
        createdById: true,
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
      await this.refundFailedPrompts(batchId);
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
