import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { diskStorage } from 'multer';
import type { Env } from '../../config/env.js';
import { CategoriesModule } from '../categories/categories.module.js';
import { MentionsModule } from '../mentions/mentions.module.js';
import { ExcelIngestionSource } from './adapters/excel/excel-ingestion.source.js';
import { FileStore } from './adapters/excel/file-store.js';
import {
  BackgroundRunner,
  InProcessBackgroundRunner,
  VercelBackgroundRunner,
} from './application/background-runner.js';
import { BrandResolver } from './application/brand-resolver.js';
import { IngestionBatchRepository } from './application/ingestion-batch.repository.js';
import { IngestionService } from './application/ingestion.service.js';
import { MentionValidator } from './application/mention.validator.js';
import {
  INGESTION_SOURCES,
  type IngestionSource,
} from './domain/normalized-mention.js';
import { IngestionController } from './ingestion.controller.js';
import { ZanrooWebhookController } from './zanroo-webhook.controller.js';

@Module({
  imports: [
    MentionsModule,
    CategoriesModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        storage: diskStorage({
          destination: (_req, _file, cb) => {
            const dir = config.get('UPLOAD_DIR', { infer: true });
            mkdirSync(dir, { recursive: true }); // lazily: Vercel's filesystem is read-only outside /tmp
            cb(null, dir);
          },
          filename: (_req, _file, cb) => cb(null, `${randomUUID()}.xlsx`),
        }),
        limits: { fileSize: 200 * 1024 * 1024, files: 1 },
      }),
    }),
  ],
  controllers: [IngestionController, ZanrooWebhookController],
  providers: [
    IngestionService,
    IngestionBatchRepository,
    MentionValidator,
    BrandResolver,
    FileStore,
    ExcelIngestionSource,
    {
      provide: BackgroundRunner,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('VERCEL', { infer: true })
          ? new VercelBackgroundRunner()
          : new InProcessBackgroundRunner(),
    },
    // Pull sources (files, APIs read in batches). Push sources such as the Zanroo webhook call
    // IngestionService.ingestRecords directly.
    {
      provide: INGESTION_SOURCES,
      inject: [ExcelIngestionSource],
      useFactory: (...sources: IngestionSource[]) => sources,
    },
  ],
  exports: [IngestionService],
})
export class IngestionModule {}
