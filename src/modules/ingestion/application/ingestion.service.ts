import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';
import type {
  IngestionSourceType,
  Prisma,
} from '../../../generated/prisma/client.js';
import {
  MENTION_WRITER,
  type MentionWriter,
} from '../../mentions/mention.repository.js';
import {
  INGESTION_SOURCES,
  type IngestionContext,
  type IngestionSource,
  type ResolvedMention,
} from '../domain/normalized-mention.js';
import { BackgroundRunner } from './background-runner.js';
import { BrandResolver } from './brand-resolver.js';
import { IngestionBatchRepository } from './ingestion-batch.repository.js';
import { MentionValidator } from './mention.validator.js';

const CHUNK = 500;

/**
 * Ingestion core. Knows nothing about Excel or APIs: it pulls NormalizedMention records from a source,
 * validates them, resolves brands and writes in chunks. A batch can pause near the platform's time
 * limit and be resumed; already-persisted rows are skipped on resume, and inserts are idempotent.
 */
@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);
  private readonly sources: Map<IngestionSourceType, IngestionSource>;
  private readonly timeBudgetMs: number | undefined;

  constructor(
    @Inject(INGESTION_SOURCES) sources: IngestionSource[],
    @Inject(MENTION_WRITER) private readonly mentions: MentionWriter,
    private readonly batches: IngestionBatchRepository,
    private readonly validator: MentionValidator,
    private readonly brands: BrandResolver,
    private readonly background: BackgroundRunner,
    config: ConfigService<Env, true>,
  ) {
    this.sources = new Map(sources.map((s) => [s.type, s]));
    this.timeBudgetMs =
      config.get('INGESTION_TIME_BUDGET_MS', { infer: true }) ??
      (config.get('VERCEL', { infer: true }) ? 240_000 : undefined);
  }

  /** Create a batch and process it in the background; the client polls the batch status. */
  async start(cmd: {
    type: IngestionSourceType;
    projectId: number;
    userId?: number;
    label?: string;
    input: Prisma.InputJsonValue;
  }) {
    if (!this.sources.has(cmd.type))
      throw new BadRequestException(`Source ${cmd.type} belum tersedia`);
    const batch = await this.batches.create({
      projectId: cmd.projectId,
      createdById: cmd.userId,
      sourceType: cmd.type,
      fileName: cmd.label,
      sourceInput: cmd.input,
    });
    this.background.run(this.process(batch.id));
    return batch;
  }

  /** Continue a PAUSED batch (or a PROCESSING one that stopped moving). */
  async resume(projectId: number, batchId: number) {
    const batch = await this.batches.findForProject(projectId, batchId);
    if (!(await this.batches.claim(batchId))) {
      throw new ConflictException(
        `Batch berstatus ${batch.status} dan tidak bisa dilanjutkan`,
      );
    }
    this.background.run(this.process(batchId, true));
    return this.batches.findForProject(projectId, batchId);
  }

  /** Visible for tests: process synchronously. */
  async process(batchId: number, alreadyClaimed = false): Promise<void> {
    if (!alreadyClaimed && !(await this.batches.claim(batchId))) return;

    const batch = await this.batches.load(batchId);
    const source = this.sources.get(batch.sourceType)!;
    const ctx: IngestionContext = {
      projectId: batch.projectId,
      batchId,
      sourceType: batch.sourceType,
    };
    const deadline = this.timeBudgetMs
      ? Date.now() + this.timeBudgetMs
      : Number.POSITIVE_INFINITY;

    const counters = {
      inserted: batch.insertedRows,
      skipped: batch.skippedRows,
      failed: batch.failedRows,
    };
    const unmapped = new Map<string, number>(
      Object.entries((batch.unmappedKeywords ?? {}) as Record<string, number>),
    );
    let seen = 0;
    let chunk: ResolvedMention[] = [];

    const flush = async () => {
      if (chunk.length) {
        const res = await this.mentions.insertMany(ctx, chunk);
        counters.inserted += res.inserted;
        counters.skipped += res.skipped;
        chunk = [];
      }
      await this.batches.checkpoint(batchId, counters, seen, unmapped);
    };

    try {
      const brandIndex = await this.brands.load(ctx.projectId);

      for await (const rec of source.read(batch.sourceInput, ctx)) {
        seen++;
        if (seen <= batch.processedRows) continue; // persisted by an earlier invocation

        if (!rec.ok) {
          if (rec.fatal) throw new Error(rec.message);
          counters.failed++;
          await this.batches.addError(batchId, rec.ref, rec.message, rec.raw);
        } else {
          const check = this.validator.validate(rec.mention);
          if (!check.ok) {
            counters.failed++;
            await this.batches.addError(batchId, rec.ref, check.message, {
              externalId: rec.mention.externalId,
            });
          } else {
            const { brandIds, unmatched } = brandIndex.resolve(
              check.mention.brandKeywords,
            );
            if (!brandIds.length)
              unmatched.forEach((k) =>
                unmapped.set(k, (unmapped.get(k) ?? 0) + 1),
              );
            chunk.push({ mention: check.mention, brandIds }); // rows without a brand are still stored
          }
        }

        if (chunk.length >= CHUNK) {
          await flush();
          if (Date.now() > deadline) {
            await this.batches.pause(batchId);
            this.log.log(`Batch ${batchId} paused at ${seen} rows`);
            return;
          }
        }
      }
      await flush();
      await this.batches.finish(batchId, counters.failed);
      this.log.log(`Batch ${batchId} done: ${JSON.stringify(counters)}`);
    } catch (err) {
      this.log.error(`Batch ${batchId} failed`, (err as Error).stack);
      await this.batches.fail(batchId, (err as Error).message);
    }
    await source.cleanup?.(batch.sourceInput).catch(() => undefined);
  }
}
