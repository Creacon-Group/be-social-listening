import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { Env } from '../../config/env.js';

/**
 * The only place that knows which LLM provider is used. Switching to another provider
 * (Anthropic, OpenAI, ...) means changing this file; AssistantService does not change.
 */
@Injectable()
export class ModelProvider {
  private readonly apiKey?: string;
  private readonly modelId?: string;

  constructor(config: ConfigService<Env, true>) {
    this.apiKey = config.get('GEMINI_API_KEY', { infer: true });
    this.modelId = config.get('GEMINI_MODEL', { infer: true });
  }

  get id() {
    return this.modelId ?? 'unset';
  }

  get(): LanguageModel {
    if (!this.apiKey || !this.modelId) {
      throw new ServiceUnavailableException(
        'AI Assistant belum dikonfigurasi (GEMINI_API_KEY / GEMINI_MODEL)',
      );
    }
    return createGoogleGenerativeAI({ apiKey: this.apiKey })(this.modelId);
  }
}
