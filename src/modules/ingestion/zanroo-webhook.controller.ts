import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/auth.js';
import { RateLimit } from '../../common/rate-limit.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  extractMessages,
  zanrooMessageToRecord,
} from './adapters/zanroo-api/zanroo-message.js';
import { IngestionService } from './application/ingestion.service.js';

const MAX_MESSAGES = 1000;

// Hash both sides first so the comparison takes the same time whatever the input length.
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );

/**
 * Zanroo Listening pushes new and updated messages here in real time.
 * URL per project: POST /api/webhooks/zanroo/{projectId}
 */
@ApiExcludeController()
@Controller('webhooks/zanroo')
export class ZanrooWebhookController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Post(':projectId')
  @RateLimit(3000)
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-webhook-secret') headerSecret: string | undefined,
    @Body() body: unknown,
  ) {
    const secret = this.config.get('ZANROO_WEBHOOK_SECRET', { infer: true });
    if (!secret)
      throw new ServiceUnavailableException('ZANROO_WEBHOOK_SECRET is not set');
    const given = headerSecret ?? authorization?.replace(/^Bearer\s+/i, '');
    if (!given || !sameSecret(given, secret)) throw new UnauthorizedException();

    const project = await this.prisma.project.count({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const messages = extractMessages(body).slice(0, MAX_MESSAGES);
    // A message hidden in Zanroo was marked irrelevant there, so it leaves the dashboard too.
    const hidden = messages.filter((m) => m.hide && (m.mid || m.id));
    const visible = messages.filter((m) => !m.hide);

    return this.ingestion.ingestRecords({
      projectId,
      sourceType: 'API_WEBHOOK',
      label: 'Zanroo webhook',
      records: visible.map(zanrooMessageToRecord),
      removeIds: hidden.map((m) => (m.mid || m.id)!),
    });
  }
}
