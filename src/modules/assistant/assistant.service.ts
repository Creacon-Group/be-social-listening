import { Injectable, Logger } from '@nestjs/common';
import { type ModelMessage, stepCountIs, streamText } from 'ai';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service.js';
import type { UserRole } from '../../generated/prisma/client.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import {
  FilterResolver,
  type MentionFilterDto,
  toWibYmd,
} from '../mentions/mention-filter.js';
import { MentionsService } from '../mentions/mentions.service.js';
import { type AssistantDataPort, buildTools } from './assistant-tools.js';
import { ChatCreditsService } from './chat-credits.service.js';
import { ChatRepository } from './chat.repository.js';
import { isCapacityError, ModelProvider } from './model.provider.js';
import { buildSystemPrompt } from './system-prompt.js';

const HISTORY_LIMIT = 20;
const MAX_STEPS = 5;
const MAX_OUTPUT_TOKENS = 8192; // includes the model's thinking tokens; 1500 cut answers mid-sentence

@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);
  private readonly data: AssistantDataPort;

  constructor(
    private readonly models: ModelProvider,
    private readonly chats: ChatRepository,
    private readonly credits: ChatCreditsService,
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
    role: UserRole;
    projectId: number;
    sessionId: string;
    text: string;
    filter: MentionFilterDto;
    res: Response;
    signal: AbortSignal;
  }) {
    const model = this.models.get(); // 503 before anything is streamed when the AI is not configured
    const session = await this.chats.findOwned(
      p.sessionId,
      p.userId,
      p.projectId,
    );
    // 429 when today's credits are used up. The credit is taken now, not after the answer, so
    // parallel requests or a client that hangs up before the end cannot get answers for free.
    const reserved = await this.credits.reserve(p.userId, p.role);
    let answered = false;
    let settled = !reserved;
    const settle = async () => {
      if (settled) return;
      settled = true;
      if (!answered)
        await this.credits
          .release(p.userId)
          .catch((e: Error) =>
            this.log.error('Could not give back a credit', e.message),
          );
    };
    try {
      await this.answer(p, model, session.id, session.title, {
        onText: () => (answered = true),
        settle,
      });
    } catch (e) {
      await settle();
      throw e;
    }
  }

  private async answer(
    p: Parameters<AssistantService['chat']>[0],
    model: ReturnType<ModelProvider['get']>,
    sessionId: string,
    title: string | null,
    credit: { onText: () => void; settle: () => Promise<void> },
  ) {
    const session = { id: sessionId, title };
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

    let started = Date.now();
    const result = streamText({
      model,
      system: buildSystemPrompt({
        brands,
        dataAsOf: asOf ? toWibYmd(asOf) : 'no data yet',
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
      providerOptions: this.models.providerOptions,
      abortSignal: p.signal,
      // Fail with a clear error instead of hanging when the model does not answer.
      timeout: { totalMs: 110_000, firstChunkMs: 45_000 },
      // Gemini sometimes drops an answer mid-stream ("high demand"). Rerun that step once; with
      // GEMINI_FALLBACK_MODEL set, the rerun goes to the fallback model (see onError).
      streamRetries: 1,
      onLanguageModelCallStart: () => {
        started = Date.now();
        this.log.log(`Model call → ${this.models.id}`);
      },
      onLanguageModelCallEnd: (e) =>
        this.log.log(
          `Model call ← ${e.finishReason} in ${Date.now() - started} ms`,
        ),
      // The gateway answers with the model that actually served the call (e.g. after a combo fallback).
      onStepEnd: (step) =>
        this.log.log(
          `Step ${step.stepNumber} answered by ${step.response.modelId} (${step.finishReason})`,
        ),
      onToolExecutionEnd: (e) =>
        this.log.log(`Tool ${e.toolCall.toolName} ${e.toolExecutionMs} ms`),
      // Any text that reached the user counts as an answer and keeps its credit.
      onChunk: ({ chunk }) => {
        if (chunk.type === 'text-delta' && chunk.text.trim()) credit.onText();
      },
      onAbort: () => credit.settle(),
      onError: ({ error }) => {
        this.log.error(
          'LLM stream error',
          (error as Error)?.message ?? String(error),
        );
        this.models.reportError(error);
      },
      onEnd: async (e) => {
        if (e.finishReason === 'length') {
          this.log.warn(
            `Answer cut off at the output token limit (${MAX_OUTPUT_TOKENS})`,
          );
        }
        if (e.text.trim()) credit.onText();
        await credit.settle(); // gives the credit back when there is no answer
        await this.chats.add(session.id, {
          role: 'ASSISTANT',
          content: e.text,
          toolCalls: e.steps.flatMap((s) =>
            s.toolCalls.map((c) => ({ name: c.toolName, input: c.input })),
          ),
          model: e.response.modelId || this.models.id, // actual model, not the combo name
          inputTokens: e.totalUsage.inputTokens,
          outputTokens: e.totalUsage.outputTokens,
        });
      },
    });

    // Also covers a stream that fails outright (onEnd/onAbort may not run then).
    void Promise.resolve(result.text)
      .catch(() => undefined)
      .finally(() => credit.settle());

    await result.pipeUIMessageStreamToResponse(p.res, {
      onError: (error) =>
        isCapacityError(error)
          ? 'The AI model is busy. Send the question again in a moment.'
          : 'The assistant could not answer. Try again in a moment.',
    });
  }
}
