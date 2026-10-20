import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import type { Env } from '../../config/env.js';

/** How long to skip the primary model after Google reports it is overloaded. */
const COOLDOWN_MS = 2 * 60_000;

/** Google answers 503/429 ("high demand", "overloaded", "UNAVAILABLE") when a model is out of capacity. */
export function isCapacityError(error: unknown): boolean {
  const e = error as { statusCode?: number; message?: string } | undefined;
  if (e?.statusCode === 503 || e?.statusCode === 429) return true;
  return /high demand|overloaded|unavailable|resource.?exhausted|try again later/i.test(
    e?.message ?? String(error),
  );
}

/**
 * The only place that knows which LLM provider is used. Switching to another provider
 * (Anthropic, OpenAI, ...) means changing this file; AssistantService does not change.
 *
 * When GEMINI_FALLBACK_MODEL is set, a capacity error on the primary model switches calls to
 * the fallback for a few minutes, then the primary is tried again.
 */
@Injectable()
export class ModelProvider {
  private readonly log = new Logger(ModelProvider.name);
  private readonly apiKey?: string;
  private readonly primaryId?: string;
  private readonly fallbackId?: string;
  private primaryBlockedUntil = 0;

  constructor(config: ConfigService<Env, true>) {
    this.apiKey = config.get('GEMINI_API_KEY', { infer: true });
    this.primaryId = config.get('GEMINI_MODEL', { infer: true });
    this.fallbackId = config.get('GEMINI_FALLBACK_MODEL', { infer: true });
  }

  /** The model the next call will use. */
  get id() {
    if (!this.primaryId) return 'unset';
    return this.usingFallback() ? this.fallbackId! : this.primaryId;
  }

  /**
   * Gemini 3 "thinking" tokens count toward maxOutputTokens. Low thinking keeps answers fast
   * and leaves room for the text itself.
   */
  get providerOptions() {
    return { google: { thinkingConfig: { thinkingLevel: 'low' as const } } };
  }

  /** Call from streamText's onError: a capacity error mid-answer moves the retry to the fallback. */
  reportError(error: unknown) {
    if (!this.fallbackId || !isCapacityError(error) || this.usingFallback())
      return;
    this.primaryBlockedUntil = Date.now() + COOLDOWN_MS;
    this.log.warn(
      `${this.primaryId} is overloaded; using ${this.fallbackId} for ${COOLDOWN_MS / 60_000} min`,
    );
  }

  get(): LanguageModelV4 {
    if (!this.apiKey || !this.primaryId) {
      throw new ServiceUnavailableException(
        'AI Assistant belum dikonfigurasi (GEMINI_API_KEY / GEMINI_MODEL)',
      );
    }
    const primary = this.build(this.primaryId);
    const fallback = this.fallbackId ? this.build(this.fallbackId) : undefined;
    const pick = () => (fallback && this.usingFallback() ? fallback : primary);

    // Errors before the first chunk (the common case) fail over here; errors mid-stream fail over
    // through reportError + streamRetries in AssistantService.
    const call = async <T>(
      run: (m: LanguageModelV4) => PromiseLike<T>,
    ): Promise<T> => {
      const model = pick();
      try {
        return await run(model);
      } catch (error) {
        if (model === fallback || !fallback || !isCapacityError(error))
          throw error;
        this.reportError(error);
        return run(fallback);
      }
    };

    return {
      specificationVersion: 'v4',
      provider: primary.provider,
      modelId: this.primaryId,
      supportedUrls: primary.supportedUrls,
      doGenerate: (o: LanguageModelV4CallOptions) =>
        call((m) => m.doGenerate(o)),
      doStream: (o: LanguageModelV4CallOptions) => call((m) => m.doStream(o)),
    };
  }

  private build(id: string): LanguageModelV4 {
    return createGoogleGenerativeAI({ apiKey: this.apiKey })(id);
  }

  private usingFallback() {
    return !!this.fallbackId && Date.now() < this.primaryBlockedUntil;
  }
}
