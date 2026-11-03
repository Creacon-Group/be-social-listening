import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

export type GeoModelKey = 'gemini' | 'gpt';
export type GeoModeName = 'KNOWLEDGE' | 'SEARCH';

/**
 * Capabilities verified against SumoPod on 2026-11-03 with real calls:
 * - Gemini: plain chat = no annotations; with `web_search_options: {}` it returns Google grounding
 *   as `message.annotations[].url_citation` ({ title: domain, url: Google redirect, start/end_index }).
 * - GPT: `annotations: []` even with `web_search_options`, so knowledge mode only.
 * - Both return `usage` (GPT also `completion_tokens_details.reasoning_tokens`).
 * Change these only after re-verifying; never assume a capability.
 */
const CAPABILITIES: Record<
  GeoModelKey,
  { search: boolean; citations: boolean; tokenUsage: boolean }
> = {
  gemini: { search: true, citations: true, tokenUsage: true },
  gpt: { search: false, citations: false, tokenUsage: true },
};

const LABEL: Record<GeoModelKey, string> = { gemini: 'Gemini', gpt: 'GPT' };

export interface GeoModelInfo {
  key: GeoModelKey;
  label: string;
  id: string;
  configured: boolean;
  modes: GeoModeName[];
  capabilities: (typeof CAPABILITIES)[GeoModelKey];
}

export interface Citation {
  domain: string;
  url: string;
  startIndex: number | null;
  endIndex: number | null;
}

export interface Completion {
  text: string;
  citations: Citation[];
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  requestId: string | null;
  latencyMs: number;
  raw: unknown;
}

/** Error with a category; `retryable` errors are retried with backoff, others fail the run at once. */
export class ProviderError extends Error {
  constructor(
    public readonly type:
      | 'timeout'
      | 'network'
      | 'rate_limit'
      | 'provider_error'
      | 'invalid_model'
      | 'auth'
      | 'bad_request'
      | 'malformed'
      | 'not_configured',
    message: string,
    public readonly retryable: boolean,
    public readonly raw?: unknown,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ChatResponse = {
  id?: string;
  choices?: {
    message?: {
      content?: string | null;
      annotations?: {
        type?: string;
        url_citation?: {
          title?: string;
          url?: string;
          start_index?: number;
          end_index?: number;
        };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string | number };
};

/** Domain from a citation title ("opensignal.com") or, failing that, the URL host. */
export function citationDomain(title?: string, url?: string): string {
  const t = (title ?? '').trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return t.replace(/^www\./, '');
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return t || 'unknown';
  }
}

/** Normalise a SumoPod chat completion. Throws `malformed` when there is no answer text. */
export function parseCompletion(
  d: ChatResponse,
  latencyMs: number,
): Completion {
  const message = d.choices?.[0]?.message;
  const text = message?.content ?? '';
  if (!text.trim())
    throw new ProviderError(
      'malformed',
      'The model returned no answer text (token limit reached or empty response)',
      true,
      d,
    );
  const citations = (message?.annotations ?? [])
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => ({
      domain: citationDomain(a.url_citation!.title, a.url_citation!.url),
      url: a.url_citation!.url!.slice(0, 1000),
      startIndex: a.url_citation!.start_index ?? null,
      endIndex: a.url_citation!.end_index ?? null,
    }));
  return {
    text,
    citations,
    promptTokens: d.usage?.prompt_tokens ?? null,
    completionTokens: d.usage?.completion_tokens ?? null,
    reasoningTokens:
      d.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    requestId: d.id ?? null,
    latencyMs,
    raw: d,
  };
}

/** HTTP status / provider error -> category. 429 and 5xx are worth retrying. */
export function classify(status: number, body: ChatResponse): ProviderError {
  const msg = (body.error?.message ?? `HTTP ${status}`).slice(0, 300);
  const type = body.error?.type ?? '';
  if (status === 429) return new ProviderError('rate_limit', msg, true, body);
  if (status >= 500)
    return new ProviderError('provider_error', msg, true, body);
  if (type === 'key_model_access_denied' || status === 404)
    return new ProviderError('invalid_model', msg, false, body);
  if (status === 401 || status === 403)
    return new ProviderError('auth', msg, false, body);
  return new ProviderError('bad_request', msg, false, body);
}

/** PORT for the GEO engine: one chat completion on a configured model. */
@Injectable()
export class SumoPodClient {
  private readonly log = new Logger(SumoPodClient.name);
  private readonly baseUrl: string;
  private readonly keys: Record<GeoModelKey, string | undefined>;
  private readonly ids: Record<GeoModelKey, string>;
  readonly maxTokens: number;
  private readonly timeoutMs: number;
  /** Backoff before retry 1 and 2. Tests set it to [0, 0]. */
  backoffMs = [2_000, 6_000];

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config
      .get('SUMOPOD_BASE_URL', { infer: true })
      .replace(/\/$/, '');
    this.keys = {
      gemini: config.get('SUMOPOD_GEMINI_API_KEY', { infer: true }),
      gpt: config.get('SUMOPOD_GPT_API_KEY', { infer: true }),
    };
    this.ids = {
      gemini: config.get('SUMOPOD_GEMINI_MODEL', { infer: true }),
      gpt: config.get('SUMOPOD_GPT_MODEL', { infer: true }),
    };
    this.maxTokens = config.get('GEO_MAX_TOKENS', { infer: true });
    this.timeoutMs = config.get('GEO_TIMEOUT_MS', { infer: true });
  }

  /** Models with their ids and capabilities. API keys are never part of this. */
  models(): GeoModelInfo[] {
    return (['gemini', 'gpt'] as const).map((key) => ({
      key,
      label: LABEL[key],
      id: this.ids[key],
      configured: !!this.keys[key],
      modes: CAPABILITIES[key].search ? ['KNOWLEDGE', 'SEARCH'] : ['KNOWLEDGE'],
      capabilities: CAPABILITIES[key],
    }));
  }

  keyOf(modelId: string): GeoModelKey | null {
    return (
      (['gemini', 'gpt'] as const).find((k) => this.ids[k] === modelId) ?? null
    );
  }

  idOf(key: GeoModelKey) {
    return this.ids[key];
  }

  /** One completion with retries on transient errors (timeout, network, 429, 5xx, empty answer). */
  async complete(
    key: GeoModelKey,
    messages: { role: 'system' | 'user'; content: string }[],
    opts: { mode?: GeoModeName; temperature?: number; maxTokens?: number } = {},
  ): Promise<Completion> {
    const apiKey = this.keys[key];
    if (!apiKey)
      throw new ProviderError(
        'not_configured',
        `${LABEL[key]} has no API key`,
        false,
      );
    if (opts.mode === 'SEARCH' && !CAPABILITIES[key].search)
      throw new ProviderError(
        'bad_request',
        `${LABEL[key]} does not support search mode`,
        false,
      );
    const body = {
      model: this.ids[key],
      messages,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      temperature: opts.temperature ?? 0.5,
      stream: false,
      ...(opts.mode === 'SEARCH' && { web_search_options: {} }),
    };

    let last: ProviderError | undefined;
    for (let attempt = 0; attempt <= this.backoffMs.length; attempt++) {
      if (attempt) await sleep(this.backoffMs[attempt - 1]);
      try {
        return await this.once(apiKey, body);
      } catch (e) {
        last =
          e instanceof ProviderError
            ? e
            : new ProviderError('network', String(e).slice(0, 200), true);
        this.log.warn(
          `SumoPod ${body.model} attempt ${attempt + 1} failed: ${last.type} ${last.message}`,
        ); // never logs the key or headers
        if (!last.retryable) break;
      }
    }
    throw last!;
  }

  private async once(apiKey: string, body: object): Promise<Completion> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw (e as Error).name === 'AbortError'
        ? new ProviderError(
            'timeout',
            `No answer within ${this.timeoutMs} ms`,
            true,
          )
        : new ProviderError(
            'network',
            (e as Error).message.slice(0, 200),
            true,
          );
    } finally {
      clearTimeout(timer);
    }
    let data: ChatResponse;
    try {
      data = (await res.json()) as ChatResponse;
    } catch {
      throw new ProviderError(
        res.ok
          ? 'malformed'
          : res.status >= 500
            ? 'provider_error'
            : 'bad_request',
        `Response is not JSON (HTTP ${res.status})`,
        res.ok || res.status >= 500,
      );
    }
    if (!res.ok || data.error) throw classify(res.ok ? 400 : res.status, data);
    return parseCompletion(data, Date.now() - started);
  }
}
