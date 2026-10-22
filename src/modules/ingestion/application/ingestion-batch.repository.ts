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
