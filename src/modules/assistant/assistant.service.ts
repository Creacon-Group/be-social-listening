import { Injectable, Logger } from '@nestjs/common';
import { type ModelMessage, stepCountIs, streamText } from 'ai';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import {
  FilterResolver,
  type MentionFilterDto,
  toWibYmd,
} from '../mentions/mention-filter.js';
import { MentionsService } from '../mentions/mentions.service.js';
import { type AssistantDataPort, buildTools } from './assistant-tools.js';
import { ChatRepository } from './chat.repository.js';
import { ModelProvider } from './model.provider.js';
import { buildSystemPrompt } from './system-prompt.js';

const HISTORY_LIMIT = 20;
const MAX_STEPS = 5;
const MAX_OUTPUT_TOKENS = 1500;

@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);
  private readonly data: AssistantDataPort;

  constructor(
    private readonly models: ModelProvider,
    private readonly chats: ChatRepository,
    private readonly filters: FilterResolver,
    private readonly prisma: PrismaService,
    analytics: AnalyticsService,
    mentions: MentionsService,
  ) {
    this.data = {
      overview: (projectId, f) => analytics.overview(projectId, f),
      competitors: (projectId, f, o) => analytics.competitors(projectId, f, o),
      sample: (projectId, f, o) => mentions.sample(projectId, f, o),
    };
  }

  async chat(p: {
    userId: number;
    projectId: number;
    sessionId: string;
    text: string;
    filter: MentionFilterDto;
    res: Response;
    signal: AbortSignal;
  }) {
    const model = this.models.get(); // 503 before anything is streamed when Gemini is not configured
    const session = await this.chats.findOwned(
      p.sessionId,
      p.userId,
      p.projectId,
    );
    const [history, brands, asOf] = await Promise.all([
      this.chats.recent(session.id, HISTORY_LIMIT),
      this.prisma.brand.findMany({
        where: { projectId: p.projectId },
        select: { id: true, name: true, isOwn: true },
      }),
      this.filters.dataAsOf(p.projectId),
    ]);

    await this.chats.add(session.id, {
      role: 'USER',
      content: p.text,
      filtersSnapshot: p.filter,
    });
    if (!session.title)
      await this.chats.setTitle(session.id, p.text.slice(0, 60));

    const result = streamText({
      model,
      system: buildSystemPrompt({
        brands,
        dataAsOf: asOf ? toWibYmd(asOf) : 'belum ada data',
        activeFilter: JSON.stringify(p.filter),
      }),
      messages: [
        ...history.map((m): ModelMessage => ({
          role: m.role === 'USER' ? 'user' : 'assistant',
          content: m.content,
        })),
        { role: 'user', content: p.text },
      ],
      tools: buildTools(
        { projectId: p.projectId, filter: p.filter, brands },
        this.data,
      ),
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      abortSignal: p.signal,
      onError: ({ error }) =>
        this.log.error(
          'LLM stream error',
          (error as Error)?.stack ?? String(error),
        ),
      onEnd: async (e) => {
        await this.chats.add(session.id, {
          role: 'ASSISTANT',
          content: e.text,
          toolCalls: e.steps.flatMap((s) =>
            s.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
          ),
          model: this.models.id,
          inputTokens: e.totalUsage.inputTokens,
          outputTokens: e.totalUsage.outputTokens,
        });
      },
    });

    await result.pipeUIMessageStreamToResponse(p.res, {
      onError: () =>
        'Maaf, AI Assistant sedang bermasalah. Coba lagi sebentar.',
    });
  }
}
