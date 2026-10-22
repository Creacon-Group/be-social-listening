import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  IngestionSourceType,
  Prisma,
} from '../../../generated/prisma/client.js';

export interface BatchCounters {
  inserted: number;
  skipped: number;
  failed: number;
}

/** A PROCESSING batch whose row has not moved for this long is considered dead and may be resumed. */
export const STALE_AFTER_MS = 5 * 60_000;
const UNMAPPED_KEEP = 200;

const batchView = {
  id: true,
  projectId: true,
  sourceType: true,
  fileName: true,
  status: true,
  processedRows: true,
  insertedRows: true,
  skippedRows: true,
  failedRows: true,
  unmappedKeywords: true,
  errorMessage: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IngestionBatchSelect;

@Injectable()
export class IngestionBatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    projectId: number;
    createdById?: number;
    sourceType: IngestionSourceType;
    fileName?: string;
    sourceInput: Prisma.InputJsonValue;
  }) {
    return this.prisma.ingestionBatch.create({ data, select: batchView });
  }

  /**
   * Webhook deliveries are small and frequent, so they share one batch per project per WIB day.
   * Keeps the upload history readable and gives errors a place to live.
   */
  async dailyBatch(
    projectId: number,
    sourceType: IngestionSourceType,
    label: string,
  ) {
    const day = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const fileName = `${label} ${day}`;
    const found = await this.prisma.ingestionBatch.findFirst({
      where: { projectId, sourceType, fileName },
      select: { id: true },
    });
    if (found) return found.id;
    const created = await this.prisma.ingestionBatch.create({
      data: {
        projectId,
        sourceType,
        fileName,
        status: 'COMPLETED',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Atomic counter update for batches written by many concurrent requests. */
  async addCounts(
    id: number,
    c: BatchCounters & { seen: number },
    unmapped: Map<string, number>,
  ) {
    if (unmapped.size) {
      // Read-merge-write: two deliveries at the same moment may lose a count, which is fine for a hint.
      const cur = await this.prisma.ingestionBatch.findUnique({
        where: { id },
        select: { unmappedKeywords: true },
      });
      const merged = new Map(
        Object.entries((cur?.unmappedKeywords ?? {}) as Record<string, number>),
      );
      unmapped.forEach((n, k) => merged.set(k, (merged.get(k) ?? 0) + n));
      const top = Object.fromEntries(
        [...merged.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, UNMAPPED_KEEP),
      );
      await this.prisma.ingestionBatch.update({
        where: { id },
        data: { unmappedKeywords: top },
      });
    }
    await this.prisma.ingestionBatch.update({
      where: { id },
      data: {
        processedRows: { increment: c.seen },
        insertedRows: { increment: c.inserted },
        skippedRows: { increment: c.skipped },
        failedRows: { increment: c.failed },
        finishedAt: new Date(),
        ...(c.failed ? { status: 'COMPLETED_WITH_ERRORS' } : {}),
      },
    });
  }

  /** Internal read including sourceInput (never returned to clients). */
  async load(id: number) {
    const b = await this.prisma.ingestionBatch.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Batch not found');
    return b;
  }

  async findForProject(projectId: number, id: number) {
    const b = await this.prisma.ingestionBatch.findFirst({
      where: { id, projectId },
      select: batchView,
    });
    if (!b) throw new NotFoundException('Batch not found');
    return b;
  }

  listForProject(projectId: number, take = 20) {
    return this.prisma.ingestionBatch.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take,
      select: batchView,
    });
  }

  /**
   * Atomically take ownership of a batch. Succeeds for PENDING/PAUSED, or for a PROCESSING batch that
   * looks dead. Returns false when another invocation already owns it.
   */
  async claim(id: number): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
    const { count } = await this.prisma.ingestionBatch.updateMany({
      where: {
        id,
        OR: [
          { status: { in: ['PENDING', 'PAUSED'] } },
          { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: 'PROCESSING', errorMessage: null },
    });
    if (count) {
      await this.prisma.ingestionBatch.updateMany({
        where: { id, startedAt: null },
        data: { startedAt: new Date() },
      });
    }
    return count === 1;
  }

  checkpoint(
    id: number,
    c: BatchCounters,
    processedRows: number,
    unmapped: Map<string, number>,
  ) {
    const top = Object.fromEntries(
      [...unmapped.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, UNMAPPED_KEEP),
    );
    return this.prisma.ingestionBatch.update({
      where: { id },
      data: {
        processedRows,
        insertedRows: c.inserted,
        skippedRows: c.skipped,
        failedRows: c.failed,
        unmappedKeywords: top,
      },
    });
  }

  addError(batchId: number, rowRef: string, message: string, raw?: unknown) {
    return this.prisma.ingestionRowError.create({
      data: {
        batchId,
        rowRef: rowRef.slice(0, 100),
        message: message.slice(0, 500),
        raw:
          raw === undefined
            ? undefined
            : (JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue),
      },
    });
  }

  pause(id: number) {
    return this.prisma.ingestionBatch.update({
      where: { id },
      data: { status: 'PAUSED' },
    });
  }

  finish(id: number, failed: number) {
    return this.prisma.ingestionBatch.update({
      where: { id },
      data: {
        status: failed ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        finishedAt: new Date(),
      },
    });
  }

  fail(id: number, message: string) {
    return this.prisma.ingestionBatch.update({
      where: { id },
      data: {
        status: 'FAILED',
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    });
  }

  async listErrors(
    projectId: number,
    batchId: number,
    page: number,
    pageSize: number,
  ) {
    await this.findForProject(projectId, batchId);
    const [items, total] = await Promise.all([
      this.prisma.ingestionRowError.findMany({
        where: { batchId },
        orderBy: { id: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, rowRef: true, message: true },
      }),
      this.prisma.ingestionRowError.count({ where: { batchId } }),
    ]);
    return { items, page, pageSize, total };
  }
}
